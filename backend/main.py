from __future__ import annotations
import asyncio,json,socket,struct,sys,threading
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
import websockets

ROOT=Path(__file__).resolve().parents[1]; FRONTEND=ROOT/"frontend"
HTTP_PORT=8080; WS_PORT=8765; ENIP_PORT=44818
clients=set(); latest_feedback={}

def log(s): print("[PF525]",s,flush=True)

class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*a,**kw): super().__init__(*a,directory=str(FRONTEND),**kw)
    def log_message(self,fmt,*a): pass

def http_server():
    log("Frontend http://127.0.0.1:8080")
    ThreadingHTTPServer(("127.0.0.1",HTTP_PORT),Handler).serve_forever()

async def ws_handler(ws):
    global latest_feedback
    clients.add(ws); log("UI connected")
    try:
        async for raw in ws:
            try: m=json.loads(raw)
            except: continue
            if m.get("type")=="HELLO": await ws.send(json.dumps({"type":"BRIDGE_STATUS","status":"READY","enipPort":ENIP_PORT}))
            elif m.get("type")=="VFD_FEEDBACK": latest_feedback=m.get("feedback",{})
    finally: clients.discard(ws); log("UI disconnected")

async def send_plc_command(command,summary=""):
    msg=json.dumps({"type":"PLC_COMMAND","command":command,"summary":summary})
    for ws in list(clients):
        try: await ws.send(msg)
        except: pass

class IdentityServer:
    def __init__(self,ip): self.ip=ip; self.name="PowerFlex 525 Digital Twin"; self.serial=525001
    def header(self,c,p,session=0,ctx=b"\0"*8): return struct.pack("<HHII8sI",c,len(p),session,0,ctx[:8].ljust(8,b"\0"),0)+p
    def identity(self):
        sockaddr=struct.pack(">H",socket.AF_INET)+struct.pack(">H",ENIP_PORT)+socket.inet_aton(self.ip)+b"\0"*8
        name=self.name.encode()
        item=struct.pack("<H",1)+sockaddr+struct.pack("<HHH",0xFFFF,0x0002,0x0525)+struct.pack("<BBH",1,0,0)+struct.pack("<I",self.serial)+bytes([len(name)])+name+b"\0"
        return struct.pack("<H",1)+struct.pack("<HH",0x000C,len(item))+item
    def udp(self):
        s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.setsockopt(socket.SOL_SOCKET,socket.SO_BROADCAST,1);s.bind(("",ENIP_PORT));log("ENIP UDP :44818")
        while True:
            d,r=s.recvfrom(4096)
            if len(d)>=24:
                c,_,_,_,ctx,_=struct.unpack("<HHII8sI",d[:24])
                if c==0x0063: s.sendto(self.header(c,self.identity(),ctx=ctx),r);log(f"ListIdentity -> {r[0]}")
    def tcp(self):
        s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind((self.ip,ENIP_PORT));s.listen();log(f"ENIP TCP {self.ip}:44818")
        while True:
            c,r=s.accept();threading.Thread(target=self.client,args=(c,r),daemon=True).start()
    def recvn(self,s,n):
        d=b""
        while len(d)<n:
            x=s.recv(n-len(d))
            if not x:return None
            d+=x
        return d
    def client(self,s,r):
        session=0x1001
        try:
            while True:
                h=self.recvn(s,24)
                if not h:break
                cmd,n,_,_,ctx,_=struct.unpack("<HHII8sI",h);p=self.recvn(s,n) if n else b""
                if cmd==0x0065:s.sendall(self.header(cmd,struct.pack("<HH",1,0),session,ctx));log(f"RegisterSession <- {r[0]}")
                elif cmd==0x0063:s.sendall(self.header(cmd,self.identity(),ctx=ctx))
                elif cmd==0x0066:break
                else:s.sendall(self.header(cmd,b"",session,ctx))
        finally:s.close()
    def start(self):
        threading.Thread(target=self.udp,daemon=True).start();threading.Thread(target=self.tcp,daemon=True).start()

def choose_ip():
    if len(sys.argv)>1:return sys.argv[1]
    s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
    try:s.connect(("8.8.8.8",80));return s.getsockname()[0]
    except:return "0.0.0.0"
    finally:s.close()

async def main():
    ip=choose_ip();log(f"Industrial interface {ip}")
    threading.Thread(target=http_server,daemon=True).start();IdentityServer(ip).start()
    async with websockets.serve(ws_handler,"127.0.0.1",WS_PORT):
        log("WebSocket ws://127.0.0.1:8765");await asyncio.Future()

if __name__=="__main__": asyncio.run(main())
