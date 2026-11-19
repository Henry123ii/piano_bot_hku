"use strict";
const assert=require('node:assert/strict');
const test=require('node:test');
const HKU=require('../shared.js');
function config(){return {roomId:'2871',uid:'123456789',phone:'12345678',people:'1',agreementAccepted:true,date:'2026-11-25',start:'14:00:00',end:'15:00:00',mode:'scheduled',releaseDate:'2026-11-19',releaseTime:'15:00:00',offset:HKU.CREATE_AFTER_RELEASE_SECONDS,captchaLead:HKU.CAPTCHA_BEFORE_RELEASE_SECONDS,late:HKU.FIXED_CAPTCHA_WAIT_SECONDS};}
const now=HKU.hkEpoch('2026-11-18','15:00');
test('release-based targets fixed and independent of stale user preferences',()=>{
 const c=config();assert.equal(HKU.validate(c,now),true);const p=HKU.plan(c);const release=HKU.hkEpoch(c.releaseDate,c.releaseTime);
 assert.equal(p.openAt,release-60000);assert.equal(p.captchaAt,release-10000);assert.equal(p.clickAt,release+200);
 assert.deepEqual(HKU.timingSettings({offset:3,captchaLead:17,late:250}).values,{offset:0.2,captchaLead:10,late:120});
});
test('manual overrides do not pass validation',()=>{
 for(const bad of [{offset:1.5},{captchaLead:5},{late:200}])assert.throws(()=>HKU.validate({...config(),...bad},now),/fixed/);
});
test('one full clock-hour rule retained',()=>{assert.throws(()=>HKU.validate({...config(),end:'15:30'},now),/one full clock hour/);});
