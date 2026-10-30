from __future__ import annotations

import asyncio
import json
import os
import socket
import struct
import sys
import time
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import websockets

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"

HTTP_HOST = "127.0.0.1"
HTTP_PORT = 8080
WS_HOST = "127.0.0.1"
WS_PORT = 8765
ENIP_PORT = 44818

# Shared state between the EtherNet/IP worker threads and the asyncio bridge.
state_lock = threading.RLock()
class ServerVfdModel:
    """Server-authoritative PF525/motor process used by Local Commissioning.

    Virtual Simulation remains browser-local. In commissioning mode this model
    continues to advance even when no browser tab is visible or connected.
    """

    def __init__(self):
        self.state = {
            "status": "STOPPED",
            "referenceHz": 0.0,
            "outputHz": 0.0,
            "rpm": 0.0,
            "currentA": 0.0,
            "voltageV": 0.0,
            "torqueNm": 0.0,
            "loadPercent": 35.0,
            "dcBusV": 650.0,
            "faultCode": 0,
            "faultDescription": "None",
            "ready": True,
            "running": False,
            "direction": 1,
            "mccb": True,
            "km1": True,
            "powered": True,
            "accelerating": False,
            "decelerating": False,
            "atSpeed": False,
            "accelTimeS": 5.0,
            "decelTimeS": 5.0,
            "nominalVoltageV": 400.0,
            "nominalCurrentA": 13.0,
            "poles": 4,
        }

    def snapshot(self):
        with state_lock:
            return dict(self.state)

    def command(self, command: dict):
        with state_lock:
            s = self.state
            kind = command.get("type")

            if kind == "REFERENCE":
                s["referenceHz"] = max(0.0, min(60.0, float(command.get("value", 0.0))))

            elif kind == "DIRECTION":
                s["direction"] = 1 if float(command.get("value", 1)) >= 0 else -1

            elif kind == "START":
                if s["ready"] and not s["faultCode"]:
                    s["running"] = True
                    if command.get("direction") is not None:
                        s["direction"] = 1 if float(command["direction"]) >= 0 else -1
                    if command.get("referenceHz") is not None:
                        s["referenceHz"] = max(0.0, min(60.0, float(command["referenceHz"])))

            elif kind == "STOP":
                s["running"] = False

            elif kind == "RESET":
                s["faultCode"] = 0
                s["faultDescription"] = "None"
                s["running"] = False

            elif kind == "POWER":
                if "mccb" in command:
                    s["mccb"] = bool(command["mccb"])
                if "km1" in command:
                    s["km1"] = bool(command["km1"])

            elif kind == "LOAD":
                s["loadPercent"] = max(0.0, min(150.0, float(command.get("value", 0.0))))

    def update(self, dt: float):
        with state_lock:
            s = self.state
            dt = max(0.0, min(0.1, float(dt)))

            s["powered"] = bool(s["mccb"] and s["km1"])
            s["ready"] = bool(s["powered"] and not s["faultCode"])
            if not s["ready"]:
                s["running"] = False

            bus_target = 650.0 if s["powered"] else 0.0
            if s["faultDescription"] == "DC bus undervoltage":
                bus_target = 320.0
            elif s["faultDescription"] == "DC bus overvoltage":
                bus_target = 820.0
            s["dcBusV"] += (bus_target - s["dcBusV"]) * min(1.0, dt * (3.0 if s["powered"] else 1.0))

            target_hz = s["referenceHz"] if s["running"] and s["ready"] else 0.0
            error = target_hz - s["outputHz"]
            rising = error > 0
            ramp = s["accelTimeS"] if rising else s["decelTimeS"]
            max_step = (60.0 / max(0.1, ramp)) * dt
            if abs(error) <= max_step:
                s["outputHz"] = target_hz
            else:
                s["outputHz"] += max_step if error > 0 else -max_step
            s["outputHz"] = max(0.0, s["outputHz"])

            load = s["loadPercent"] / 100.0
            sync_rpm = 120.0 * s["outputHz"] / max(1, int(s["poles"]))
            slip = min(0.09, 0.007 + 0.04 * load)
            if s["faultDescription"] == "Motor stall":
                slip = 0.98
            s["rpm"] = s["direction"] * sync_rpm * (1.0 - slip)

            s["voltageV"] = (
                min(s["nominalVoltageV"], s["nominalVoltageV"] * s["outputHz"] / 50.0)
                if s["powered"] else 0.0
            )
            accel_demand = min(0.45, abs(error) / 25.0)
            s["currentA"] = (
                s["nominalCurrentA"] * (0.18 + 0.72 * load + accel_demand)
                if s["outputHz"] > 0.05 else 0.0
            )
            if s["faultDescription"] == "Motor overload":
                s["currentA"] *= 1.55
            if s["faultDescription"] == "Motor stall":
                s["currentA"] *= 2.4

            rated_speed_rad = max(1.0, (120.0 * 50.0 / s["poles"]) * 2.0 * 3.141592653589793 / 60.0)
            rated_torque = 5500.0 / rated_speed_rad
            s["torqueNm"] = rated_torque * load if s["outputHz"] > 0.05 else 0.0

            at_speed = bool(s["running"] and abs(s["referenceHz"] - s["outputHz"]) < 0.05)
            s["atSpeed"] = at_speed
            s["accelerating"] = bool(s["running"] and error > 0.05)
            s["decelerating"] = bool((not s["running"]) and s["outputHz"] > 0.05)

            if s["faultCode"]:
                s["status"] = "FAULTED"
            elif not s["powered"]:
                s["status"] = "POWER OFF"
            elif at_speed:
                s["status"] = "RUNNING"
            elif s["running"]:
                s["status"] = "ACCELERATING"
            elif s["outputHz"] > 0.05:
                s["status"] = "DECELERATING"
            else:
                s["status"] = "STOPPED"

            return dict(s)


