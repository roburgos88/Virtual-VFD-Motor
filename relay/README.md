# PF525 Remote Relay — Public WSS deployment

One authoritative producer per session, with any number of read-only viewers.

## Local

```powershell
python -m pip install -r relay\requirements.txt
python relay\relay_server.py
```

- Health: `http://127.0.0.1:9000/health`
- WebSocket: `ws://127.0.0.1:9000/ws`

## Render

The repository includes `render.yaml`. Deploy it as a Render Blueprint, verify `/health`, and use `wss://<service>.onrender.com/ws` from GitHub Pages and the local publisher.
