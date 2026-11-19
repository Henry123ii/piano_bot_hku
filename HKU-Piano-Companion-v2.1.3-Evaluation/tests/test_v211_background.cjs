'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const P=path.resolve(__dirname,'..');
const H=require('../shared.js'),W=require('../schedule.js');
const BASE=H.BASE;
function setup(startTime,initial={}){
  let now=startTime;
  class ClockDate extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const listeners={};const on=name=>({addListener:fn=>(listeners[name]??=[]).push(fn)});
  const local=structuredClone(initial),session={},alarms=new Map(),wins=new Map(),tabs=new Map(),notifications=new Map();
  let nextWindow=10,nextTab=100;
  function store(data){return {get:async keys=>{if(keys==null)return structuredClone(data);if(typeof keys==='string')keys=[keys];return Object.fromEntries(keys.filter(k=>Object.hasOwn(data,k)).map(k=>[k,structuredClone(data[k])]));},set:async d=>{for(const[k,v]of Object.entries(d))data[k]=structuredClone(v);},remove:async keys=>{for(const k of typeof keys==='string'?[keys]:keys)delete data[k];}};}
  const chrome={
    runtime:{getURL:f=>'chrome-extension://test/'+f,onMessage:on('runtime.message'),onStartup:on('runtime.startup'),onInstalled:on('runtime.installed')},
    action:{onClicked:on('action.clicked')},
    alarms:{onAlarm:on('alarms.alarm'),getAll:async()=>[...alarms].map(([name,d])=>({name,...d})),clear:async name=>alarms.delete(name),create:async(name,config)=>{alarms.set(name,{scheduledTime:config.when||now+60000,periodInMinutes:config.periodInMinutes});}},
    storage:{local:store(local),session:store(session),onChanged:on('storage.changed')},
    notifications:{onClicked:on('notifications.clicked'),getPermissionLevel:async()=> 'granted',create:async(id,details)=>{notifications.set(id,details);return id;},clear:async id=>notifications.delete(id)},
    windows:{onRemoved:on('windows.removed'),getAll:async()=>[...wins.values()],create:async d=>{const id=nextWindow++,tab={id:nextTab++,url:d.url,status:'complete',windowId:id};tabs.set(tab.id,tab);const w={id,type:d.type||'normal',focused:d.focused,tabs:[tab]};wins.set(id,w);return w;},remove:async id=>{wins.delete(id);},update:async id=>wins.get(id)||{id}},
    tabs:{query:async()=>[],sendMessage:async(id,m)=>{if(m.type==='HKU_PROBE')return {ok:true,authenticated:true};throw Error('Unexpected tab request '+m.type);},get:async id=>tabs.get(id),update:async id=>tabs.get(id)},
    debugger:{detach:async()=>{}}
  };
  const ctx=vm.createContext({chrome,Date:ClockDate,crypto:{randomUUID},console,setTimeout,clearTimeout,URL,URLSearchParams,Intl,TextEncoder});
  ctx.importScripts=(...files)=>{for(const file of files)vm.runInContext(fs.readFileSync(path.join(P,file),'utf8'),ctx,{filename:file});};
  ctx.importScripts('background.js');
  async function message(type,args={},url='chrome-extension://test/app.html'){
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('timeout '+type)),2000);
      let called=false;
      const reply=v=>{if(!called){called=true;clearTimeout(timer);resolve(v);}};
      for(const fn of listeners['runtime.message']||[])fn({type,...args},{url},reply);
    });
  }
  async function alarm(name){for(const f of listeners['alarms.alarm']||[])f({name});await flush();}
  async function flush(){await new Promise(r=>setTimeout(r,30));}
  return{local,session,alarms,wins,tabs,notifications,chrome,message,alarm,flush,now:setValue=>now=setValue};
}
const template=()=>{
  const date=H.hkParts(Date.now()+12*86400000).date;
  const end=H.hkParts(H.hkEpoch(date,'14:00')+3600000);
  const release=H.hkParts(H.hkEpoch(end.date,end.time)-6*86400000);
  return{roomId:'2871',date,start:'14:00',end:'15:00',uid:'TEST-STUDENT',phone:'12345678',people:'1',agreementAccepted:true,mode:'scheduled',dryRun:false,releaseDate:release.date,releaseTime:release.time,offset:0.2,captchaLead:10,late:120,runId:randomUUID()};
};
test('manual booking opens separate Edge window, is claimed once, and cannot double submit',async()=>{
  const s=setup(Date.now());await s.flush();const c=template();
  const r=await s.message('HKU_START_MANUAL',{config:c});assert.equal(r.ok,true);
  assert.equal(s.session.activeRun.id,c.runId);
  assert.equal(s.session.activeRun.status,'reserved');
  assert.equal(s.wins.size,1);
  const fromRunner='chrome-extension://test/runner.html?run='+c.runId;
  assert.equal((await s.message('HKU_CLAIM_RUN',{runId:c.runId},fromRunner)).alreadyClaimed,false);
  assert.equal((await s.message('HKU_CLAIM_RUN',{runId:c.runId},fromRunner)).alreadyClaimed,true);
  assert.equal((await s.message('HKU_RUN_ATTEMPT',{runId:c.runId},fromRunner)).ok,true);
  const double=await s.message('HKU_RUN_ATTEMPT',{runId:c.runId},fromRunner);assert.equal(double.ok,false);
  assert.equal((await s.message('HKU_RUN_FINISHED',{runId:c.runId,outcome:'unknown',attempted:true},fromRunner)).ok,true);
  assert.equal(s.session.activeRun,undefined);
  assert.equal(s.local.bookingAttempts[`${c.roomId}:${c.date}:${c.start}`].status,'unknown');
  const second=await s.message('HKU_START_MANUAL',{config:{...c,runId:randomUUID()}});assert.equal(second.ok,false);
});
test('automatic scheduled booking runs without panel confirmation, with login check and result notification',async()=>{
  // Monday Nov 30 14:00-15:00 releases Tue Nov 24 15:00 HKT.
  const o=W.occurrence({id:'regular',roomId:'2871',weekday:1,start:'14:00'},'2026-11-30');
  const s=setup(o.releaseAt-31*60000,{autoWeeklyEnabled:true,autoWeeklyEnabledAt:o.releaseAt-2*3600000,
    weeklyEntries:[{id:'regular',weekday:1,start:'14:00',roomId:'2871',enabled:true}],weeklyHistory:{},
    preferences:{uid:'TEST-STUDENT',phone:'12345678',people:'1',remember:true,offset:'0.2',captchaLead:'10',late:'120'},
    agreementConsent:{accepted:true}});
  await s.flush();
  assert.equal(s.alarms.get('hku-auto-login:'+o.key).scheduledTime,o.releaseAt-30*60000);
  assert.equal(s.alarms.get('hku-auto-run:'+o.key).scheduledTime,o.releaseAt-90000);
  s.now(o.releaseAt-30*60000);await s.alarm('hku-auto-login:'+o.key);
  assert.equal(s.local.autoLoginChecks[o.key].status,'valid');
  s.now(o.releaseAt-90000+3);await s.alarm('hku-auto-run:'+o.key);
  assert.equal(s.session.activeRun.auto,true);
  assert.equal(s.session.activeRun.status,'reserved');
  assert.equal(s.local.weeklyHistory[o.key].status,'running');
  assert.equal(s.wins.size,1); // login-check window was closed
  const id=s.session.activeRun.id;const url='chrome-extension://test/runner.html?run='+id;
  await s.message('HKU_CLAIM_RUN',{runId:id},url);
  await s.message('HKU_RUN_ATTEMPT',{runId:id},url);
  await s.message('HKU_RUN_FINISHED',{runId:id,outcome:'success',attempted:true},url);
  assert.equal(s.local.weeklyHistory[o.key].status,'success');
  assert.equal(s.local.lastRunSummary.auto,true);
  assert.equal(s.local.lastRunSummary.outcome,'success');
  assert.equal(s.notifications.has('hku-auto-result:'+id),true);
  await s.alarm('hku-auto-run:'+o.key);
  assert.equal(s.wins.size,1);
});
test('automatic mode off removes future booking alarms and never starts a run',async()=>{
  const o=W.occurrence({id:'regular',roomId:'2871',weekday:1,start:'14:00'},'2026-11-30');
  const s=setup(o.releaseAt-2*3600000,{autoWeeklyEnabled:false,autoWeeklyEnabledAt:0,
    weeklyEntries:[{id:'regular',weekday:1,start:'14:00',roomId:'2871'}]});
  await s.flush();assert.equal([...s.alarms.keys()].some(k=>k.startsWith('hku-auto-run:')),false);
  await s.alarm('hku-auto-run:'+o.key);
  assert.equal(s.session.activeRun,undefined);
});