server_vfd = ServerVfdModel()

registers = {
    20: 0,   # Logic Command
    22: 0,   # Reference, 0.01 Hz
}
ws_clients = set()
event_loop: asyncio.AbstractEventLoop | None = None
relay_publisher = None


def log(message: str) -> None:
    print(f"[PF525] {message}", flush=True)


class FrontendHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(FRONTEND), **kwargs)

    def log_message(self, fmt, *args):
        log("HTTP " + (fmt % args))


def serve_frontend() -> None:
    server = ThreadingHTTPServer((HTTP_HOST, HTTP_PORT), FrontendHandler)
    log(f"Frontend: http://{HTTP_HOST}:{HTTP_PORT}")
    server.serve_forever()


def build_logic_status() -> int:
    """PF525 velocity-mode Logic Status subset from authoritative server state."""
    fb = server_vfd.snapshot()
    word = 0
    if fb.get("ready", False): word |= 1 << 0
    if fb.get("running", False): word |= 1 << 1
    if int(fb.get("direction", 1)) >= 0:
        word |= 1 << 2
        word |= 1 << 3
    if fb.get("accelerating", False): word |= 1 << 4
    if fb.get("decelerating", False): word |= 1 << 5
    if int(fb.get("faultCode", 0)) != 0: word |= 1 << 7
    if fb.get("atSpeed", False): word |= 1 << 8
    return word & 0xFFFF


def feedback_word() -> int:
    hz = float(server_vfd.snapshot().get("outputHz", 0.0))
    return max(0, min(65535, round(hz * 100.0)))


def decode_logic_command(word: int) -> dict:
    """
    PF525 velocity-mode Logic Command subset:
      bit 0    Normal Stop
      bit 1    Start
      bit 3    Clear Fault
      bits 5:4 direction:
                01 Forward
                10 Reverse
                00/11 No direction command
    """
    stop = bool(word & (1 << 0))
    start = bool(word & (1 << 1))
    clear_fault = bool(word & (1 << 3))
    direction_bits = (word >> 4) & 0b11
    direction = None
    if direction_bits == 0b01:
        direction = 1
    elif direction_bits == 0b10:
        direction = -1

    return {
        "stop": stop,
        "start": start,
        "clearFault": clear_fault,
        "direction": direction,
    }


def schedule_ws_message(message: dict) -> None:
    loop = event_loop
    if loop is None or not loop.is_running():
        return

    async def _send():
        dead = []
        encoded = json.dumps(message)
        for ws in list(ws_clients):
            try:
                await ws.send(encoded)
            except Exception:
                dead.append(ws)
        for ws in dead:
            ws_clients.discard(ws)

    asyncio.run_coroutine_threadsafe(_send(), loop)


def publish_registers() -> None:
    with state_lock:
        logic_command = int(registers[20]) & 0xFFFF
        reference = int(registers[22]) & 0xFFFF
    schedule_ws_message({
        "type": "REGISTER_SNAPSHOT",
        "registers": {
            "logicCommand": logic_command,
            "logicStatus": build_logic_status(),
            "reference": reference,
            "feedback": feedback_word(),
        }
    })


