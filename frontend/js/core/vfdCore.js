export class VfdCore{
 constructor(events){this.events=events;this.state={mccb:true,km1:true,powered:true,ready:true,running:false,direction:1,status:"STOPPED",faultCode:0,referenceHz:0,outputHz:0,rpm:0,currentA:0,voltageV:0,torqueNm:0,loadPercent:35,dcBusV:650,accelTimeS:5,decelTimeS:5,nominalVoltageV:400,nominalCurrentA:13,poles:4,source:"VIRTUAL PLC"}}
 setControlSource(name){this.state.source=name;this.events.emit("SYSTEM",`Control owner = ${name}`)}
 setLoad(x){this.state.loadPercent=Math.max(0,Math.min(150,Number(x)||0))}
 command(c){const s=this.state;if(!c)return;
  if(c.type==="START"){if(!s.ready||s.faultCode){this.events.emit("VFD","START rejected");return}s.running=true;if(Number.isFinite(c.referenceHz))s.referenceHz=c.referenceHz;if(c.direction)s.direction=c.direction;this.events.emit(s.source,`START ${s.direction>0?"FWD":"REV"} @ ${s.referenceHz.toFixed(1)} Hz`)}
  if(c.type==="STOP"){s.running=false;this.events.emit(s.source,"STOP")}
  if(c.type==="REFERENCE"){s.referenceHz=Math.max(0,Math.min(60,Number(c.value)||0));this.events.emit(s.source,`Reference ${s.referenceHz.toFixed(1)} Hz`)}
  if(c.type==="RESET"){s.faultCode=0;s.running=false;this.events.emit(s.source,"RESET")}
  if(c.type==="POWER"){if("mccb"in c)s.mccb=!!c.mccb;if("km1"in c)s.km1=!!c.km1;this.events.emit("POWER",`MCCB=${s.mccb?"ON":"OFF"} KM1=${s.km1?"ON":"OFF"}`)}
 }
 update(dt){const s=this.state;s.powered=s.mccb&&s.km1;s.ready=s.powered&&!s.faultCode;
  const busTarget=s.powered?650:0;s.dcBusV+=(busTarget-s.dcBusV)*Math.min(1,dt*(s.powered?3:1));if(!s.ready)s.running=false;
  const target=s.running?s.referenceHz:0,rising=target>s.outputHz,ramp=rising?s.accelTimeS:s.decelTimeS,step=60/Math.max(.1,ramp)*dt,error=target-s.outputHz;
  s.outputHz=Math.max(0,Math.abs(error)<=step?target:s.outputHz+Math.sign(error)*step);
  const load=s.loadPercent/100,sync=120*s.outputHz/s.poles,slip=Math.min(.09,.007+.04*load);s.rpm=s.direction*sync*(1-slip);
  s.voltageV=s.powered?Math.min(s.nominalVoltageV,s.nominalVoltageV*s.outputHz/50):0;
  s.currentA=s.outputHz>.05?s.nominalCurrentA*(.18+.72*load+Math.min(.45,Math.abs(error)/25)):0;
  const ratedTorque=5500/Math.max(1,(120*50/s.poles)*2*Math.PI/60);s.torqueNm=s.outputHz>.05?ratedTorque*load:0;
  if(s.faultCode)s.status="FAULTED";else if(!s.powered)s.status="POWER OFF";else if(s.running&&Math.abs(error)<.05)s.status="RUNNING";else if(s.running)s.status="ACCELERATING";else if(s.outputHz>.05)s.status="DECELERATING";else s.status="STOPPED";return s}
}