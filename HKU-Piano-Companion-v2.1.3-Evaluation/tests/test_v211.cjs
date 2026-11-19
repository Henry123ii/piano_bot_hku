'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const H=require('../shared.js'),W=require('../schedule.js'),A=require('../auto.js');
const example={id:'regular108',roomId:'2871',weekday:1,start:'14:00',enabled:true};
const date='2026-11-23';const o=W.occurrence(example,date);
test('automatic occurrence releases at slot END minus six days, HKT',()=>{
  assert.equal(H.hkStamp(o.releaseAt).slice(0,19),'2026-11-17 15:00:00');
});
test('login check is exactly 30 min before release; runner exactly 90 s early',()=>{
  const now=o.releaseAt-3*3600000,job=A.jobs([example],{},now-1000,now).find(j=>j.key===o.key);
  assert.ok(job);assert.equal(job.loginAt,o.releaseAt-30*60000);assert.equal(job.startAt,o.releaseAt-90000);
  assert.equal(job.loginAlarm,'hku-auto-login:'+o.key);assert.equal(job.runAlarm,'hku-auto-run:'+o.key);
});
test('already-attempted and unknown weekly occurrences cannot auto-run again',()=>{
  const now=o.releaseAt-2*3600000;
  for(const status of ['running','attempted','success','unknown','pending','skipped','needsAttention','rejected']){
    assert.equal(A.jobs([example],{[o.key]:{status}},now-1000,now).some(x=>x.key===o.key),false,status);
  }
});
test('auto-enabled-after-release never books old occurrences',()=>{
  const now=o.releaseAt-1000;
  assert.equal(A.jobs([example],{},o.releaseAt+1,now).some(x=>x.key===o.key),false);
});
test('start grace permits a modest delay and rejects substantial lateness',()=>{
  const job={startAt:o.releaseAt-A.RUN_LEAD,releaseAt:o.releaseAt};
  assert.equal(A.isStartTimely(job,job.startAt),true);
  assert.equal(A.isStartTimely(job,job.startAt+19999),true);
  assert.equal(A.isStartTimely(job,job.startAt+20001),false);
});
test('manual and automatic booking keep the same Create/CAPTCHA schedule',()=>{
  const p=H.plan({mode:'scheduled',releaseDate:H.hkParts(o.releaseAt).date,releaseTime:H.hkParts(o.releaseAt).time,offset:0.275,captchaLead:10});
  assert.equal(p.openAt,o.releaseAt-60000);
  assert.equal(p.captchaAt,o.releaseAt-10000);
  assert.equal(p.clickAt,o.releaseAt+275);
});
test('weekly recurrence uses next dates with no automatic double booking of same weekday',()=>{
  const now=o.releaseAt-3*3600000,js=A.jobs([example],{},now-1000,now);
  const keys=js.map(j=>j.key);assert.equal(new Set(keys).size,keys.length);
  assert.ok(js.length>=2);
});
