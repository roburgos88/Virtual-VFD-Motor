export class PhysicalPlcAdapter{
  constructor(vfd,events){
    this.vfd=vfd;this.events=events;this.active=false;this.socket=null;this.connected=false;
    this.io={start:0,stop:0,reverse:0,run:0,referenceHz:0};
    this.networkRegisters={logicCommand:0,logicStatus:0,reference:0,feedback:0};
    this.parameters=[];
    this.authoritativeState=null;
    this.onSnapshot=null;
    this.onConnectionChange=null;
  }
  activate(){this.active=true;this.vfd.setControlSource("PHYSICAL PLC");this.events.emit("SYSTEM","Physical PLC adapter active")}
  deactivate(){this.active=false;this.disconnect()}
  connect(url){
    this.disconnect();this.events.emit("BRIDGE",`Connecting ${url}`);
    try{this.socket=new WebSocket(url)}catch(e){this.events.emit("BRIDGE",e.message);return}
    this.socket.onopen=()=>{this.connected=true;this.onConnectionChange?.(true);this._send({type:"HELLO",client:"PF525_WEB_UI"});this.events.emit("BRIDGE","Local runtime connected")};
    this.socket.onclose=()=>{this.connected=false;this.onConnectionChange?.(false);this.events.emit("BRIDGE","Local runtime disconnected")};
    this.socket.onerror=()=>this.events.emit("BRIDGE","WebSocket error");
    this.socket.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch{return}
      if(m.type==="AUTHORITATIVE_SNAPSHOT"){const p=m.payload||{};this.authoritativeState=p.drive||null;this.networkRegisters={...this.networkRegisters,...(p.network||{})};this.parameters=Array.isArray(p.parameters)?p.parameters:[];this.onSnapshot?.(p);return}
      if(m.type==="PLC_EVENT"){this.events.emit("EtherNet/IP",m.summary||"PLC event");return}
      if(m.type==="PARAMETER_EVENT"){this.events.emit("Parameter",m.summary||"Parameter event");return}
      if(m.type==="REGISTER_SNAPSHOT"){this.networkRegisters={...this.networkRegisters,...(m.registers||{})};return}
      if(m.type==="PLC_COMMAND"&&this.active){
        const c=m.command||{};
        if(c.type==="START"){this.io.start=1;this.io.stop=0;this.io.run=1;this.io.reverse=c.direction<0?1:0;if(Number.isFinite(c.referenceHz))this.io.referenceHz=c.referenceHz}
        if(c.type==="STOP"){this.io.start=0;this.io.stop=1;this.io.run=0;setTimeout(()=>this.io.stop=0,180)}
        if(c.type==="REFERENCE")this.io.referenceHz=Number(c.value||0);
        this.vfd.command(c);this.events.emit("EtherNet/IP",m.summary||JSON.stringify(c))
      }
    }
  }
  disconnect(){if(this.socket){try{this.socket.close()}catch{}this.socket=null}this.connected=false;this.onConnectionChange?.(false)}
  publish(s){
    if(!this.connected)return;
    this._send({type:"VFD_FEEDBACK",feedback:{
      status:s.status,referenceHz:s.referenceHz,outputHz:s.outputHz,rpm:s.rpm,currentA:s.currentA,voltageV:s.voltageV,
      torqueNm:s.torqueNm,loadPercent:s.loadPercent,dcBusV:s.dcBusV,faultCode:s.faultCode,faultDescription:s.faultDescription,
      ready:s.ready,running:s.running,direction:s.direction,mccb:s.mccb,km1:s.km1,powered:s.powered,
      accelerating:s.status==="ACCELERATING",decelerating:s.status==="DECELERATING",
      atSpeed:s.running&&Math.abs(s.referenceHz-s.outputHz)<.05
    }})
  }
  snapshot(){return{...this.io}}
  _send(o){if(this.socket?.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify(o))}
}
