export class PhysicalPlcAdapter{
 constructor(vfd,events){this.vfd=vfd;this.events=events;this.active=false;this.connected=false;this.socket=null;this.io={start:0,stop:0,reverse:0,run:0,referenceHz:0};this.onConnectionChange=null}
 activate(){this.active=true;this.vfd.setControlSource("PHYSICAL PLC")}
 deactivate(){this.active=false;this.disconnect()}
 connect(url){this.disconnect();this.events.emit("BRIDGE",`Connecting ${url}`);this.socket=new WebSocket(url);
  this.socket.onopen=()=>{this.connected=true;this.events.emit("BRIDGE","Connected");this.onConnectionChange?.(true);this.socket.send(JSON.stringify({type:"HELLO",client:"PF525_UI"}))};
  this.socket.onclose=()=>{this.connected=false;this.events.emit("BRIDGE","Disconnected");this.onConnectionChange?.(false)};
  this.socket.onmessage=(e)=>{let m;try{m=JSON.parse(e.data)}catch{return}if(m.type==="PLC_COMMAND"&&this.active){const c=m.command||{};if(c.type==="START"){this.io.start=1;this.io.run=1;this.io.reverse=c.direction<0?1:0;this.io.referenceHz=Number(c.referenceHz||0)}if(c.type==="STOP"){this.io.start=0;this.io.stop=1;this.io.run=0}if(c.type==="REFERENCE")this.io.referenceHz=Number(c.value||0);this.vfd.command(c);this.events.emit("EtherNet/IP",m.summary||JSON.stringify(c))}}
 }
 disconnect(){if(this.socket){try{this.socket.close()}catch{}this.socket=null}this.connected=false;this.onConnectionChange?.(false)}
 publish(s){if(this.connected&&this.socket?.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify({type:"VFD_FEEDBACK",feedback:{status:s.status,outputHz:s.outputHz,rpm:s.rpm,currentA:s.currentA,voltageV:s.voltageV,torqueNm:s.torqueNm,faultCode:s.faultCode}}))}
 snapshot(){return{...this.io}}
}