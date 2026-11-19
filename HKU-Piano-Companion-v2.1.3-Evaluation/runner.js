/* Dedicated booking-window controller. Runs independently of the companion UI.
 * All UI and session state are extension-local; HKU receives only the normal form.
 * Each run is claimed once in the background worker, never restarted after a crash.
 */
'use strict';
const $=id=>document.getElementById(id);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const getParam=new URL(location.href).searchParams;
const runId=getParam.get('run');
let config=null,auto=false,run=null,windowId=null,portalTabId=null,bookingTabId=null,logs=[],lastResult=null,logWrite=Promise.resolve();
const visible=(id,yes=true)=>{$(id).hidden=!yes;};
function log(message){
  const line=`[${HKU.hkStamp()}] ${message}`;
  logs.push(line);logs=logs.slice(-350);$('log').textContent=logs.join('\n');$('log').scrollTop=$('log').scrollHeight;
  const snapshot=[...logs];logWrite=logWrite.catch(()=>{}).then(()=>chrome.storage.local.set({progressLog:snapshot}));
}
function stage(title,description,percent){$('stage').textContent=title;$('stageDetail').textContent=description;$('progressBar').style.width=`${percent}%`;}
function warning(message){$('runnerFlash').textContent=message;visible('runnerFlash',true);}
function checkAbort(){if(run?.cancelled)throw Error('Attempt cancelled before submission. No Create click was sent.');}
async function worker(type,data={}){
  const response=await chrome.runtime.sendMessage({type,runId,...data});
  if(!response?.ok)throw Error(response?.error||`Background service did not complete ${type}.`);
  return response;
}
async function openInBookingWindow(url){
  if(!Number.isInteger(windowId))throw Error('Booking window is missing.');
  const tab=await chrome.tabs.create({windowId,url,active:false});
  return tab.id;
}
async function focusTab(id=bookingTabId||portalTabId){
  if(!id)throw Error('The HKU booking page is not open yet.');
  const tab=await chrome.tabs.update(id,{active:true});
  const w=await chrome.windows.get(tab.windowId);
  await chrome.windows.update(tab.windowId,{focused:true,drawAttention:true,...(w.state==='minimized'?{state:'normal'}:{})});
}
async function message(tabId,type,data={}){
  const result=await chrome.tabs.sendMessage(tabId,{type,...data},{frameId:0});
  if(!result)throw Error('The HKU page helper is not available yet.');
  if(!result.ok)throw Error(result.error||'The HKU page rejected the operation.');
  return result;
}
async function probe(tabId){
  const tab=await chrome.tabs.get(tabId);
  if(tab.status!=='complete')return null;
  if(!tab.url?.startsWith(HKU.BASE))return {login:true,authenticated:false,external:true};
  try{return await message(tabId,'HKU_PROBE');}catch{return null;}
}
async function notifyUser(kind,title,text,focus=false){
  const id='hku-run-'+kind+':'+runId;
  try{await chrome.notifications.create(id,{type:'basic',iconUrl:'icons/icon128.png',title,message:text,priority:2,requireInteraction:true});}
  catch{log('System notification could not be displayed. Please check the booking window.');}
  if(focus){try{await focusTab();}catch{}}
}
async function waitUntil(at){
  while(Date.now()<at){checkAbort();const sec=Math.max(0,Math.ceil((at-Date.now())/1000));$('countdown').textContent=sec>=3600?`${Math.floor(sec/3600)}h ${Math.floor(sec%3600/60)}m`:`${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;await delay(Math.min(220,Math.max(1,at-Date.now())));}
  checkAbort();
}
async function ensureLogin(){
  stage('Checking the HKU session','Validating the authenticated HKUFBS dashboard.',8);
  log('Checking HKUFBS login again before this booking.');
  portalTabId=await openInBookingWindow(HKU.BASE+'dashboard.php');
  const deadline=Date.now()+180000;let prompted=false;
  while(Date.now()<deadline){
    checkAbort();const p=await probe(portalTabId);
    if(p?.authenticated){log('HKUFBS session is authenticated.');return;}
    if((p?.login||p?.external)&&!prompted){
      prompted=true;stage('HKU login required','Finish HKU SSO and 2FA in the dedicated booking window.',12);
      log('Session expired or HKU SSO is required. User must log in.');
      await notifyUser('login','HKU login needed','Complete HKU SSO and 2FA in the booking window. The attempt will continue once authenticated.',true);
      await focusTab(portalTabId);
    }
    await delay(550);
  }
  throw Error('HKU login could not be verified within three minutes. No Create click was sent.');
}
async function waitForForm(){
  let prompted=false,returned=false;const deadline=Date.now()+180000;
  while(Date.now()<deadline){
    checkAbort();const p=await probe(bookingTabId);
    if(p?.form)return;
    if((p?.login||p?.external)&&!prompted){
      prompted=true;stage('Login required on reservation page','Sign in on the dedicated booking tab.',35);
      await notifyUser('login','HKU login needs renewal','Please complete HKU login on the reservation tab.',true);
    }
    if(prompted&&p?.authenticated&&!p.form&&!returned){returned=true;await chrome.tabs.update(bookingTabId,{url:HKU.reservationURL(config)});}
    await delay(280);
  }
  throw Error('The reservation form was not available within three minutes. Check the open HKU tab; no Create click was sent.');
}
async function requestCaptcha(){
  try{
    const reply=await chrome.tabs.sendMessage(bookingTabId,{type:'HKU_CAPTCHA_CLICK'});
    log(reply?.clicked?'Requested the reCAPTCHA checkbox click.':reply?.alreadyChecked?'CAPTCHA checkbox already checked.':'Checkbox could not be clicked automatically; manual action may be needed.');
  }catch{log('Checkbox helper did not respond. Manual CAPTCHA may be needed.');}
}
async function alertCaptcha(){
  const text='Google requires a manual CAPTCHA check. Open the booking tab and solve the challenge; no submission occurs without verification.';
  visible('captchaBanner');$('captchaText').textContent=text;
  log(text);stage('Your CAPTCHA action is needed',text,60);
  await notifyUser('captcha','HKU booking: solve CAPTCHA',text,true);
}
async function awaitReady(plan){
  let requested=false,requestAt=0,prompted=false,previousVerified=false;
  if(config.mode==='now'){
    plan.release=Date.now();plan.captchaAt=Date.now();plan.clickAt=plan.release+Math.round(config.offset*1000);
  }
  const expiresAt=Math.max(plan.clickAt,Date.now())+Math.max(5,config.late)*1000;
  if(Date.now()>plan.captchaAt && config.mode==='scheduled')log('CAPTCHA target passed while preparing. Completing typing first; requesting CAPTCHA now.');
  if(Date.now()<plan.captchaAt){
    stage('Waiting for CAPTCHA','Typing completed. CAPTCHA will be requested automatically.',53);
    await waitUntil(plan.captchaAt);
  }
  checkAbort();if(!run.typingFinishedAt)throw Error('Typing has not completed. CAPTCHA cannot be requested.');
  requested=true;requestAt=Date.now();
  log('CAPTCHA requested after all fields were typed and verified.');
  await requestCaptcha();
  while(true){
    checkAbort();const s=await message(bookingTabId,'HKU_STATUS');
    if(s.login)throw Error('The HKU session expired while preparing. No Create click was sent.');
    if(!s.form)throw Error('The reservation form disappeared. No Create click was sent.');
    if(!s.typing?.complete||s.typing.runId!==config.runId)throw Error('Fresh typing receipt was lost or the page reloaded. No Create click was sent.');
    const cap=s.captcha,verified=!cap.present||(cap.verified&&!cap.challenge);
    if(verified){
      visible('captchaBanner',false);previousVerified=cap.verified;
      if(!run.readyLogged){log(cap.present?'A nonempty CAPTCHA response is present; HKU will verify it on submission.':'No CAPTCHA widget was detected.');run.readyLogged=true;}
      if(config.dryRun)return {rehearsal:true};
      if(s.createEnabled){stage('Ready for Create','Form and verification are ready. Submission is scheduled automatically.',74);return {rehearsal:false};}
      stage('Waiting for HKU Create button','Form is prepared, but Create is still disabled.',72);
    }else{
      if(previousVerified){previousVerified=false;prompted=false;run.readyLogged=false;log('CAPTCHA verification expired or disappeared.');}
      if((cap.challenge||cap.expired||(requested&&Date.now()-requestAt>2500))&&!prompted){prompted=true;await alertCaptcha();}
    }
    if(Date.now()>expiresAt)throw Error('CAPTCHA or Create was not ready within the allowed window. No Create click was sent.');
    await delay(140);
  }
}
async function showResult(result,heading){
  lastResult={...result,at:Date.now()};
  $('resultText').textContent=result.text||'No definitive site response was captured. Check My Reservations before retrying.';
  $('resultMeta').textContent=[heading,result.source,result.status!=null?`HTTP ${result.status} (not booking proof)`:null].filter(Boolean).join(' | ');
  $('rawResponse').textContent=result.raw||'';visible('rawDetails',!!result.raw);visible('resultSection');
  await chrome.storage.local.set({lastResult:{...lastResult,raw:''}});
}
async function collectResult(){
  stage('Create attempted — awaiting HKU','The request will not be repeated. Inspect the HKU page if the outcome is unclear.',88);
  const deadline=Date.now()+25000;let latest=null;
  while(Date.now()<deadline){
    try{
      const s=await message(bookingTabId,'HKU_STATUS');
      if(s.login)throw Error('A login screen appeared after Create; the outcome is unknown.');
      if(s.result?.text){latest=s.result;await delay(600);try{const newer=await message(bookingTabId,'HKU_STATUS');if(newer.result?.text)latest=newer.result;}catch{}break;}
    }catch(e){if(/outcome is unknown/i.test(e.message))break;}
    await delay(340);
  }
  if(!latest){
    const text='No recognizable booking response was captured within 25 seconds. The request may have succeeded. Check My Reservations before any retry.';
    stage('Outcome unconfirmed',text,100);log(text);
    await showResult({text,source:'Companion diagnostic'},'Unknown outcome');
    return 'unknown';
  }
  const outcome=HKU.classify(latest.text);
  const titles={success:'HKU reports success',rejected:'HKU reports rejection',pending:'Awaiting approval',response:'Response received — verify in HKU'};
  const title=titles[outcome]||titles.response;
  stage(title,'Read the exact HKU message and verify your reservation in the portal.',100);
  log(`${title}. No retry was attempted.`);
  await showResult({text:latest.text,source:latest.source,status:latest.network?.status,raw:latest.network?.body||''},title);
  return outcome==='response'?'unknown':outcome;
}
async function finish(outcome,reason=''){
  const final=outcome||'needsAttention';
  try{await worker('HKU_RUN_FINISHED',{outcome:final,reason,attempted:!!run?.attempted});}
  catch(e){log(`Could not finalize background status: ${e.message}. Check the booking history before retrying.`);}
  $('cancelRun').disabled=true;
  if(auto)log('Automatic attempt complete. A result notification was requested.');
  try{if(bookingTabId)await chrome.tabs.update(bookingTabId,{autoDiscardable:true});}catch{}
}
async function execute(){
  if(!config)throw Error('Booking details were not loaded.');
  HKU.validate(config);
  const response=await worker('HKU_CLAIM_RUN');
  if(response.alreadyClaimed)throw Error('This run was already started. The extension will not automatically restart it after a reload. Check the booking history.');
  run={id:runId,attempted:false,cancelled:false,readyLogged:false};
  const plan=HKUTyping.plan(config);
  log(`${auto?'AUTOMATIC WEEKLY':'CONFIRMED MANUAL'} ${config.dryRun?'TEST':'LIVE'} booking: ${HKU.ROOMS.find(r=>r.id===config.roomId).name}, ${config.date} ${config.start}-${config.end} HKT.`);
  let finalOutcome='needsAttention',reason='';
  try{
    await ensureLogin();
    checkAbort();
    if(Date.now()>=HKU.hkEpoch(config.date,config.start))throw Error('The room session has already begun; no booking was attempted.');
    log('Reservation preparation and submission are scheduled automatically.');
    stage('Waiting for form opening',`Form opening: ${HKU.hkStamp(plan.openAt)}.`,27);
    await waitUntil(plan.openAt);
    stage('Loading reservation form','A dedicated HKU tab is opening in this Edge window.',35);
    bookingTabId=await openInBookingWindow(HKU.reservationURL(config));
    await chrome.storage.session.set({bookingTabId});
    try{await chrome.tabs.update(bookingTabId,{autoDiscardable:false});}catch{}
    await waitForForm();checkAbort();
    try{await chrome.scripting.executeScript({target:{tabId:bookingTabId},world:'MAIN',files:['response-bridge.js']});}
    catch{log('Network response capture is unavailable. Visible HKU response text will still be read.');}
    stage('Freshly typing booking details','Clearing and retyping all three fields; leave the HKU tab untouched.',43);
    await HKUTyping.fill(config,{tabId:bookingTabId,guard:checkAbort,typingTarget:plan.typingTarget,
      message:async(...args)=>{checkAbort();const res=await message(...args);checkAbort();return res;},
      sleep:async(ms)=>{checkAbort();await delay(ms);checkAbort();},progress:log});
    checkAbort();run.typingFinishedAt=Date.now();
    log(`Fresh typing completed at ${HKU.hkStamp(run.typingFinishedAt)}. Fields and agreement verified; keyboard detached.`);
    if(config.mode==='scheduled'&&run.typingFinishedAt>plan.typingTarget)log('Typing missed its preferred pre-CAPTCHA buffer; continuing after a warning, never skipping characters.');
    stage('Form prepared','Waiting for CAPTCHA and Create.',53);
    const ready=await awaitReady(plan);checkAbort();
    if(ready.rehearsal){finalOutcome='tested';stage('Test complete','No Create click was sent.',100);log('TEST ONLY: no booking request was made.');return;}
    if(Date.now()<plan.clickAt){stage('Waiting for submission','Sending one Create attempt at its scheduled time.',79);await waitUntil(plan.clickAt);}
    checkAbort();if(Date.now()>=HKU.hkEpoch(config.date,config.start))throw Error('Room session already started. No Create click sent.');
    // Mark the attempt BEFORE requesting the single click, so navigation or a
    // lost acknowledgement cannot trigger a duplicate on restart.
    await worker('HKU_RUN_ATTEMPT');run.attempted=true;$('cancelRun').disabled=true;
    const sentAt=Date.now();log('Sending one Create attempt; awaiting the HKU response.');
    try{const reply=await message(bookingTabId,'HKU_SUBMIT',{config});
      if(reply?.clicked)log('HKU helper dispatched Create (not yet confirmation).');
      if(reply?.alreadySubmitted)log('Existing attempted submission detected; not clicking again.');
    }catch(e){log(`Create acknowledgement: ${e.message}. The outcome is uncertain; no second click will be sent.`);}
    $('countdown').textContent='SENT';
    finalOutcome=await collectResult();
  }catch(e){
    reason=e.message;finalOutcome=run.attempted?'unknown':run.cancelled?'cancelled':'needsAttention';
    stage(run.cancelled?'Attempt cancelled':run.attempted?'Submission needs inspection':'Stopped before submission',reason,100);
    warning(run.attempted?`${reason} Check My Reservations; no second click will be sent.`:reason);
    log(reason);$('countdown').textContent='STOP';
  }finally{
    visible('captchaBanner',false);
    await finish(finalOutcome,reason);
  }
}
$('showBooking').addEventListener('click',()=>focusTab().catch(e=>warning(e.message)));
$('solveCaptcha').addEventListener('click',()=>focusTab().catch(e=>warning(e.message)));
$('cancelRun').addEventListener('click',()=>{
  if(run&&!run.attempted){run.cancelled=true;$('cancelRun').disabled=true;log('Cancellation requested. No new Create click will be sent.');}
});
$('exportLog').addEventListener('click',()=>{
  const url=URL.createObjectURL(new Blob([logs.join('\n')+(lastResult?'\n\nHKU RESPONSE:\n'+lastResult.text:'')],{type:'text/plain;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download='HKU-booking-'+(config?.date||'log')+'.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);
});
(async()=>{
  try{
    if(!runId||!/^[a-f0-9-]{30,40}$/i.test(runId))throw Error('No valid run ID was provided to the booking window.');
    const state=await chrome.storage.session.get(['runPayload','activeRun']);
    if(state.runPayload?.config?.runId!==runId||state.activeRun?.id!==runId)throw Error('This booking is no longer armed. A stale or reloaded window cannot restart an attempt.');
    config=state.runPayload.config;auto=state.runPayload.auto===true;
    const room=HKU.ROOMS.find(r=>r.id===config.roomId)?.name||'Room';
    $('modeBadge').textContent=auto?'AUTOMATIC WEEKLY':'CONFIRMED MANUAL';
    $('runnerHeading').textContent=config.dryRun?'Test run — no Create click':'Booking in progress';
    $('runnerSummary').textContent=`${room} · ${config.date} · ${config.start}-${config.end} HKT · ${auto?'automatic weekly':'confirmed one-off'}.`;
    const here=await chrome.tabs.getCurrent();windowId=here.windowId;
    await execute();
  }catch(e){
    stage('Booking not started',e.message,100);warning(e.message);$('cancelRun').disabled=true;
    log(e.message);
    // If startup failed before the one-time claim, release the lock.
    // Never clear a running/attempted claim from a reloaded page.
    try{
      const d=await chrome.storage.session.get('activeRun');
      if(d.activeRun?.id===runId&&d.activeRun.status==='reserved')
        await worker('HKU_RUN_FINISHED',{outcome:'needsAttention',reason:e.message,attempted:false});
    }catch{}
  }
})();
