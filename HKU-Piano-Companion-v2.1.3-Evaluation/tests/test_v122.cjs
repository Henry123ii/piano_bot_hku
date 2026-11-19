const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const H=require('../shared.js');
const T=require('../typing.js');
const c={agreementAccepted:true,roomId:'2871',date:'2027-01-20',start:'14:00',end:'15:00',uid:'TEST-STUDENT',phone:'12345678',people:'1',mode:'scheduled',releaseDate:'2027-01-14',releaseTime:'15:00:00',offset:.2,captchaLead:10,late:120};
const release=H.hkEpoch(c.releaseDate,c.releaseTime);
test('opening is exactly 60 seconds before the release timestamp regardless of offset',()=>{
 for(const offset of [0,.001,.05,.2,.275,.8,1.125,4.987,5]){
   const p=T.plan({...c,offset});
   assert.equal(p.release,release);
   assert.equal(p.openAt,release-60000);
   assert.equal(p.captchaAt,release-10000);
   assert.equal(p.clickAt,release+Math.round(offset*1000));
   assert(p.typingTarget<p.captchaAt&&p.captchaAt<p.clickAt);
 }
});
test('50ms rounding is removed: offsets are preserved to a millisecond',()=>{
 for(const x of [.017,.123,.275,.999,1.111,3.009]){
   const s=H.timingSettings({...c,offset:x}).values;
   assert.equal(s.offset,x);
   assert.equal(H.plan({...c,...s}).clickAt,release+Math.round(x*1000));
 }
});
test('changing offset cannot change opening, CAPTCHA or release (even with old saved early setting)',()=>{
 const baseline=T.plan({...c,early:15}),other=T.plan({...c,early:280,offset:1.85});
 for(const key of ['release','openAt','captchaAt','typingTarget','recommendedStartAt'])assert.equal(other[key],baseline[key],key);
 assert.equal(other.clickAt-baseline.clickAt,1650);
});
test('form has no opening lead input; offset input accepts 1ms steps',()=>{
 const html=fs.readFileSync(path.join(__dirname,'..','app.html'),'utf8');
 const script=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
 assert(!html.includes('id="early"'));
 assert(!script.includes('$("early")'));
 assert.match(html,/id="offset"[^>]+step="0\.001"/);
});
test('CAPTCHA remains before release and no more than 20s ahead of Create',()=>{
 const settings=H.timingSettings({...c,offset:4.987,captchaLead:19.8}).values;
 assert(settings.captchaLead+settings.offset<=20.000001);
 assert(H.validate({...c,...settings},H.hkEpoch('2027-01-01','12:00')));
});
