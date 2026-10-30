import { EventBus } from "../core/eventBus.js";
import { VfdCore } from "../core/vfdCore.js";
import { VirtualPlcAdapter } from "../adapters/virtualPlcAdapter.js";
import { PhysicalPlcAdapter } from "../adapters/physicalPlcAdapter.js";
import { RemoteMonitorAdapter } from "../adapters/remoteMonitorAdapter.js";

const $ = (id) => document.getElementById(id);

const events = new EventBus();
const vfd = new VfdCore(events);
const virtualPlc = new VirtualPlcAdapter(vfd, events);
const physicalPlc = new PhysicalPlcAdapter(vfd, events);
const remoteMonitor = new RemoteMonitorAdapter(events);

let activeAdapter = virtualPlc;
let currentMode = "virtual";
let lastFrame = performance.now();
let publishAccumulator = 0;
let waveformPhase = 0;

function setMode(mode) {
  virtualPlc.deactivate();
  physicalPlc.deactivate();
  remoteMonitor.deactivate();

  currentMode = mode;
  const physical = mode === "physical";
  const remote = mode === "remote";

  if (remote) {
    activeAdapter = remoteMonitor;
    remoteMonitor.activate();
  } else if (physical) {
    activeAdapter = physicalPlc;
    physicalPlc.activate();
  } else {
    activeAdapter = virtualPlc;
    virtualPlc.activate();
  }

  $("physicalCfg").classList.toggle("hidden", !physical);
  $("remoteCfg").classList.toggle("hidden", !remote);
  $("readOnlyBanner").classList.toggle("hidden", !remote);

  document.body.classList.toggle("physicalMode", physical);
  document.body.classList.toggle("readonlyMode", remote);

  $("modeBadge").textContent = remote
    ? "REMOTE MONITOR"
    : physical
      ? "LOCAL COMMISSIONING"
      : "VIRTUAL";

  $("owner").textContent = `OWNER: ${
    remote ? "REMOTE SESSION" : physical ? "PHYSICAL PLC" : "VIRTUAL PLC"
  }`;

  $("plcTitle").textContent = remote
    ? "Remote PLC / Session"
    : physical
      ? "Physical PLC / Bridge"
      : "Virtual PLC";

  $("bridgeBadge").textContent = remote
    ? "Remote session"
    : physical
      ? "Local runtime"
      : "Browser simulation";

  if (physical) {
    events.emit(
      "SYSTEM",
      "Local Commissioning selected — control belongs to the external PLC."
    );
  }

  if (remote) {
    events.emit(
      "SYSTEM",
      "Remote Monitor selected — read-only command path enforced."
    );
  }
}

function setBit(id, value) {
  $(id).textContent = value ? "1" : "0";
}

function hex16(value) {
  return `0x${(Number(value) & 0xffff)
    .toString(16)
    .toUpperCase()
    .padStart(4, "0")}`;
}

