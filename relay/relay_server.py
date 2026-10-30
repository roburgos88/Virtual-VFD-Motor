from __future__ import annotations

import asyncio
import json
import os
import secrets
import time
from dataclasses import dataclass, field

from aiohttp import WSMsgType, web

HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "9000"))
MAX_MESSAGE_BYTES = 256 * 1024

@dataclass
class Session:
    session_id: str
    producer_key: str
    viewer_key: str = ""
    producer: web.WebSocketResponse | None = None
    viewers: set[web.WebSocketResponse] = field(default_factory=set)
    last_snapshot: dict | None = None
    last_seen: float = field(default_factory=time.time)

sessions: dict[str, Session] = {}
lock = asyncio.Lock()

def safe_id(value: object) -> str:
    return "".join(ch for ch in str(value).strip() if ch.isalnum() or ch in "-_")[:64]

async def send_json(ws: web.WebSocketResponse, message: dict) -> None:
    await ws.send_str(json.dumps(message, separators=(",", ":")))

async def broadcast_status(session: Session) -> None:
    message = {
        "type": "SESSION_STATUS",
        "sessionId": session.session_id,
        "publisherOnline": session.producer is not None and not session.producer.closed,
        "viewers": len(session.viewers),
    }
    dead = []
    for viewer in list(session.viewers):
        try: await send_json(viewer, message)
        except Exception: dead.append(viewer)
    for viewer in dead: session.viewers.discard(viewer)

async def publish_snapshot(session: Session, payload: dict) -> None:
    session.last_snapshot = payload
    session.last_seen = time.time()
    message = {
        "type": "SNAPSHOT",
        "sessionId": session.session_id,
        "payload": payload,
        "serverTimeMs": int(time.time() * 1000),
        "viewers": len(session.viewers),
    }
    dead = []
    for viewer in list(session.viewers):
        try: await send_json(viewer, message)
        except Exception: dead.append(viewer)
    for viewer in dead: session.viewers.discard(viewer)

async def websocket_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=MAX_MESSAGE_BYTES, compress=False)
    await ws.prepare(request)
    role: str | None = None
    session: Session | None = None
    try:
        first = await asyncio.wait_for(ws.receive(), timeout=10)
        if first.type != WSMsgType.TEXT:
            await send_json(ws, {"type":"ERROR","message":"JSON handshake required"})
            return ws
        try: hello = json.loads(first.data)
        except json.JSONDecodeError:
            await send_json(ws, {"type":"ERROR","message":"invalid JSON handshake"})
            return ws

        if hello.get("type") == "REGISTER_PRODUCER":
            session_id = safe_id(hello.get("sessionId", ""))
            producer_key = str(hello.get("producerKey", ""))
            viewer_key = str(hello.get("viewerKey", ""))
            if not session_id or not producer_key:
                await send_json(ws,{"type":"ERROR","message":"sessionId and producerKey required"}); return ws
            async with lock:
                session = sessions.get(session_id)
                if session and not secrets.compare_digest(session.producer_key, producer_key):
                    await send_json(ws,{"type":"ERROR","message":"invalid producer key"}); return ws
                if session is None:
                    session = Session(session_id, producer_key, viewer_key); sessions[session_id] = session
                elif viewer_key:
                    session.viewer_key = viewer_key
                if session.producer and session.producer is not ws:
                    try: await session.producer.close(code=4001, message=b"producer replaced")
                    except Exception: pass
                session.producer = ws; session.last_seen = time.time()
            role = "producer"
            await send_json(ws,{"type":"REGISTERED","sessionId":session_id})
            await broadcast_status(session)

        elif hello.get("type") == "JOIN_VIEWER":
            session_id = safe_id(hello.get("sessionId", ""))
            viewer_key = str(hello.get("viewerKey", ""))
            async with lock: session = sessions.get(session_id)
            if session is None:
                await send_json(ws,{"type":"ERROR","message":"session not found"}); return ws
            if session.viewer_key and not secrets.compare_digest(session.viewer_key, viewer_key):
                await send_json(ws,{"type":"ERROR","message":"invalid viewer key"}); return ws
            session.viewers.add(ws); role = "viewer"
            await send_json(ws,{"type":"JOINED","sessionId":session_id,"publisherOnline":session.producer is not None and not session.producer.closed,"viewers":len(session.viewers)})
            if session.last_snapshot is not None:
                await send_json(ws,{"type":"SNAPSHOT","sessionId":session_id,"payload":session.last_snapshot,"serverTimeMs":int(time.time()*1000),"viewers":len(session.viewers)})
            await broadcast_status(session)
        else:
            await send_json(ws,{"type":"ERROR","message":"invalid handshake"}); return ws

        async for message in ws:
            if message.type == WSMsgType.TEXT:
                try: incoming = json.loads(message.data)
                except json.JSONDecodeError: continue
                if role == "producer":
                    if incoming.get("type") == "SNAPSHOT": await publish_snapshot(session, incoming.get("payload", {}))
                    elif incoming.get("type") == "PING": await send_json(ws,{"type":"PONG"})
                    else: await send_json(ws,{"type":"ERROR","message":"producer message not allowed"})
                elif role == "viewer":
                    if incoming.get("type") == "PING": await send_json(ws,{"type":"PONG"})
                    else: await send_json(ws,{"type":"ERROR","message":"remote monitor is read-only"})
            elif message.type in (WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.ERROR):
                break
    finally:
        if session is not None:
            if role == "producer" and session.producer is ws:
                session.producer = None; await broadcast_status(session)
            elif role == "viewer":
                session.viewers.discard(ws); await broadcast_status(session)
    return ws

async def health_handler(request: web.Request) -> web.Response:
    producers = sum(1 for s in sessions.values() if s.producer is not None and not s.producer.closed)
    viewers = sum(len(s.viewers) for s in sessions.values())
    return web.json_response({"service":"PF525 Remote Monitoring Relay","status":"ok","sessions":len(sessions),"publishers":producers,"viewers":viewers,"websocket":"/ws"})

async def root_handler(request: web.Request) -> web.Response:
    return web.json_response({"service":"PF525 Remote Monitoring Relay","status":"online","health":"/health","websocket":"/ws","viewerMode":"read-only"})

async def cleanup_task(app: web.Application) -> None:
    try:
        while True:
            await asyncio.sleep(60); cutoff=time.time()-3600
            async with lock:
                stale=[sid for sid,s in sessions.items() if s.producer is None and not s.viewers and s.last_seen<cutoff]
                for sid in stale: sessions.pop(sid,None)
    except asyncio.CancelledError:
        pass

async def start_background_tasks(app: web.Application) -> None:
    app["cleanup_task"] = asyncio.create_task(cleanup_task(app))

async def stop_background_tasks(app: web.Application) -> None:
    task=app.get("cleanup_task")
    if task:
        task.cancel(); await asyncio.gather(task, return_exceptions=True)

def create_app() -> web.Application:
    app=web.Application(client_max_size=MAX_MESSAGE_BYTES)
    app.router.add_get("/",root_handler)
    app.router.add_get("/health",health_handler)
    app.router.add_get("/ws",websocket_handler)
    app.on_startup.append(start_background_tasks)
    app.on_cleanup.append(stop_background_tasks)
    return app

if __name__ == "__main__":
    print(f"PF525 relay listening on {HOST}:{PORT}",flush=True)
    print("HTTP health: /health | WebSocket: /ws",flush=True)
    web.run_app(create_app(),host=HOST,port=PORT,print=None)
