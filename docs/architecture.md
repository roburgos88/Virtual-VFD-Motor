# Architecture

Static mode:
Browser -> VirtualPlcAdapter -> VfdCore -> Motor/Process

Physical mode:
MicroLogix -> EtherNet/IP :44818 -> Python bridge -> WebSocket -> PhysicalPlcAdapter -> VfdCore

The browser VFD core is authoritative in both modes. The Python process is a communications adapter, not the simulation model.

GitHub Pages hosts only the static frontend. Physical commissioning requires the local runtime.