function drawVf(state) {
  const canvas = $("vfCanvas");
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const p = 34;

  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "#2c3a49";
  ctx.lineWidth = 1;

  for (let i = 0; i <= 6; i++) {
    const x = p + ((w - 2 * p) * i) / 6;
    ctx.beginPath();
    ctx.moveTo(x, p);
    ctx.lineTo(x, h - p);
    ctx.stroke();
  }

  for (let i = 0; i <= 4; i++) {
    const y = h - p - ((h - 2 * p) * i) / 4;
    ctx.beginPath();
    ctx.moveTo(p, y);
    ctx.lineTo(w - p, y);
    ctx.stroke();
  }

  ctx.strokeStyle = "#45d483";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(p, h - p);
  ctx.lineTo(p + ((w - 2 * p) * 50) / 60, p);
  ctx.lineTo(w - p, p);
  ctx.stroke();

  const hz = Number(state.outputHz || 0);
  const voltage = Number(state.voltageV || 0);
  const opX = p + ((w - 2 * p) * hz) / 60;
  const opY = h - p - ((h - 2 * p) * Math.min(400, voltage)) / 400;

  ctx.fillStyle = "#2aa9ff";
  ctx.beginPath();
  ctx.arc(opX, opY, 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#91a0ad";
  ctx.font = "12px Segoe UI";
  ctx.fillText("0 Hz", p - 8, h - 10);
  ctx.fillText("60 Hz", w - p - 18, h - 10);
  ctx.fillText("400 V", 4, p + 4);
}

function drawWaveforms(state, dt) {
  const canvas = $("waveCanvas");
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "#2c3a49";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  waveformPhase += dt * Number(state.outputHz || 0) * Math.PI * 2;
  const amplitude = (h * 0.36 * Number(state.voltageV || 0)) / 400;
  const colors = ["#45d483", "#2aa9ff", "#f2b84b"];
  const offsets = [0, (-2 * Math.PI) / 3, (-4 * Math.PI) / 3];

  offsets.forEach((offset, index) => {
    ctx.strokeStyle = colors[index];
    ctx.lineWidth = 2;
    ctx.beginPath();

    for (let px = 0; px < w; px++) {
      const t = (px / w) * 4 * Math.PI;
      const y = h / 2 - Math.sin(t + waveformPhase + offset) * amplitude;
      if (px === 0) ctx.moveTo(px, y);
      else ctx.lineTo(px, y);
    }

    ctx.stroke();
  });
}

function applyRemoteState(snapshot) {
  if (!snapshot) return vfd.state;

  const keys = [
    "status",
    "referenceHz",
    "outputHz",
    "rpm",
    "currentA",
    "voltageV",
    "torqueNm",
    "loadPercent",
    "dcBusV",
    "faultCode",
    "faultDescription",
    "ready",
    "running",
    "direction",
    "mccb",
    "km1",
    "powered",
  ];

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(snapshot, key)) {
      vfd.state[key] = snapshot[key];
    }
  }

  return vfd.state;
}

function applyPhysicalState(snapshot) {
  if (!snapshot) return vfd.state;
  return applyRemoteState(snapshot);
}

function renderRegisters(state) {
  let command = 0;
  let status = vfd.logicStatusWord();
  let reference = vfd.referenceWord();
  let feedback = vfd.feedbackWord();

  if (currentMode === "physical") {
    const r = physicalPlc.networkRegisters || {};
    command = Number(r.logicCommand || 0);
    status = Number(r.logicStatus ?? status);
    reference = Number(r.reference ?? reference);
    feedback = Number(r.feedback ?? feedback);
  } else if (currentMode === "remote") {
    const r = remoteMonitor.networkRegisters || {};
    command = Number(r.logicCommand || 0);
    status = Number(r.logicStatus ?? status);
    reference = Number(r.reference ?? reference);
    feedback = Number(r.feedback ?? feedback);
  } else {
    const io = virtualPlc.snapshot();
    if (io.stop) command |= 1 << 0;
    if (io.run) command |= 1 << 1;
    if (io.reverse) command |= 1 << 5;
    else if (io.run) command |= 1 << 4;
  }

  $("regCommandHex").textContent = hex16(command);
  $("regCommandDec").textContent = String(command);
  $("regStatusHex").textContent = hex16(status);
  $("regStatusDec").textContent = String(status);
  $("regReferenceHex").textContent = hex16(reference);
  $("regReferenceDec").textContent = String(reference);
  $("regReferenceHz").textContent = (reference / 100).toFixed(2);
  $("regFeedbackHex").textContent = hex16(feedback);
  $("regFeedbackDec").textContent = String(feedback);
  $("regFeedbackHz").textContent = (feedback / 100).toFixed(2);
}

