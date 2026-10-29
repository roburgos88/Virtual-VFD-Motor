export class EventBus{
 constructor(limit=200){this.limit=limit;this.events=[];this.listeners=new Set()}
 emit(source,message,data=null){const e={time:new Date(),source,message,data};this.events.unshift(e);this.events=this.events.slice(0,this.limit);for(const f of this.listeners)f(e,this.events)}
 subscribe(f){this.listeners.add(f);return()=>this.listeners.delete(f)}
 clear(){this.events=[];for(const f of this.listeners)f(null,this.events)}
}