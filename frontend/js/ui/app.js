import{EventBus}from"../core/eventBus.js";import{VfdCore}from"../core/vfdCore.js";import{VirtualPlcAdapter}from"../adapters/virtualPlcAdapter.js";import{PhysicalPlcAdapter}from"../adapters/physicalPlcAdapter.js";
const $=id=>document.getElementById(id),events=new EventBus(),vfd=new VfdCore(events),vp=new VirtualPlcAdapter(vfd,events),pp=new PhysicalPlcAdapter(vfd,events);let adapter=vp,last=performance.now(),acc=0,phase=0;
function mode(m){vp.deactivate();pp.deactivate();adapter=m==="physical"?pp:vp;adapter.activate();const p=m==="physical";$("physicalCfg").classList.toggle("hidden",!p);$("modeBadge").textContent=p?"PHYSICAL PLC":"VIRTUAL";$("owner").textContent=`OWNER: ${p?"PHYSICAL PLC":"VIRTUAL PLC"}`;$("plcTitle").textContent=p?"Physical PLC / Bridge":"Virtual PLC";if(p&&location.protocol==="https:")events.emit("SYSTEM","Physical mode requires local runtime; GitHub Pages is virtual-only.")}
function bit(id,v){$(id).textContent=v?1:0}
function drawVf(s){const c=$("vfCanvas"),x=c.getContext("2d"),w=c.width,h=c.height,p=34;x.clearRect(0,0,w,h);x.strokeStyle="#2c3a49";x.lineWidth=1;for(let i=0;i<=6;i++){let xx=p+(w-2*p)*i/6;x.beginPath();x.moveTo(xx,p);x.lineTo(xx,h-p);x.stroke()}for(let i=0;i<=4;i++){let yy=h-p-(h-2*p)*i/4;x.beginPath();x.moveTo(p,yy);x.lineTo(w-p,yy);x.stroke()}x.strokeStyle="#45d483";x.lineWidth=3;x.beginPath();x.moveTo(p,h-p);x.lineTo(p+(w-2*p)*50/60,p);x.lineTo(w-p,p);x.stroke();const opX=p+(w-2*p)*s.outputHz/60,opY=h-p-(h-2*p)*Math.min(400,s.voltageV)/400;x.fillStyle="#2aa9ff";x.beginPath();x.arc(opX,opY,6,0,Math.PI*2);x.fill();x.fillStyle="#91a0ad";x.font="12px Segoe UI";x.fillText("0 Hz",p-8,h-10);x.fillText("60 Hz",w-p-18,h-10);x.fillText("400 V",4,p+4)}
function drawWaves(s,dt){const c=$("waveCanvas"),x=c.getContext("2d"),w=c.width,h=c.height;x.clearRect(0,0,w,h);x.strokeStyle="#2c3a49";x.beginPath();x.moveTo(0,h/2);x.lineTo(w,h/2);x.stroke();phase+=dt*s.outputHz*Math.PI*2;const amp=(h*.36)*(s.voltageV/400),colors=["#45d483","#2aa9ff","#f2b84b"];[0,-2*Math.PI/3,-4*Math.PI/3].forEach((off,j)=>{x.strokeStyle=colors[j];x.lineWidth=2;x.beginPath();for(let px=0;px<w;px++){const t=(px/w)*4*Math.PI,yy=h/2-Math.sin(t+phase+off)*amp;if(px===0)x.moveTo(px,yy);else x.lineTo(px,yy)}x.stroke()})}

function hex16(value){return `0x${(Number(value)&0xFFFF).toString(16).toUpperCase().padStart(4,"0")}`;}

function renderRegisters(s){
  let logicCommand=0;
  let logicStatus=vfd.logicStatusWord();
  let reference=vfd.referenceWord();
  let feedback=vfd.feedbackWord();

  if(activeAdapter===physicalPlc){
    const r=physicalPlc.networkRegisters||{};
    logicCommand=Number(r.logicCommand??0);
    logicStatus=Number(r.logicStatus??logicStatus);
    reference=Number(r.reference??reference);
    feedback=Number(r.feedback??feedback);
  }else{
    const io=virtualPlc.snapshot();
    if(io.stop)logicCommand|=1<<0;
    if(io.run)logicCommand|=1<<1;
    if(io.reverse)logicCommand|=1<<5;
    else if(io.run)logicCommand|=1<<4;
  }

  $("regLogicCommandHex").textContent=hex16(logicCommand);
  $("regLogicCommandDec").textContent=String(logicCommand);
  $("regLogicStatusHex").textContent=hex16(logicStatus);
  $("regLogicStatusDec").textContent=String(logicStatus);
  $("regReferenceHex").textContent=hex16(reference);
  $("regReferenceDec").textContent=String(reference);
  $("regReferenceHz").textContent=(reference/100).toFixed(2);
  $("regFeedbackHex").textContent=hex16(feedback);
  $("regFeedbackDec").textContent=String(feedback);
  $("regFeedbackHz").textContent=(feedback/100).toFixed(2);
}