function render(state) {
  const outputHz = Number(state.outputHz || 0);
  const rpm = Number(state.rpm || 0);
  const currentA = Number(state.currentA || 0);
  const voltageV = Number(state.voltageV || 0);
  const torqueNm = Number(state.torqueNm || 0);
  const loadPercent = Number(state.loadPercent || 0);
  const dcBusV = Number(state.dcBusV || 0);
  const referenceHz = Number(state.referenceHz || 0);

  $("driveState").textContent = state.status || "WAITING";
  $("freqDisplay").textContent = outputHz.toFixed(2);
  $("busV").textContent = `${dcBusV.toFixed(0)} V`;
  $("miniRpm").textContent = `${Math.abs(rpm).toFixed(0)} RPM`;

  $("mf").textContent = `${outputHz.toFixed(2)} Hz`;
  $("rpm").textContent = Math.abs(rpm).toFixed(0);
  $("amps").textContent = `${currentA.toFixed(2)} A`;
  $("volts").textContent = `${voltageV.toFixed(0)} V`;
  $("torque").textContent = `${torqueNm.toFixed(1)} Nm`;
  $("loadText").textContent = `${loadPercent.toFixed(0)} %`;
  $("direction").textContent = Number(state.direction || 1) > 0 ? "FWD" : "REV";

  $("powerState").textContent = state.ready ? "READY" : state.status || "WAITING";
  $("readyLed").classList.toggle("on", !!state.ready);
  $("runLed").classList.toggle("on", !!state.running && !!state.ready);
  $("faultLed").classList.toggle("on", !!state.faultCode);
  $("shaft").classList.toggle("spin", outputHz > 0.2);

  $("mccb").classList.toggle("live", !!state.mccb);
  $("mccb").querySelector("strong").textContent = state.mccb ? "ON" : "OFF";
  $("km1").classList.toggle("live", !!state.km1);
  $("km1").querySelector("strong").textContent = state.km1 ? "ON" : "OFF";

  $("hmiStatus").textContent = state.status || "WAITING";
  $("hmiSp").textContent = `${referenceHz.toFixed(1)} Hz`;
  $("hmiPv").textContent = `${outputHz.toFixed(1)} Hz`;
  $("hmiRpm").textContent = Math.abs(rpm).toFixed(0);
  $("hmiAmp").textContent = `${currentA.toFixed(1)} A`;

  $("faultState").textContent = state.faultCode ? "FAULT ACTIVE" : "NO FAULT";
  $("faultCode").textContent = Number(state.faultCode || 0);
  $("faultDescription").textContent = state.faultDescription || "None";

  const io = activeAdapter.snapshot();
  setBit("ioStart", io.start);
  setBit("ioStop", io.stop);
  setBit("ioRev", io.reverse);
  setBit("ioRun", io.run);
  $("ioRef").textContent = `${Number(io.referenceHz || 0).toFixed(1)} Hz`;
  $("ioFbk").textContent = `${outputHz.toFixed(1)} Hz`;

  renderRegisters(state);
}

events.subscribe((_event, list) => {
  $("log").innerHTML = list
    .slice(0, 60)
    .map(
      (item) =>
        `<div class="event"><span>${item.time.toLocaleTimeString([], {
          hour12: false,
        })}</span><b>${item.source}</b><span>${item.message}</span></div>`
    )
    .join("");
});

document.querySelectorAll('input[name="mode"]').forEach((radio) => {
  radio.addEventListener("change", (event) => setMode(event.target.value));
});

$("connectBridge").addEventListener("click", () => {
  physicalPlc.connect($("bridgeUrl").value.trim());
});

physicalPlc.onConnectionChange = (connected) => {
  $("bridgeStatus").textContent = connected ? "Connected" : "Disconnected";
  $("bridgeBadge").textContent = connected
    ? "Local EtherNet/IP bridge"
    : "Local runtime";
};

$("connectRemote").addEventListener("click", () => {
  remoteMonitor.connect(
    $("relayUrl").value.trim(),
    $("sessionId").value.trim(),
    $("viewerKey").value
  );
});