def apply_logic_command(word: int) -> None:
    cmd = decode_logic_command(word)
    with state_lock:
        ref_word = int(registers[22])
    reference_hz = ref_word / 100.0

    if cmd["clearFault"]:
        server_vfd.command({"type": "RESET"})
        schedule_ws_message({"type": "PLC_EVENT", "summary": f"Logic Command 0x{word:04X}: Clear Fault"})

    if cmd["stop"]:
        server_vfd.command({"type": "STOP"})
        schedule_ws_message({"type": "PLC_EVENT", "summary": f"Logic Command 0x{word:04X}: STOP"})
        return

    if cmd["start"]:
        direction = cmd["direction"] if cmd["direction"] is not None else 1
        server_vfd.command({"type": "START", "direction": direction, "referenceHz": reference_hz})
        schedule_ws_message({
            "type": "PLC_EVENT",
            "summary": f"Logic Command 0x{word:04X}: START {'REV' if direction < 0 else 'FWD'} @ {reference_hz:.2f} Hz"
        })
    elif cmd["direction"] is not None:
        server_vfd.command({"type": "DIRECTION", "value": cmd["direction"]})
        schedule_ws_message({"type": "PLC_EVENT", "summary": f"Direction = {'REV' if cmd['direction'] < 0 else 'FWD'}"})


def apply_reference(word: int) -> None:
    hz = word / 100.0
    server_vfd.command({"type": "REFERENCE", "value": hz})
    schedule_ws_message({"type": "PLC_EVENT", "summary": f"Reference = {word} ({hz:.2f} Hz)"})


class RelayPublisher:
    def __init__(self, url: str, session_id: str, producer_key: str, viewer_key: str = ""):
        self.url = url
        self.session_id = session_id
        self.producer_key = producer_key
        self.viewer_key = viewer_key
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=2)
        self.connected = False

    async def publish(self, payload: dict):
        message = {"type": "SNAPSHOT", "payload": payload}
        if self.queue.full():
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        await self.queue.put(message)

    async def run(self):
        while True:
            try:
                log(f"Relay connecting: {self.url} / session {self.session_id}")
                async with websockets.connect(self.url, ping_interval=20, ping_timeout=20) as ws:
                    await ws.send(json.dumps({
                        "type": "REGISTER_PRODUCER",
                        "sessionId": self.session_id,
                        "producerKey": self.producer_key,
                        "viewerKey": self.viewer_key,
                    }))
                    response = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
                    if response.get("type") != "REGISTERED":
                        raise RuntimeError(response.get("message", "relay registration rejected"))
                    self.connected = True
                    log(f"Relay session online: {self.session_id}")
                    while True:
                        message = await self.queue.get()
                        await ws.send(json.dumps(message))
            except Exception as exc:
                log(f"Relay {'disconnected' if self.connected else 'unavailable'}: {exc}")
                self.connected = False
                await asyncio.sleep(3)


def remote_snapshot():
    with state_lock:
        logic_command = int(registers[20]) & 0xFFFF
        reference = int(registers[22]) & 0xFFFF
    drive = server_vfd.snapshot()
    return {
        "drive": drive,
        "network": {
            "logicCommand": logic_command,
            "logicStatus": build_logic_status(),
            "reference": reference,
            "feedback": feedback_word(),
        },
    }


async def broadcast_local(message: dict):
    encoded = json.dumps(message)
    dead = []
    for ws in list(ws_clients):
        try:
            await ws.send(encoded)
        except Exception:
            dead.append(ws)
    for ws in dead:
        ws_clients.discard(ws)


async def simulation_loop():
    """Advance server-authoritative commissioning model independent of browser rendering."""
    last = time.perf_counter()
    publish_accumulator = 0.0
    while True:
        await asyncio.sleep(0.02)  # 50 Hz model tick
        now = time.perf_counter()
        dt = min(0.1, now - last)
        last = now
        server_vfd.update(dt)
        publish_accumulator += dt
        if publish_accumulator >= 0.05:  # 20 Hz telemetry
            publish_accumulator = 0.0
            snapshot = remote_snapshot()
            await broadcast_local({"type": "AUTHORITATIVE_SNAPSHOT", "payload": snapshot})
            if relay_publisher is not None:
                await relay_publisher.publish(snapshot)


