# PF525 Digital Twin v0.6 — Public Remote Monitoring

## New

- Relay HTTP health endpoint `/health`.
- Public WebSocket endpoint `/ws`.
- `render.yaml` for Render Blueprint deployment.
- Remote Viewer automatic reconnect with exponential backoff.
- Public monitor links can prefill `mode`, `relay`, and `session` query parameters.
- Viewer key is deliberately not embedded in URLs.

## Local relay URL

`ws://127.0.0.1:9000/ws`

## Public publisher example

```powershell
$env:PF525_RELAY_URL="wss://<your-service>.onrender.com/ws"
$env:PF525_SESSION_ID="LAB-TEST"
$env:PF525_PRODUCER_KEY="producer-secret"
$env:PF525_VIEWER_KEY="viewer-secret"
python backend\main.py 127.0.0.1
```
