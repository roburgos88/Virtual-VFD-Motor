# PF525 Digital Twin — v0.1 Foundation

## Core principle
The VFD core does not know who generates commands.

Virtual PLC / Physical PLC -> Adapter -> VFD Core -> Motor / Process

## Virtual mode
`frontend/` is pure HTML/CSS/JavaScript and can run on GitHub Pages.

## Physical commissioning mode
The same frontend is served locally by `backend/main.py`. The local runtime adds WebSocket and EtherNet/IP port 44818.

### Install
```powershell
python -m pip install -r backend\requirements.txt
```

### Run
```powershell
python backend\main.py 192.168.1.100
```
Open `http://127.0.0.1:8080`, select **Physical PLC**, then connect the local bridge.

## GitHub Pages
Push the repository to GitHub, then enable:
Settings -> Pages -> Source -> GitHub Actions

The included workflow publishes only `/frontend`.

## Current milestone
- Virtual/Physical PLC selector
- Source abstraction
- Browser VFD core
- MCCB/KM1/DC bus behavior
- Motor RPM/frequency/current/voltage/torque
- Virtual PLC operator commands
- PLC monitor
- Communication Inspector
- Local WebSocket bridge
- Minimal RSLinx ListIdentity foundation

## Next milestone
- Full PF525 visual panel and HMI
- V/f plot and U/V/W waveforms
- Fault engine
- Register Object / Logic Command / Reference / Feedback for MicroLogix explicit MSG
