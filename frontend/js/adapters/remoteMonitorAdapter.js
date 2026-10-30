export class RemoteMonitorAdapter {
  constructor(events) {
    this.events = events;
    this.active = false;
    this.socket = null;
    this.connected = false;
    this.remoteState = null;
    this.networkRegisters = {logicCommand:0,logicStatus:0,reference:0,feedback:0};
    this.meta = {sessionId:"",publisherOnline:false,viewers:0,latencyMs:null,reconnecting:false};
    this.onConnectionChange = null;
    this.onSnapshot = null;
    this._manualDisconnect = false;
    this._retryTimer = null;
    this._attempt = 0;
    this._config = null;
  }

  activate() { this.active = true; this.events.emit("SYSTEM", "Remote Monitor active — read only"); }
  deactivate() { this.active = false; this.disconnect(); }

  connect(url, sessionId, viewerKey="") {
    const relay = String(url || "").trim();
    const sid = String(sessionId || "").trim();
    if (!relay || !sid) { this.events.emit("REMOTE", "Relay URL and Session ID are required"); return; }
    this._manualDisconnect = false;
    this._attempt = 0;
    this._config = {url:relay, sessionId:sid, viewerKey};
    this.meta.sessionId = sid;
    this._open();
  }

  _open() {
    if (!this.active || this._manualDisconnect || !this._config) return;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    const {url, sessionId, viewerKey} = this._config;
    this.events.emit("REMOTE", `${this._attempt ? "Reconnecting" : "Connecting"} to ${sessionId}`);
    this.meta.reconnecting = this._attempt > 0;
    this.onConnectionChange?.(false, this.meta);
    try { this.socket = new WebSocket(url); }
    catch (error) { this.events.emit("REMOTE", error.message); this._scheduleReconnect(); return; }

    this.socket.onopen = () => {
      this._attempt = 0;
      this.meta.reconnecting = false;
      this._send({type:"JOIN_VIEWER", sessionId, viewerKey});
    };
    this.socket.onclose = () => {
      this.connected = false;
      this.meta.publisherOnline = false;
      this.onConnectionChange?.(false, this.meta);
      if (!this._manualDisconnect && this.active) this._scheduleReconnect();
      else this.events.emit("REMOTE", "Disconnected");
    };
    this.socket.onerror = () => this.events.emit("REMOTE", "Relay WebSocket error");
    this.socket.onmessage = (event) => {
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === "JOINED") {
        this.connected = true;
        this.meta.publisherOnline = !!message.publisherOnline;
        this.meta.viewers = Number(message.viewers || 0);
        this.meta.reconnecting = false;
        this.onConnectionChange?.(true, this.meta);
        this.events.emit("REMOTE", `Joined ${sessionId}`);
        return;
      }
      if (message.type === "SESSION_STATUS") {
        this.meta.publisherOnline = !!message.publisherOnline;
        this.meta.viewers = Number(message.viewers || 0);
        this.onConnectionChange?.(this.connected, this.meta);
        return;
      }
      if (message.type === "SNAPSHOT") {
        const payload = message.payload || {};
        this.remoteState = payload.drive || null;
        this.networkRegisters = {...this.networkRegisters, ...(payload.network || {})};
        this.meta.publisherOnline = true;
        this.meta.viewers = Number(message.viewers || this.meta.viewers || 0);
        if (Number.isFinite(message.serverTimeMs)) this.meta.latencyMs = Math.max(0, Date.now() - message.serverTimeMs);
        this.onSnapshot?.(payload, this.meta);
        return;
      }
      if (message.type === "ERROR") this.events.emit("REMOTE", message.message || "Relay error");
    };
  }

  _scheduleReconnect() {
    if (this._retryTimer || this._manualDisconnect || !this.active) return;
    this._attempt += 1;
    const delay = Math.min(1000 * Math.pow(2, Math.min(this._attempt - 1, 4)), 15000);
    this.meta.reconnecting = true;
    this.events.emit("REMOTE", `Relay unavailable — retry in ${(delay / 1000).toFixed(0)} s`);
    this.onConnectionChange?.(false, this.meta);
    this._retryTimer = setTimeout(() => { this._retryTimer = null; this._open(); }, delay);
  }

  disconnect() {
    this._manualDisconnect = true;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    if (this.socket) { try { this.socket.close(); } catch {} this.socket = null; }
    this.connected = false;
    this.remoteState = null;
    this.meta.reconnecting = false;
    this.onConnectionChange?.(false, this.meta);
  }

  snapshot() {
    const s = this.remoteState || {};
    return {start:s.running?1:0, stop:0, reverse:Number(s.direction||1)<0?1:0, run:s.running?1:0, referenceHz:Number(s.referenceHz||0)};
  }

  _send(message) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }
}
