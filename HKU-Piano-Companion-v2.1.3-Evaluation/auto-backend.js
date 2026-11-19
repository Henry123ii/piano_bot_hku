/* Background automation: alarms and one-shot run ownership.
 * An enabled weekly plan authorizes one normal HKU booking attempt per dated
 * occurrence. No CAPTCHA solving, no retry on ambiguity, no sleeping-PC wake.
 */
'use strict';
importScripts('auto.js');
const A=HKUAuto,W=HKUWeekly;
let autoQueue=Promise.resolve();
const enqueue=fn=>{autoQueue=autoQueue.catch(()=>{}).then(fn);return autoQueue;};
const ownedSource=s=>!!s.url&&s.url.startsWith(chrome.runtime.getURL(''));
const prefixLogin='hku-auto-login:',prefixRun='hku-auto-run:';
const resultTitle={success:'HKU booking: success reported',rejected:'HKU booking: rejected',pending:'HKU booking: awaiting approval',unknown:'HKU booking: outcome uncertain',needsAttention:'HKU booking: needs attention',cancelled:'HKU booking: cancelled',tested:'HKU booking: test only'};
async function notifyAuto(id,title,message){
  try{await chrome.notifications.create(id,{type:'basic',iconUrl:'icons/icon128.png',title,message,priority:2,requireInteraction:true});return true;}
  catch{return false;}
}
function keyOf(c){return c.roomId+':'+c.date+':'+HKU.timeValue(c.start).slice(0,5);}
async function changeHistory(key,record){
  if(!key)return;
  const d=await chrome.storage.local.get('weeklyHistory');const h=d.weeklyHistory||{};
  h[key]={...(h[key]||{}),...record,at:Date.now()};
  for(const [k,v]of Object.entries(h))if(v.at<Date.now()-60*W.DAY)delete h[k];
  await chrome.storage.local.set({weeklyHistory:h});
}
async function markMissed(job,why){
  await changeHistory(job.key,{status:'needsAttention',source:'auto',detail:why});
  await notifyAuto('hku-auto-missed:'+job.key,'HKU automatic booking needs attention',
    `${job.date} ${job.start} HKT: ${why}. No Create click was sent. Inspect Scheduled booking.`);
}
async function loadAutoState(now=Date.now()){
  const d=await chrome.storage.local.get(['autoWeeklyEnabled','autoWeeklyEnabledAt','weeklyEntries','weeklyHistory']);
  const enabled=d.autoWeeklyEnabled===true;
  return {enabled,enabledAt:Number(d.autoWeeklyEnabledAt)||0,jobs:enabled?A.jobs(d.weeklyEntries||[],d.weeklyHistory||{},Number(d.autoWeeklyEnabledAt)||now,now):[]};
}
async function reconcileAuto(reason){
  const now=Date.now(),s=await loadAutoState(now),existing=await chrome.alarms.getAll();
  const desired=new Map();
  for(const job of s.jobs){
    if(job.loginAt>now){desired.set(job.loginAlarm,job.loginAt);}
    if(job.startAt>now){desired.set(job.runAlarm,job.startAt);}
  }
  for(const alarm of existing){
    if((alarm.name.startsWith(prefixLogin)||alarm.name.startsWith(prefixRun))&&!desired.has(alarm.name))await chrome.alarms.clear(alarm.name);
  }
  for(const [name,when] of desired){
    const current=existing.find(x=>x.name===name);
    if(!current||Math.abs(current.scheduledTime-when)>1000)await chrome.alarms.create(name,{when});
  }
  if(s.enabled){
    if(!existing.some(x=>x.name==='hku-auto-maintenance'))await chrome.alarms.create('hku-auto-maintenance',{periodInMinutes:1});
  }else await chrome.alarms.clear('hku-auto-maintenance');
  // Recover alarms if Edge restarted, the service worker was suspended, or a
  // new row was saved within the 30-minute check window.
  if(s.enabled){
    for(const job of s.jobs){
      if(job.startAt<=now){
        const {autoRunStarted}=await chrome.storage.local.get('autoRunStarted');
        if(autoRunStarted?.[job.key])continue;
        if(A.isStartTimely(job,now))await autoStart(job);
        else {await markMissed(job,'Edge did not start the preparation window in time');}
      }else if(job.loginAt<=now){
        const d=await chrome.storage.local.get('autoLoginChecks');
        if(!d.autoLoginChecks?.[job.key])await autoLoginCheck(job);
      }
    }
  }
  await chrome.storage.local.set({autoScheduleStatus:{updatedAt:Date.now(),enabled:s.enabled,upcoming:s.jobs.filter(j=>j.startAt>Date.now()).length,reason}});
}
async function probeDashboard(tabId,timeout=10000){
  const until=Date.now()+timeout;
  while(Date.now()<until){
    try{
      const tab=await chrome.tabs.get(tabId);
      if(tab.status==='complete'&&tab.url?.startsWith(HKU.BASE)){
        const reply=await chrome.tabs.sendMessage(tabId,{type:'HKU_PROBE'},{frameId:0});
        if(reply?.authenticated)return true;
        if(reply?.login)return false;
      }
      if(tab.status==='complete'&&!tab.url?.startsWith(HKU.BASE))return false;
    }catch{}
    await new Promise(r=>setTimeout(r,450));
  }
  return false;
}
async function autoLoginCheck(job){
  const d=await chrome.storage.local.get(['autoWeeklyEnabled','weeklyHistory','autoLoginChecks']);
  if(!d.autoWeeklyEnabled||A.BLOCKED.has(d.weeklyHistory?.[job.key]?.status))return;
  const checks=d.autoLoginChecks||{};
  if(checks[job.key])return;
  checks[job.key]={at:Date.now(),status:'checking'};
  await chrome.storage.local.set({autoLoginChecks:checks});
  let w=null,ok=false;
  try{
    w=await chrome.windows.create({url:HKU.BASE+'dashboard.php',type:'normal',focused:false,width:1000,height:760});
    if(!w?.tabs?.[0]?.id)throw Error('Could not open the HKUFBS dashboard.');
    ok=await probeDashboard(w.tabs[0].id);
  }catch(e){checks[job.key]={at:Date.now(),status:'unknown',detail:e.message};}
  if(ok){
    checks[job.key]={at:Date.now(),status:'valid'};
    if(w?.id)try{await chrome.windows.remove(w.id);}catch{}
  }else{
    checks[job.key]={at:Date.now(),status:'loginNeeded',windowId:w?.id||null};
    if(w?.id)try{await chrome.windows.update(w.id,{focused:true,state:'normal',drawAttention:true});}catch{}
    await notifyAuto('hku-auto-login-needed:'+job.key,'HKU login required before automatic booking',
      `${job.date} ${job.start} HKT: finish HKU SSO and 2FA in the opened Edge window. Booking preparation will run near release if the session becomes valid.`);
  }
  await chrome.storage.local.set({autoLoginChecks:checks});
}
async function startRun(c,auto=false){
  HKU.validate(c);
  if(auto && c.dryRun)throw Error('Automatic weekly bookings cannot use test-only mode.');
  const lock=await chrome.storage.session.get('activeRun');
  if(lock.activeRun)throw Error('A booking attempt is already active. No overlapping submission will be started.');
  // Attach a matching weekly occurrence to a manual booking too, so an
  // automatic job for the same dated slot cannot book it again.
  const local=await chrome.storage.local.get(['weeklyEntries','weeklyHistory','bookingAttempts']);
  const occ=W.occurrences(local.weeklyEntries||[]).find(o=>o.key===keyOf(c));
  if(occ && !c.weeklyKey){c={...c,weeklyKey:occ.key,weeklyEntryId:occ.entryId};}
  if(c.weeklyKey){
    const saved=local.weeklyHistory?.[c.weeklyKey]?.status;
    if(A.BLOCKED.has(saved) && !(saved==='manualOnly'&&!auto))throw Error('This weekly occurrence is already handled or attempted. Inspect HKU before another submission.');
  }
  const previous=local.bookingAttempts?.[keyOf(c)];
  if(previous&&['attempted','unknown','success','pending','rejected'].includes(previous.status))
    throw Error('This exact dated slot already has a recorded submission. Inspect My Reservations and resolve it before another attempt.');
  // One lock for the entire extension (manual and automatic). Claim/attempt
  // states are stored separately so refreshing a runner never resubmits.
  const active={id:c.runId,auto,weeklyKey:c.weeklyKey||null,slotKey:keyOf(c),status:'reserved',startedAt:Date.now()};
  await chrome.storage.session.set({activeRun:active,runPayload:{config:c,auto}});
  if(c.weeklyKey)await changeHistory(c.weeklyKey,{status:'running',runId:c.runId,source:auto?'auto':'manual'});
  try{
    const url=chrome.runtime.getURL('runner.html')+'?run='+encodeURIComponent(c.runId);
    const win=await chrome.windows.create({url,type:'normal',focused:!auto,width:1060,height:820});
    if(!win?.id)throw Error('Edge did not open the dedicated booking window.');
    // The runner may claim the run before windows.create resolves. Preserve
    // that claim rather than accidentally resetting it to 'reserved'.
    const current=(await chrome.storage.session.get('activeRun')).activeRun;
    if(!current||current.id!==c.runId)throw Error('The run lock disappeared while creating the booking window.');
    current.runnerWindowId=win.id;
    await chrome.storage.session.set({activeRun:current});
    return {ok:true,windowId:win.id,runId:c.runId};
  }catch(e){
    await chrome.storage.session.remove(['activeRun','runPayload']);
    if(c.weeklyKey)await changeHistory(c.weeklyKey,{status:'needsAttention',runId:c.runId,source:auto?'auto':'manual',detail:e.message});
    throw e;
  }
}
async function autoStart(job){
  const d=await chrome.storage.local.get(['autoWeeklyEnabled','autoWeeklyEnabledAt','weeklyEntries','weeklyHistory','preferences','agreementConsent','autoRunStarted','bookingAttempts']);
  if(!d.autoWeeklyEnabled||job.releaseAt<=(Number(d.autoWeeklyEnabledAt)||0))return;
  if(A.BLOCKED.has(d.weeklyHistory?.[job.key]?.status))return;
  if(d.autoRunStarted?.[job.key])return;
  if(d.bookingAttempts?.[job.key]&&['attempted','unknown','success','pending','rejected'].includes(d.bookingAttempts[job.key].status))return;
  if(!A.isStartTimely(job)){await markMissed(job,'Preparation started too late after the automatic start target');return;}
  const prefs=d.preferences||{};
  if(!prefs.uid||!prefs.phone||prefs.remember!==true&&prefs.remember!=='true'||d.agreementConsent?.accepted!==true){
    await markMissed(job,'Save UID, phone, Remember, and agreement consent in Reservation');return;
  }
  const c={...W.config(job,{},Date.now()),uid:String(prefs.uid).trim(),phone:String(prefs.phone).trim(),people:String(prefs.people||'1'),
    agreementAccepted:true,mode:'scheduled',dryRun:false,offset:HKU.CREATE_AFTER_RELEASE_SECONDS,captchaLead:HKU.CAPTCHA_BEFORE_RELEASE_SECONDS,
    late:HKU.FIXED_CAPTCHA_WAIT_SECONDS,runId:crypto.randomUUID(),weeklyKey:job.key,weeklyEntryId:job.entryId};
  try{
    await startRun(c,true);
    const started=d.autoRunStarted||{};started[job.key]=Date.now();
    for(const [k,v]of Object.entries(started))if(v<Date.now()-60*W.DAY)delete started[k];
    await chrome.storage.local.set({autoRunStarted:started});
  }catch(e){await markMissed(job,e.message);}
}
async function finishRun(m){
  const d=await chrome.storage.session.get('activeRun');const active=d.activeRun;
  if(!active||active.id!==m.runId)throw Error('This run is not active.');
  const outcome=['success','rejected','pending','unknown','needsAttention','cancelled','tested'].includes(m.outcome)?m.outcome:'unknown';
  const local=await chrome.storage.local.get('bookingAttempts');const ledger=local.bookingAttempts||{};
  if(active.status==='attempted'||m.attempted){ledger[active.slotKey]={status:outcome==='needsAttention'?'unknown':outcome,runId:active.id,at:Date.now()};}
  for(const [k,v]of Object.entries(ledger))if(v.at<Date.now()-60*W.DAY)delete ledger[k];
  await chrome.storage.local.set({bookingAttempts:ledger});
  if(active.weeklyKey)await changeHistory(active.weeklyKey,{status:outcome,runId:active.id,source:active.auto?'auto':'manual',detail:String(m.reason||'').slice(0,250)});
  const summary={auto:active.auto,outcome,runId:active.id,at:Date.now(),slotKey:active.slotKey,windowId:active.runnerWindowId||null};
  await chrome.storage.local.set(active.auto?{lastRunSummary:summary,lastAutoRunSummary:summary}:{lastRunSummary:summary});
  await chrome.storage.session.remove(['activeRun','runPayload','typingTabId']);
  if(active.auto){
    const title=resultTitle[outcome]||resultTitle.unknown;
    const detail=outcome==='success'?'HKU reported success. Verify My Reservations.':outcome==='rejected'?'HKU rejected the request. See the booking window.':outcome==='pending'?'HKU indicates approval may be required.':outcome==='tested'?'No Create click was sent.':'Check the booking window and My Reservations before retrying.';
    await notifyAuto('hku-auto-result:'+active.id,title,`${active.slotKey.replaceAll(':',' ')}. ${detail}`);
  }
  return {ok:true};
}
function backgroundRequest(m,s,reply){
  const kinds=['HKU_START_MANUAL','HKU_CLAIM_RUN','HKU_RUN_ATTEMPT','HKU_RUN_FINISHED','HKU_AUTO_SYNC'];
  if(!kinds.includes(m?.type))return;
  if(!ownedSource(s)){reply({ok:false,error:'Only companion extension windows may start or complete bookings.'});return;}
  enqueue(async()=>{
    switch(m.type){
      case 'HKU_START_MANUAL':{
        if(!s.url.includes('/app.html'))throw Error('Manual confirmation must come from the companion.');
        const c=m.config;
        if(!c||typeof c.runId!=='string')throw Error('Invalid booking details.');
        return await startRun(c,false);
      }
      case 'HKU_CLAIM_RUN':{
        if(!s.url.includes('/runner.html'))throw Error('Only the dedicated booking window can claim this run.');
        const d=await chrome.storage.session.get('activeRun'),a=d.activeRun;
        if(!a||a.id!==m.runId)throw Error('The booking run is not armed.');
        if(a.status!=='reserved')return {ok:true,alreadyClaimed:true};
        a.status='running';await chrome.storage.session.set({activeRun:a});return {ok:true,alreadyClaimed:false};
      }
      case 'HKU_RUN_ATTEMPT':{
        if(!s.url.includes('/runner.html'))throw Error('Only a booking window may submit.');
        const d=await chrome.storage.session.get('activeRun'),a=d.activeRun;
        if(!a||a.id!==m.runId||a.status!=='running')throw Error('Run already submitted or no longer active.');
        a.status='attempted';a.attemptedAt=Date.now();await chrome.storage.session.set({activeRun:a});
        if(a.weeklyKey)await changeHistory(a.weeklyKey,{status:'attempted',runId:a.id,source:a.auto?'auto':'manual'});
        return {ok:true};
      }
      case 'HKU_RUN_FINISHED':{
        if(!s.url.includes('/runner.html'))throw Error('Only the booking window can report its result.');
        return await finishRun(m);
      }
      case 'HKU_AUTO_SYNC':await reconcileAuto('panel');return {ok:true};
    }
  }).then(value=>reply(value||{ok:true})).catch(e=>reply({ok:false,error:e.message}));
  return true;
}
chrome.runtime.onMessage.addListener(backgroundRequest);
chrome.alarms.onAlarm.addListener(a=>{
  if(a.name==='hku-auto-maintenance')enqueue(()=>reconcileAuto('maintenance')).catch(console.warn);
  else if(a.name.startsWith(prefixLogin)||a.name.startsWith(prefixRun)){
    enqueue(async()=>{
      const state=await loadAutoState();const key=a.name.slice((a.name.startsWith(prefixLogin)?prefixLogin:prefixRun).length);
      const job=A.find(state.jobs,key);
      if(!state.enabled||!job)return;
      if(a.name.startsWith(prefixLogin))await autoLoginCheck(job);
      else await autoStart(job);
      await reconcileAuto('alarm');
    }).catch(console.warn);
  }
});
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==='local'&&(changes.autoWeeklyEnabled||changes.autoWeeklyEnabledAt||changes.weeklyEntries||changes.weeklyHistory||changes.preferences||changes.agreementConsent)){
    enqueue(()=>reconcileAuto('changed')).catch(console.warn);
  }
});
chrome.runtime.onStartup.addListener(()=>{
  enqueue(async()=>{
    // A browser restart clears session locks. Any old in-flight attempt is
    // unknown; never silently retry or treat it as success.
    const d=await chrome.storage.local.get(['weeklyHistory','bookingAttempts']);const h=d.weeklyHistory||{};
    let changed=false;
    for(const [k,v]of Object.entries(h))if(v.status==='running'){
      h[k]={...v,status:'needsAttention',detail:'Edge restarted during preparation; inspect HKU.',at:Date.now()};changed=true;
    }
    if(changed)await chrome.storage.local.set({weeklyHistory:h});
    await reconcileAuto('startup');
  }).catch(console.warn);
});
chrome.runtime.onInstalled.addListener(()=>enqueue(()=>reconcileAuto('installed')).catch(console.warn));
chrome.windows.onRemoved.addListener(id=>{
  enqueue(async()=>{
    const d=await chrome.storage.session.get('activeRun'),a=d.activeRun;
    if(!a||a.runnerWindowId!==id)return;
    const outcome=a.status==='attempted'?'unknown':'needsAttention';
    if(a.weeklyKey)await changeHistory(a.weeklyKey,{status:outcome,source:a.auto?'auto':'manual',detail:'Dedicated booking window closed or crashed; no retry will occur.',runId:a.id});
    if(a.status==='attempted'){
      const d=await chrome.storage.local.get('bookingAttempts');const ledger=d.bookingAttempts||{};
      ledger[a.slotKey]={status:'unknown',runId:a.id,at:Date.now()};await chrome.storage.local.set({bookingAttempts:ledger});
    }
    await chrome.storage.session.remove(['activeRun','runPayload','typingTabId']);
    if(a.auto)await notifyAuto('hku-auto-result:'+a.id,'HKU automatic booking interrupted',
      'The booking window was closed before its result was recorded. Inspect HKU My Reservations; no automatic retry will occur.');
  }).catch(console.warn);
});
chrome.notifications.onClicked.addListener(id=>{
  if(!id.startsWith('hku-auto-')&&!id.startsWith('hku-run-'))return;
  enqueue(async()=>{
    try{
      if(id.startsWith('hku-auto-login-needed:')){
        const key=id.slice('hku-auto-login-needed:'.length);
        const d=await chrome.storage.local.get('autoLoginChecks');const w=d.autoLoginChecks?.[key]?.windowId;
        if(w){await chrome.windows.update(w,{focused:true,state:'normal'});return;}
        await chrome.windows.create({url:HKU.BASE+'dashboard.php',type:'normal',focused:true});return;
      }
      const d=await chrome.storage.session.get(['activeRun','bookingTabId']);
      if(id.includes('captcha')||id.includes('login')){
        if(d.bookingTabId){const t=await chrome.tabs.update(d.bookingTabId,{active:true});await chrome.windows.update(t.windowId,{focused:true,state:'normal'});return;}
      }
      const last=await chrome.storage.local.get(['lastRunSummary','lastAutoRunSummary']);
      const w=id.startsWith('hku-auto-result:')?last.lastAutoRunSummary?.windowId:(d.activeRun?.runnerWindowId||last.lastRunSummary?.windowId);
      if(w){await chrome.windows.update(w,{focused:true,state:'normal'});return;}
      await openPanel();
    }catch{await openPanel();}
  }).catch(console.warn);
});
enqueue(()=>reconcileAuto('worker-start')).catch(console.warn);