function render(s){$("driveState").textContent=s.status;$("freqDisplay").textContent=s.outputHz.toFixed(2);$("busV").textContent=`${s.dcBusV.toFixed(0)} V`;$("miniRpm").textContent=`${Math.abs(s.rpm).toFixed(0)} RPM`;$("mf").textContent=`${s.outputHz.toFixed(2)} Hz`;$("rpm").textContent=Math.abs(s.rpm).toFixed(0);$("amps").textContent=`${s.currentA.toFixed(2)} A`;$("volts").textContent=`${s.voltageV.toFixed(0)} V`;$("torque").textContent=`${s.torqueNm.toFixed(1)} Nm`;$("loadText").textContent=`${s.loadPercent.toFixed(0)} %`;$("direction").textContent=s.direction>0?"FWD":"REV";$("powerState").textContent=s.ready?"READY":s.status;$("readyLed").classList.toggle("on",s.ready);$("runLed").classList.toggle("on",s.running&&s.ready);$("faultLed").classList.toggle("on",!!s.faultCode);$("shaft").classList.toggle("spin",s.outputHz>.2);$("mccb").classList.toggle("live",s.mccb);$("mccb").querySelector("strong").textContent=s.mccb?"ON":"OFF";$("km1").classList.toggle("live",s.km1);$("km1").querySelector("strong").textContent=s.km1?"ON":"OFF";$("hmiStatus").textContent=s.status;$("hmiSp").textContent=`${s.referenceHz.toFixed(1)} Hz`;$("hmiPv").textContent=`${s.outputHz.toFixed(1)} Hz`;$("hmiRpm").textContent=Math.abs(s.rpm).toFixed(0);$("hmiAmp").textContent=`${s.currentA.toFixed(1)} A`;$("faultState").textContent=s.faultCode?"FAULT ACTIVE":"NO FAULT";$("faultCode").textContent=s.faultCode;$("faultDescription").textContent=s.faultDescription;const io=adapter.snapshot();bit("ioStart",io.start);bit("ioStop",io.stop);bit("ioRev",io.reverse);bit("ioRun",io.run);$("ioRef").textContent=`${Number(io.referenceHz||0).toFixed(1)} Hz`;$("ioFbk").textContent=`${s.outputHz.toFixed(1)} Hz`}
events.subscribe((e,list)=>{$("log").innerHTML=list.slice(0,60).map(x=>`<div class="event"><span>${x.time.toLocaleTimeString([],{hour12:false})}</span><b>${x.source}</b><span>${x.message}</span></div>`).join("")});
document.querySelectorAll('input[name="mode"]').forEach(r=>r.onchange=e=>mode(e.target.value));$("connectBridge").onclick=()=>pp.connect($("bridgeUrl").value.trim());pp.onConnectionChange=c=>{$("bridgeStatus").textContent=c?"Connected":"Disconnected";$("bridgeBadge").textContent=c?"Local EtherNet/IP bridge":"Browser simulation"};
$("speed").oninput=e=>{$("speedText").textContent=Number(e.target.value).toFixed(1);if(adapter===vp)vp.setReference(e.target.value)};$("load").oninput=e=>vfd.setLoad(e.target.value);$("fwd").onclick=()=>vp.forward();$("rev").onclick=()=>vp.reverse();$("panelStop").onclick=()=>vp.stop();$("start").onclick=()=>adapter===vp&&vp.forward();$("stop").onclick=()=>adapter===vp&&vp.stop();$("reset").onclick=()=>adapter===vp&&vp.reset();$("mccb").onclick=()=>vfd.command({type:"POWER",mccb:!vfd.state.mccb});$("km1").onclick=()=>vfd.command({type:"POWER",km1:!vfd.state.km1});$("hmiFwd").onclick=()=>vp.forward();$("hmiRev").onclick=()=>vp.reverse();$("hmiStop").onclick=()=>vp.stop();document.querySelectorAll("[data-fault]").forEach(b=>b.onclick=()=>vfd.injectFault(b.dataset.fault));$("clear").onclick=()=>events.clear();
function frame(now){const dt=Math.min(.1,(now-last)/1000);last=now;const s=vfd.update(dt);render(s);drawVf(s);drawWaves(s,dt);acc+=dt;if(acc>.1&&adapter===pp){acc=0;pp.publish(s)}requestAnimationFrame(frame)}
vp.activate();vp.setReference(30);events.emit("SYSTEM","PF525 Digital Twin initialized");requestAnimationFrame(frame);