async def websocket_handler(websocket):
    ws_clients.add(websocket)
    log("Web UI connected")
    try:
        await websocket.send(json.dumps({
            "type": "BRIDGE_STATUS",
            "status": "READY",
            "enipPort": ENIP_PORT,
            "authoritativeCore": "PYTHON_BACKEND",
        }))
        await websocket.send(json.dumps({"type": "AUTHORITATIVE_SNAPSHOT", "payload": remote_snapshot()}))
        publish_registers()

        async for raw in websocket:
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                continue

            if message.get("type") == "HELLO":
                await websocket.send(json.dumps({"type": "AUTHORITATIVE_SNAPSHOT", "payload": remote_snapshot()}))
                publish_registers()
            elif message.get("type") == "VFD_FEEDBACK":
                # v0.4 compatibility: browser feedback is no longer authoritative.
                pass

    finally:
        ws_clients.discard(websocket)
        log("Web UI disconnected")


class EtherNetIPServer:
    """
    Minimal explicit-message EtherNet/IP target.

    Implemented:
      Encapsulation:
        ListServices        0x0004
        ListIdentity        0x0063
        RegisterSession     0x0065
        UnregisterSession   0x0066
        SendRRData          0x006F

      CIP:
        Identity Object     Class 0x01, Instance 1
        Register Object     Class 0x07
            Instance 19 Logic Status  (read-only)
            Instance 20 Logic Command (read/write)
            Instance 21 Feedback      (read-only)
            Instance 22 Reference     (read/write)

        Register Object data is Attribute 4.
    """

    def __init__(self, bind_ip: str):
        self.bind_ip = bind_ip
        self.stop_event = threading.Event()
        self.product_name = "PowerFlex 525 Digital Twin"
        self.serial = 525001

        # Experimental identity. Not a Rockwell-certified product identity.
        self.vendor_id = 0xFFFF
        self.device_type = 0x0002
        self.product_code = 0x0525
        self.major = 0
        self.minor = 3

        self._session = 0x1000
        self._session_lock = threading.Lock()

    def next_session(self) -> int:
        with self._session_lock:
            self._session = (self._session + 1) & 0xFFFFFFFF
            if self._session == 0:
                self._session = 1
            return self._session

    @staticmethod
    def header(command, payload, session=0, status=0,
               context=b"\0" * 8, options=0):
        return struct.pack(
            "<HHII8sI",
            command, len(payload), session, status,
            context[:8].ljust(8, b"\0"), options
        ) + payload

    def identity_payload(self):
        sockaddr = (
            struct.pack(">H", socket.AF_INET)
            + struct.pack(">H", ENIP_PORT)
            + socket.inet_aton(self.bind_ip)
            + b"\0" * 8
        )
        name = self.product_name.encode("ascii", "replace")[:32]
        item = (
            struct.pack("<H", 1)
            + sockaddr
            + struct.pack("<HHH", self.vendor_id, self.device_type, self.product_code)
            + struct.pack("<BBH", self.major, self.minor, 0)
            + struct.pack("<I", self.serial)
            + bytes([len(name)]) + name + b"\0"
        )
        return struct.pack("<H", 1) + struct.pack("<HH", 0x000C, len(item)) + item

    @staticmethod
    def services_payload():
        name = b"Communications".ljust(16, b"\0")
        item = struct.pack("<HHHH16s", 0x0100, 20, 1, 0x0120, name)
        return struct.pack("<H", 1) + item

    def start(self):
        threading.Thread(target=self.udp_loop, daemon=True).start()
        threading.Thread(target=self.tcp_loop, daemon=True).start()

    def udp_loop(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.bind(("", ENIP_PORT))
        sock.settimeout(0.5)
        log(f"EtherNet/IP UDP discovery listening on :{ENIP_PORT}")

        while not self.stop_event.is_set():
            try:
                data, remote = sock.recvfrom(4096)
            except socket.timeout:
                continue
            except OSError:
                break

            if len(data) < 24:
                continue

            command, _, _, _, context, options = struct.unpack("<HHII8sI", data[:24])

            if command == 0x0063:
                sock.sendto(
                    self.header(
                        0x0063, self.identity_payload(),
                        context=context, options=options
                    ),
                    remote
                )
                log(f"ListIdentity -> {remote[0]}:{remote[1]}")

            elif command == 0x0004:
                sock.sendto(
                    self.header(
                        0x0004, self.services_payload(),
                        context=context, options=options
                    ),
                    remote
                )

    def tcp_loop(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((self.bind_ip, ENIP_PORT))
        sock.listen(8)
        sock.settimeout(0.5)
        log(f"EtherNet/IP TCP listening on {self.bind_ip}:{ENIP_PORT}")

        while not self.stop_event.is_set():
            try:
                client, remote = sock.accept()
            except socket.timeout:
                continue
            except OSError:
                break

            threading.Thread(
                target=self.client_loop,
                args=(client, remote),
                daemon=True
            ).start()

    @staticmethod
    def recv_exact(sock, length):
        data = b""
        while len(data) < length:
            try:
                chunk = sock.recv(length - len(data))
            except OSError:
                return None
            if not chunk:
                return None
            data += chunk
        return data

    def client_loop(self, client, remote):
        log(f"TCP connection <- {remote[0]}:{remote[1]}")
        try:
            while True:
                hdr = self.recv_exact(client, 24)
                if hdr is None:
                    break

                command, length, session, _, context, options = struct.unpack(
                    "<HHII8sI", hdr
                )
                payload = self.recv_exact(client, length) if length else b""
                if payload is None:
                    break

                response = self.handle_encapsulation(
                    command, session, context, options, payload, remote[0]
                )

                if response is not None:
                    client.sendall(response)

                if command == 0x0066:
                    break
        finally:
            try:
                client.close()
            except OSError:
                pass

    def handle_encapsulation(self, command, session, context, options, payload, remote_ip):
        if command == 0x0065:
            new_session = self.next_session()
            log(f"RegisterSession <- {remote_ip}; session=0x{new_session:08X}")
            return self.header(
                command,
                struct.pack("<HH", 1, 0),
                session=new_session,
                context=context,
                options=options
            )

        if command == 0x0066:
            log(f"UnregisterSession <- {remote_ip}")
            return None

        if command == 0x0063:
            return self.header(command, self.identity_payload(), context=context)

        if command == 0x0004:
            return self.header(command, self.services_payload(), context=context)

        if command == 0x006F:
            rr = self.handle_rr_data(payload, remote_ip)
            return self.header(
                command, rr,
                session=session, context=context, options=options
            )

        log(f"Unsupported encapsulation command 0x{command:04X}")
        return self.header(command, b"", session=session, status=1, context=context)

    def handle_rr_data(self, payload, remote_ip):
        if len(payload) < 8:
            return payload

        interface_handle, timeout, item_count = struct.unpack("<IHH", payload[:8])
        offset = 8
        cip_request = b""

        for _ in range(item_count):
            if offset + 4 > len(payload):
                break
            item_type, item_length = struct.unpack("<HH", payload[offset:offset+4])
            offset += 4
            item = payload[offset:offset+item_length]
            offset += item_length
            if item_type in (0x00B1, 0x00B2):
                cip_request = item

        cip_response = self.handle_cip(cip_request, remote_ip)

        return (
            struct.pack("<IHH", interface_handle, timeout, 2)
            + struct.pack("<HH", 0x0000, 0)
            + struct.pack("<HH", 0x00B2, len(cip_response))
            + cip_response
        )

    @staticmethod
    def parse_epath(path):
        cls = instance = attribute = None
        i = 0
        while i < len(path):
            seg = path[i]
            i += 1
            if seg == 0x20 and i < len(path):
                cls = path[i]
                i += 1
            elif seg == 0x21 and i + 2 <= len(path):
                cls = struct.unpack("<H", path[i:i+2])[0]
                i += 2
            elif seg == 0x24 and i < len(path):
                instance = path[i]
                i += 1
            elif seg == 0x25 and i + 2 <= len(path):
                instance = struct.unpack("<H", path[i:i+2])[0]
                i += 2
            elif seg == 0x30 and i < len(path):
                attribute = path[i]
                i += 1
            elif seg == 0x31 and i + 2 <= len(path):
                attribute = struct.unpack("<H", path[i:i+2])[0]
                i += 2
            else:
                break
        return cls, instance, attribute

    @staticmethod
    def cip_ok(service, data=b""):
        return bytes([service | 0x80, 0x00, 0x00, 0x00]) + data

    @staticmethod
    def cip_error(service, general_status):
        return bytes([service | 0x80, 0x00, general_status, 0x00])

    def identity_attribute(self, attribute):
        values = {
            1: struct.pack("<H", self.vendor_id),
            2: struct.pack("<H", self.device_type),
            3: struct.pack("<H", self.product_code),
            4: struct.pack("<BB", self.major, self.minor),
            5: struct.pack("<H", 0),
            6: struct.pack("<I", self.serial),
        }
        if attribute == 7:
            name = self.product_name.encode("ascii", "replace")[:32]
            return bytes([len(name)]) + name
        return values.get(attribute)

    def register_value(self, instance):
        if instance == 19:
            return build_logic_status()
        if instance == 20:
            with state_lock:
                return int(registers[20]) & 0xFFFF
        if instance == 21:
            return feedback_word()
        if instance == 22:
            with state_lock:
                return int(registers[22]) & 0xFFFF
        return None

    def register_attribute(self, instance, attribute):
        if instance not in (19, 20, 21, 22):
            return None

        if attribute == 1:  # Bad Flag
            return b"\x00"
        if attribute == 2:  # Direction
            # 0 product register drive->network; 1 consume network->drive
            return bytes([1 if instance in (20, 22) else 0])
        if attribute == 3:  # Size, bits
            return struct.pack("<H", 16)
        if attribute == 4:  # Data
            value = self.register_value(instance)
            return struct.pack("<H", value)
        return None

    def write_register(self, instance, value):
        value &= 0xFFFF
        if instance not in (20, 22):
            return False

        with state_lock:
            registers[instance] = value

        if instance == 20:
            log(f"Register 20 Logic Command <- 0x{value:04X}")
            apply_logic_command(value)
        elif instance == 22:
            log(f"Register 22 Reference <- {value} ({value/100:.2f} Hz)")
            apply_reference(value)

        publish_registers()
        return True

    def handle_cip(self, request, remote_ip):
        if len(request) < 2:
            return self.cip_error(0, 0x13)

        service = request[0]
        path_bytes = request[1] * 2
        if len(request) < 2 + path_bytes:
            return self.cip_error(service, 0x04)

        path = request[2:2+path_bytes]
        data = request[2+path_bytes:]
        cls, instance, attribute = self.parse_epath(path)

        log(
            f"CIP <- {remote_ip}: service=0x{service:02X}, "
            f"class=0x{(cls or 0):02X}, instance={instance}, attribute={attribute}"
        )

        # Identity Object
        if cls == 0x01 and instance == 1:
            if service == 0x0E:
                value = self.identity_attribute(attribute)
                if value is None:
                    return self.cip_error(service, 0x14)
                return self.cip_ok(service, value)
            return self.cip_error(service, 0x08)

        # Register Object
        if cls == 0x07:
            if instance not in (19, 20, 21, 22):
                return self.cip_error(service, 0x05)

            if service == 0x0E:  # Get Attribute Single
                value = self.register_attribute(instance, attribute)
                if value is None:
                    return self.cip_error(service, 0x14)
                return self.cip_ok(service, value)

            if service == 0x10:  # Set Attribute Single
                if attribute != 4:
                    return self.cip_error(service, 0x14)
                if instance not in (20, 22):
                    return self.cip_error(service, 0x0E)  # attribute not settable
                if len(data) < 2:
                    return self.cip_error(service, 0x13)
                value = struct.unpack("<H", data[:2])[0]
                self.write_register(instance, value)
                return self.cip_ok(service)

            return self.cip_error(service, 0x08)

        return self.cip_error(service, 0x05)


def choose_bind_ip():
    if len(sys.argv) > 1:
        return sys.argv[1]

    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("8.8.8.8", 80))
        return probe.getsockname()[0]
    except OSError:
        return "0.0.0.0"
    finally:
        probe.close()


async def main():
    global event_loop, relay_publisher
    event_loop = asyncio.get_running_loop()

    bind_ip = choose_bind_ip()
    log(f"Using EtherNet/IP interface: {bind_ip}")

    relay_url = os.getenv("PF525_RELAY_URL", "").strip()
    session_id = os.getenv("PF525_SESSION_ID", "").strip()
    producer_key = os.getenv("PF525_PRODUCER_KEY", "").strip()
    viewer_key = os.getenv("PF525_VIEWER_KEY", "").strip()

    if relay_url and session_id and producer_key:
        relay_publisher = RelayPublisher(relay_url, session_id, producer_key, viewer_key)
        asyncio.create_task(relay_publisher.run())
    else:
        log("Remote publishing disabled")

    asyncio.create_task(simulation_loop())
    log("Authoritative simulation core: Python backend @ 50 Hz; telemetry @ 20 Hz")

    threading.Thread(target=serve_frontend, daemon=True).start()

    enip = EtherNetIPServer(bind_ip)
    enip.start()

    async with websockets.serve(websocket_handler, WS_HOST, WS_PORT):
        log(f"WebSocket bridge: ws://{WS_HOST}:{WS_PORT}")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