remoteMonitor.onConnectionChange = (connected, meta) => {
  $("remoteStatus").textContent = meta.reconnecting
    ? "RECONNECTING"
    : connected
      ? meta.publisherOnline
        ? "ONLINE"
        : "WAITING FOR LAB"
      : "Disconnected";

  $("remoteViewers").textContent = `${Number(meta.viewers || 0)} viewer${
    Number(meta.viewers || 0) === 1 ? "" : "s"
  }`;

  $("remoteLatency").textContent =
    meta.latencyMs == null ? "-- ms" : `${meta.latencyMs} ms`;

  $("bridgeBadge").textContent = meta.reconnecting
    ? "Remote reconnecting"
    : connected
      ? meta.publisherOnline
        ? "Remote session online"
        : "Remote session waiting"
      : "Remote session";
};

remoteMonitor.onSnapshot = (_payload, meta) => {
  $("remoteStatus").textContent = "ONLINE";
  $("remoteViewers").textContent = `${Number(meta.viewers || 0)} viewer${
    Number(meta.viewers || 0) === 1 ? "" : "s"
  }`;
  $("remoteLatency").textContent =
    meta.latencyMs == null ? "-- ms" : `${meta.latencyMs} ms`;
};

$("speed").addEventListener("input", (event) => {
  $("speedText").textContent = Number(event.target.value).toFixed(1);
  if (currentMode === "virtual") {
    virtualPlc.setReference(Number(event.target.value));
  }
});

$("load").addEventListener("input", (event) => {
  if (currentMode === "virtual") {
    vfd.setLoad(Number(event.target.value));
  }
});

$("fwd").onclick = () => {
  if (currentMode === "virtual") virtualPlc.forward();
};
$("rev").onclick = () => {
  if (currentMode === "virtual") virtualPlc.reverse();
};
$("panelStop").onclick = () => {
  if (currentMode === "virtual") virtualPlc.stop();
};
$("start").onclick = () => {
  if (currentMode === "virtual") virtualPlc.forward();
};
$("stop").onclick = () => {
  if (currentMode === "virtual") virtualPlc.stop();
};
$("reset").onclick = () => {
  if (currentMode === "virtual") virtualPlc.reset();
};

$("mccb").onclick = () => {
  if (currentMode === "virtual") {
    vfd.command({ type: "POWER", mccb: !vfd.state.mccb });
  }
};

$("km1").onclick = () => {
  if (currentMode === "virtual") {
    vfd.command({ type: "POWER", km1: !vfd.state.km1 });
  }
};

$("hmiFwd").onclick = () => {
  if (currentMode === "virtual") virtualPlc.forward();
};
$("hmiRev").onclick = () => {
  if (currentMode === "virtual") virtualPlc.reverse();
};
$("hmiStop").onclick = () => {
  if (currentMode === "virtual") virtualPlc.stop();
};

document.querySelectorAll("[data-fault]").forEach((button) => {
  button.onclick = () => {
    if (currentMode === "virtual") {
      vfd.injectFault(button.dataset.fault);
    }
  };
});

$("clear").onclick = () => events.clear();

function frame(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  let state;
  if (currentMode === "remote") {
    state = applyRemoteState(remoteMonitor.remoteState);
  } else if (currentMode === "physical") {
    state = applyPhysicalState(physicalPlc.authoritativeState);
  } else {
    state = vfd.update(dt);
  }

  render(state);
  drawVf(state);
  drawWaveforms(state, dt);

  requestAnimationFrame(frame);
}

const query = new URLSearchParams(location.search);
const queryRelay = query.get("relay");
const querySession = query.get("session");
const queryMode = query.get("mode");

if (queryRelay) $("relayUrl").value = queryRelay;
if (querySession) $("sessionId").value = querySession;

virtualPlc.activate();
virtualPlc.setReference(30);

if (queryMode === "remote") {
  const remoteRadio = document.querySelector('input[name="mode"][value="remote"]');
  if (remoteRadio) {
    remoteRadio.checked = true;
    setMode("remote");
  }
}

events.emit("SYSTEM", "PF525 Digital Twin v0.6 initialized — public WSS remote monitoring");
requestAnimationFrame(frame);
