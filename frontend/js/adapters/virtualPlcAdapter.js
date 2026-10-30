export class VirtualPlcAdapter{
  constructor(vfd,events){this.vfd=vfd;this.events=events;this.active=false;this.io={start:0,stop:0,reverse:0,run:0,referenceHz:30}}
  activate(){this.active=true;this.vfd.setControlSource("VIRTUAL PLC");this.events.emit("SYSTEM","Virtual PLC active")}
  deactivate(){this.active=false}
  setReference(hz){this.io.referenceHz=Number(hz);if(this.active)this.vfd.command({type:"REFERENCE",value:this.io.referenceHz})}
  forward(){if(!this.active)return;this.io={...this.io,start:1,stop:0,reverse:0,run:1};this.vfd.command({type:"START",direction:1,referenceHz:this.io.referenceHz})}
  reverse(){if(!this.active)return;this.io={...this.io,start:1,stop:0,reverse:1,run:1};this.vfd.command({type:"START",direction:-1,referenceHz:this.io.referenceHz})}
  stop(){if(!this.active)return;this.io.start=0;this.io.stop=1;this.io.run=0;this.vfd.command({type:"STOP"});setTimeout(()=>this.io.stop=0,180)}
  reset(){if(this.active)this.vfd.command({type:"RESET"})}
  snapshot(){return{...this.io}}
}
