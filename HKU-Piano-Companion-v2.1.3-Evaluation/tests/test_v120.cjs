const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const H=require('../shared.js'),T=require('../typing.js'),W=require('../schedule.js');
const c={agreementAccepted:true,roomId:'2871',date:'2026-11-17',start:'11:00',end:'12:00',uid:'TEST-STUDENT',phone:'12345678',people:'1',mode:'scheduled',releaseDate:'2026-11-11',releaseTime:'12:00:00',early:30,offset:.2,captchaLead:10,late:120};
const e={id:'fixture-tuesday',roomId:'2871',weekday:2,start:'11:00',enabled:true};
test('Tuesday 11-12 releases preceding Wednesday at NOON, not at 11',()=>{
 const o=W.occurrence(e,'2026-11-17');assert.equal(H.hkStamp(o.releaseAt),'2026-11-11 12:00:00.000 HKT');assert.equal(H.hkParts(o.reminderAt).time,'11:30:00');assert.equal(H.hkParts(o.runAt).time,'11:55:00');
});
test('overnight one-hour booking uses the next end date and release date correctly',()=>{
 const o=W.occurrence({...e,start:'23:00'},'2026-11-17');assert.equal(o.end,'00:00');assert.equal(o.endDate,'2026-11-18');assert.equal(H.hkParts(o.releaseAt).date,'2026-11-12');
 const u=H.reservationURL(o);assert.equal(new URL(u).searchParams.get('ed'),'2026-11-18 00:00:00');assert.equal(H.parseReservationURL(u).endDate,'2026-11-18');
});
test('year and leap-day boundaries use calendar arithmetic without DST',()=>{
 const a=W.occurrence({...e,start:'23:00'},'2026-12-31');assert.equal(a.endDate,'2027-01-01');assert.equal(H.hkParts(a.releaseAt).date,'2026-12-26');
 assert.equal(H.addDays('2028-02-28',1),'2028-02-29');assert.equal(H.addDays('2028-02-29',1),'2028-03-01');
});
test('already-released upcoming occurrence remains visible and uses Prepare now',()=>{
 const now=H.hkEpoch('2026-11-13','16:00'),all=W.occurrences([e],now);assert.equal(all[0].date,'2026-11-17');assert.equal(W.status(all[0],{},now),'released');assert.equal(W.config(all[0],{},now).mode,'now');assert.equal(all[1].date,'2026-11-24');
});
test('overlapping and duplicate weekly entries are rejected, including week boundary',()=>{
 assert.throws(()=>W.validateEntry({...e,id:'duplicate'},[e]),/overlaps/);
 assert.throws(()=>W.validateEntry({...e,id:'sun',weekday:0,start:'23:30'}),/full clock hour/);
 assert.doesNotThrow(()=>W.validateEntry({...e,id:'mon',weekday:1,start:'00:00'},[{...e,id:'sun',weekday:0,start:'23:00'}]));
 assert.doesNotThrow(()=>W.validateEntry({...e,id:'next',start:'12:00'},[e]));
});
test('CAPTCHA remains within 20s of Create; open time stays fixed at 60s',()=>{
 const v=H.timingSettings({captchaLead:80,offset:4,late:120}).values;
 assert(v.captchaLead+v.offset<=20);assert(v.captchaLead>=2);
 assert.throws(()=>H.validate({...c,captchaLead:20},H.hkEpoch('2026-11-10','12:00')),/within 20/);
 assert.equal(H.plan(c).release-H.plan(c).openAt,60000);
});
test('typing estimate warns instead of shifting the fixed open/CAPTCHA/Create times',()=>{
 const p=H.plan(c),a=T.plan({...c,uid:'X'.repeat(64),phone:'8'.repeat(40)});
 assert.equal(a.openAt,p.openAt);assert.equal(a.captchaAt,p.captchaAt);assert.equal(a.clickAt,p.clickAt);
 assert(a.typingTarget<a.captchaAt);assert(a.preparationMarginMs<0);
});
test('typing pauses are never compressed even after the scheduled target',()=>{
 let now=0;const normal=T.createPacer(c,20000,{clock:()=>now,rng:()=>.5}),late=T.createPacer(c,100,{clock:()=>now,rng:()=>.5});
 assert.equal(late.next(),normal.next());now=100000;
 for(let i=0;i<T.estimate(c).chars*2+5;i++)assert.equal(late.next(),normal.next());
 assert.equal(late.compressed,false);
});
test('a whole paced sequence remains variable and bounded by worst-case pauses',()=>{
 let total=0,k=0;const p=T.createPacer(c,6000,{rng:()=>((++k*7)%97)/97});const samples=[];
 const n=T.estimate(c).chars*2+6;for(let i=0;i<n;i++){const d=p.next();samples.push(d);total+=d;}
 assert(total<=T.estimate(c).pauses);assert(new Set(samples).size>5);
});
test('booked/uncertain/skipped occurrences are not reminder jobs; next week remains',()=>{
 const now=H.hkEpoch('2026-11-11','11:20'),o=W.occurrence(e,'2026-11-17');
 for(const status of ['success','attempted','unknown','skipped','running'])assert(!W.reminderJobs([e],{[o.key]:{status}},{},now).some(j=>j.key===o.key));
 const jobs=W.reminderJobs([e],{}, {},now);assert(jobs.some(j=>j.key===o.key&&j.alarmAt===o.reminderAt));
 assert(!W.reminderJobs([e],{}, {[o.key]:now},now).some(j=>j.key===o.key));
});
function background(now){
 const store={local:{weeklyEntries:[e]},session:{}},alarms=new Map(),notes=[],opened=[],listeners={};
 const event=n=>({addListener:fn=>{(listeners[n]??=[]).push(fn);}});
 const storage={onChanged:event('storageChanged')};
 for(const area of ['local','session'])storage[area]={
  get:async keys=>{keys=typeof keys==='string'?[keys]:keys||Object.keys(store[area]);return structuredClone(Object.fromEntries(keys.filter(k=>k in store[area]).map(k=>[k,store[area][k]])));},
  set:async data=>Object.assign(store[area],structuredClone(data)),remove:async keys=>{for(const k of typeof keys==='string'?[keys]:keys)delete store[area][k];}
 };
 const chrome={storage,alarms:{getAll:async()=>[...alarms].map(([name,info])=>({name,scheduledTime:info.when,...info})),create:async(name,info)=>alarms.set(name,info),clear:async name=>alarms.delete(name),onAlarm:event('alarm')},notifications:{getPermissionLevel:async()=> 'granted',create:async(id,n)=>{notes.push({id,...n});return id;},clear:async()=>{},onClicked:event('notificationClick')},
 runtime:{getURL:s=>'chrome-extension://test/'+s,onStartup:event('startup'),onInstalled:event('installed'),onMessage:event('message'),sendMessage:async()=>({ok:true})},action:{onClicked:event('action')},
 tabs:{query:async()=>[],create:async p=>{opened.push(p);return {id:1,windowId:1};},update:async()=>({windowId:1})},windows:{create:async p=>{opened.push(p);return {id:1};},update:async()=>{},onRemoved:event('windowRemoved')},debugger:{detach:async()=>{}}};
 class Clock extends Date{static now(){return now;}}
 const context=vm.createContext({chrome,HKU:H,HKUWeekly:W,console,Date:Clock,importScripts:()=>{}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../background.js'),'utf8'),context);
 return {context,store,alarms,notes,opened,listeners,run:async()=>{await context.syncReminders('test');}};
}
test('background creates exact reminder alarms and repairs lost alarms after restart',async()=>{
 const now=H.hkEpoch('2026-11-11','11:00'),b=background(now);await b.run();const o=W.occurrence(e,'2026-11-17');
 assert.equal(b.alarms.get('hku-weekly:'+o.key).when,o.reminderAt);assert.equal(b.notes.length,0);assert.equal(b.opened.length,0);
 b.alarms.clear();await b.run();assert(b.alarms.has('hku-weekly:'+o.key));
});
test('due notification is delivered once and opens only the timetable on click',async()=>{
 const b=background(H.hkEpoch('2026-11-11','11:35'));await b.run();await b.run();assert.equal(b.notes.length,1);assert.equal(b.opened.length,0);
 await b.listeners.notificationClick[0](b.notes[0].id);assert.equal(b.opened.length,1);assert(b.opened[0].url.endsWith('app.html#weekly'));assert(!b.opened[0].url.includes('hkufbs'));
});
test('disabling reminders or deleting a weekly row removes its future alarms',async()=>{
 const b=background(H.hkEpoch('2026-11-11','11:00'));await b.run();assert([...b.alarms.keys()].some(k=>k.startsWith('hku-weekly:')));
 b.store.local.weeklyReminders=false;await b.run();assert(![...b.alarms.keys()].some(k=>k.startsWith('hku-weekly:')));
 b.store.local.weeklyReminders=true;b.store.local.weeklyEntries=[];await b.run();assert(![...b.alarms.keys()].some(k=>k.startsWith('hku-weekly:')));
});
