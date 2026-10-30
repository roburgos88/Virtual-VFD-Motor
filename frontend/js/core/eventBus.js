export class EventBus{
  constructor(limit=250){this.limit=limit;this.events=[];this.listeners=new Set()}
  emit(source,message,data=null){const e={time:new Date(),source,message,data};this.events.unshift(e);if(this.events.length>this.limit)this.events.length=this.limit;for(const fn of this.listeners)fn(e,this.events)}
  subscribe(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn)}
  clear(){this.events=[];for(const fn of this.listeners)fn(null,this.events)}
}
