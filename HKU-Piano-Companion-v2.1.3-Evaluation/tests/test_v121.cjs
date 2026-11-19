const test=require('node:test');
const assert=require('node:assert/strict');
const H=require('../shared.js'),T=require('../typing.js'),W=require('../schedule.js');
const c={agreementAccepted:true,roomId:'2871',date:'2026-12-20',start:'14:00',end:'15:00',uid:'SAMPLE-STUDENT',phone:'12345678',people:'1',mode:'scheduled',releaseDate:'2026-12-14',releaseTime:'15:00',early:30,offset:.2,captchaLead:10,late:120};
test('per-character randomized pause always stays at 60-150 ms, never compressed',()=>{
 assert.deepEqual(T.KEY_DELAY,{min:60,max:150});
 const draws=Array.from({length:250},()=>T.randomDelay(T.KEY_DELAY));
 assert(draws.every(n=>n>=60&&n<=150));assert(new Set(draws).size>50);
 const first=T.createPacer(c,1,{clock:()=>1e10,rng:()=>.5}),second=T.createPacer(c,1e10,{clock:()=>0,rng:()=>.5});
 const n=T.estimate(c).chars*2+6;
 for(let i=0;i<n;i++)assert.equal(first.next(),second.next());
});
test('60-second opening lead and typing estimate warning are separate',()=>{
 const p=T.plan(c),e=T.estimate(c);
 assert.equal(e.chars,c.uid.length+c.phone.length+c.people.length);
 assert(e.pauses>=e.chars*150);
 assert.equal(p.release-p.openAt,60000);
 assert.equal(p.preparationMarginMs,p.typingTarget-p.estimatedTypingFinishAt);
 assert(p.typingTarget<p.captchaAt&&p.captchaAt<p.clickAt);
 assert(p.recommendedStartAt<p.openAt);
});
test('longer details change typing warning, not the scheduled opening or Create',()=>{
 const a=T.plan(c),b=T.plan({...c,uid:'X'.repeat(64),phone:'8'.repeat(40)});
 assert.equal(b.openAt,a.openAt);assert.equal(a.captchaAt,b.captchaAt);assert.equal(a.clickAt,b.clickAt);
 assert(b.preparationMarginMs<a.preparationMarginMs);
});
test('individual bookings must be exactly HH:00 to next HH:00, including midnight',()=>{
 const now=H.hkEpoch('2026-11-01','00:00');
 assert.doesNotThrow(()=>H.validate(c,now));
 for(const invalid of [{start:'14:30',end:'15:30'},{start:'14:00',end:'16:00'},{start:'14:00',end:'14:30'},{start:'14:30',end:'15:00'}]){
   assert.throws(()=>H.validate({...c,...invalid},now),/exactly one full clock hour/);
   assert.equal(H.parseReservationURL(H.reservationURL({...c,...invalid})),null);
 }
 const midnight={...c,start:'23:00',end:'00:00'};
 assert.doesNotThrow(()=>H.validate(midnight,now));
 assert.equal(H.parseReservationURL(H.reservationURL(midnight)).endDate,'2026-12-21');
});
test('weekly slots accept whole-hour starts only',()=>{
 const e={id:'weekly-test',roomId:'2871',weekday:3,start:'14:00'};
 assert.doesNotThrow(()=>W.validateEntry(e));
 assert.throws(()=>W.validateEntry({...e,start:'14:15'}),/full clock hour/);
 assert.throws(()=>W.validateEntry({...e,start:'23:30'}),/full clock hour/);
});
