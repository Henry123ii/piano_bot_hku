"use strict";
const $=id=>document.getElementById(id);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const formKeys=["room","date","start","end","people","uid","phone","releaseDate","releaseTime","mode","remember","autoRelease"];
let weeklySelection=null, prefsWrite=Promise.resolve(), prefsTimer=null;
let currentRun=null, preparedConfig=null, portalTabId=null, calendarTabId=null, bookingTabId=null;
let logs=[], lastResult=null, loginWatch=0, logWrite=Promise.resolve();
const show=(id,yes=true)=>{$(id).hidden=!yes;};
function flash(text){$("flash").textContent=text;show("flash",!!text);}
function log(text){
  logs.push(`[${HKU.hkStamp()}] ${text}`);logs=logs.slice(-350);
  $("log").textContent=logs.join("\n");$("log").scrollTop=$("log").scrollHeight;
  const copy=[...logs];logWrite=logWrite.then(()=>chrome.storage.local.set({progressLog:copy})).catch(()=>{});
}
function stage(title,detail,progress){
  $("stage").textContent=title;$("stageDetail").textContent=detail;
  $("progressBar").style.width=`${progress}%`;show("progressSection");
}
function badge(text,good=false){$("loginBadge").textContent=text;$("loginBadge").classList.toggle("good",good);}
function readConfig(){
  const c={roomId:$("room").value,date:$("date").value,start:$("start").value,end:$("end").value,
    people:$("people").value,uid:$("uid").value.trim(),phone:$("phone").value.trim(),mode:$("mode").value,
    releaseDate:$("releaseDate").value,releaseTime:$("releaseTime").value,
    offset:HKU.CREATE_AFTER_RELEASE_SECONDS,captchaLead:HKU.CAPTCHA_BEFORE_RELEASE_SECONDS,late:HKU.FIXED_CAPTCHA_WAIT_SECONDS,
    agreementAccepted:$("agreement").checked,dryRun:$("dryRun").checked,runId:crypto.randomUUID()};
  if(weeklySelection && weeklySelection.roomId===c.roomId && weeklySelection.date===c.date && weeklySelection.start===c.start && weeklySelection.end===c.end){
    c.weeklyKey=weeklySelection.key;c.weeklyEntryId=weeklySelection.entryId;
  }
  return c;
}
function normalizeTimingInputs(announce=false){
  // Fixed edition: all submission and CAPTCHA timing values are presets.
  timingPreview();
}
function updateRelease(){
  const automatic=$("autoRelease").checked,now=$("mode").value==="now";
  $("releaseDate").disabled=now||automatic;$("releaseTime").disabled=now||automatic;
  if(automatic){
    try{
      const c=readConfig(),r=HKU.hkParts(HKU.hkEpoch(HKU.endDate(c),c.end)-6*86400000);
      $("releaseDate").value=r.date;$("releaseTime").value=r.time;
    }catch{}
  }
  timingPreview();
}
function timingPreview(){
  if(!$("timingPreview"))return;
  try{
    const c=readConfig(),p=HKUTyping.plan(c);
    $("timingPreview").textContent=c.mode==="now"?"Prepare now: finish all typing first, then request CAPTCHA and submit once ready. No early booking attempt is scheduled.":
      `Release: ${HKU.hkStamp(p.release)} | Form preparation and submission will be handled automatically. `+
      `Start and confirm by approximately ${HKU.hkStamp(p.recommendedStartAt)} to leave room for login. `+
      (p.preparationMarginMs<0?"Warning: lengthy input or slow loading could exceed the 60-second preparation window; typing always finishes before CAPTCHA is requested. ":"")+
      (p.release<Date.now()?"Release already passed; after confirmation this attempt prepares immediately.":"Booking is scheduled using this edition's built-in timing.");
  }catch{$("timingPreview").textContent="Choose a valid booking date and time to preview the sequence.";}
}
async function savePrefs(){
  const prefs={};for(const id of formKeys)prefs[id]=$(id).type==="checkbox"?$(id).checked:$(id).value;
  if(!$("remember").checked){prefs.uid="";prefs.phone="";}
  prefsWrite=prefsWrite.catch(()=>{}).then(()=>chrome.storage.local.set({preferences:prefs}));
  return prefsWrite;
}
function busy(yes){
  $("settings").disabled=yes;$("confirmBtn").disabled=yes;$("portalBtn").disabled=yes;$("clearBtn").disabled=yes;
  $("cancelBtn").disabled=!yes;
  if($("weeklySettings"))$("weeklySettings").disabled=yes;
  window.HKUPlanner?.render();
}
function checkAbort(run){if(run.cancelled)throw Error("Cancelled. No further automated Create click will be sent.");}
async function openSite(url,focused=true){
  const wins=await chrome.windows.getAll({windowTypes:["normal"]});
  let tab;
  if(wins.length){const w=wins.find(w=>w.focused)||wins[0];tab=await chrome.tabs.create({windowId:w.id,url,active:true});if(focused)await chrome.windows.update(w.id,{focused:true});}
  else{const w=await chrome.windows.create({url,type:"normal",width:1150,height:850,focused});tab=w.tabs[0];}
  return tab.id;
}
async function focusTab(id=bookingTabId||portalTabId||calendarTabId){
  if(!id)throw Error("No HKU tab has been opened yet.");
  const tab=await chrome.tabs.update(id,{active:true});
  const w=await chrome.windows.get(tab.windowId);
  await chrome.windows.update(tab.windowId,{focused:true,drawAttention:true,...(w.state==="minimized"?{state:"normal"}:{})});
}
async function message(tabId,type,data={}){
  const reply=await chrome.tabs.sendMessage(tabId,{type,...data},{frameId:0});
  if(!reply)throw Error("The HKU page has not loaded the extension helper yet. Reload the HKU tab.");
  if(!reply.ok)throw Error(reply.error||"The page helper reported an error.");
  return reply;
}
async function probe(tabId){
  const tab=await chrome.tabs.get(tabId);
  if(tab.status!=="complete")return null;
  if(!tab.url?.startsWith(HKU.BASE))return {authenticated:false,login:true,external:true,url:tab.url||""};
  try{return await message(tabId,"HKU_PROBE");}catch{return null;}
}
async function notify(title,text,id){
  try {await chrome.notifications.create(`hku-${id}`,{type:"basic",iconUrl:"icons/icon128.png",title,message:text,priority:2,requireInteraction:true});}
  catch {log("System notification was unavailable. The companion banner and booking tab remain available.");}
  try{await focusTab();}catch{}
}
async function ensureLogin(run){
  stage("Checking your HKU session","Opening the actual dashboard to validate your current Edge login.",8);
  log("Validating the current Edge session against the HKUFBS dashboard.");
  portalTabId=await openSite(HKU.BASE+"dashboard.php");
  let notified=false,last=null;
  const deadline=Date.now()+180000;
  while(Date.now()<deadline){
    checkAbort(run);last=await probe(portalTabId);
    if(last?.authenticated){badge("HKU session valid",true);log("Authenticated HKUFBS page detected. Session check passed.");return;}
    if(last?.login&&!notified){
      notified=true;badge("Login required");
      stage("Please sign in","Finish HKU SSO and 2FA in the portal tab. This attempt waits for you; no password is collected.",8);
      log("Session is missing or expired. Complete SSO/2FA in the portal tab.");
      await notify("HKU login required","Complete SSO and 2FA in the HKU portal tab.",run.id+"-login");
      await focusTab(portalTabId);
    }
    await delay(600);
  }
  throw Error(last?.login?"HKU login was not completed within three minutes. No submission was made.":"The page did not expose recognized authenticated HKUFBS controls. Check the portal tab; no submission was made.");
}
async function loginOnly(){
  const token=++loginWatch;flash("");badge("Waiting for login");
  try{
    portalTabId=await openSite(HKU.BASE+"dashboard.php");
    flash("Complete HKU SSO and 2FA in the portal tab. This window will detect the dashboard automatically.");
    for(let i=0;i<300 && loginWatch===token;i++){
      const p=await probe(portalTabId);
      if(p?.authenticated){badge("HKU session valid",true);flash("Login detected. Return to Reservation to select and prepare your booking.");return;}
      await delay(1000);
    }
    if(loginWatch===token)flash("Login has not been confirmed. Finish signing in, then click Portal login again to check.");
  }catch(e){badge("Login not checked");flash(e.message);}
}
async function waitUntil(at,run){
  while(Date.now()<at){checkAbort(run);updateCountdown(at);await delay(Math.min(250,Math.max(1,at-Date.now())));}
  checkAbort(run);
}
function updateCountdown(at){
  const ms=at-Date.now();const sec=Math.max(0,Math.ceil(ms/1000));
  $("countdown").textContent=sec>=3600?`${Math.floor(sec/3600)}h ${Math.floor(sec%3600/60)}m`:`${String(Math.floor(sec/60)).padStart(2,"0")}:${String(sec%60).padStart(2,"0")}`;
}
async function waitForForm(tabId,run,c){
  let last=null,notified=false,returned=false;const deadline=Date.now()+180000;
  while(Date.now()<deadline){
    checkAbort(run);last=await probe(tabId);
    if(last?.form)return last;
    if(last?.login&&!notified){
      notified=true;stage("Login needed on booking page","Finish SSO in the booking tab. Preparation will resume; a missed typing target alone will not cancel it.",35);
      await notify("HKU session needs renewal","Sign in in the booking tab to continue this confirmed attempt.",run.id+"-renew");
    }
    if(notified&&last?.authenticated&&!last.form&&!returned){
      returned=true;await chrome.tabs.update(tabId,{url:HKU.reservationURL(c)});
    }
    await delay(300);
  }
  throw Error("The reservation form is still unavailable after three minutes. The page may be blocked or have changed. Inspect the open HKU tab; no Create click was sent.");
}
async function clickCaptchaOnce(){
  // One checkbox request, always AFTER the fresh typing receipt. No challenge solver.
  try{
    const reply=await chrome.tabs.sendMessage(bookingTabId,{type:"HKU_CAPTCHA_CLICK"});
    log(reply?.clicked?"Requested one reCAPTCHA checkbox click; checking verification.":reply?.alreadyChecked?"CAPTCHA checkbox is already checked; verifying its response.":"Checkbox helper did not respond. Use the checkbox in the booking tab if requested.");
  }catch{log("Automatic checkbox click was unavailable. Use the checkbox in the booking tab.");}
}
async function showCaptchaPrompt(run,text){
  $("captchaText").textContent=text;show("captchaBanner");
  log(text);
  await notify("HKU booking: CAPTCHA needs you",text,run.id+"-captcha");
}
async function waitReady(c,plan,run){
  let clickedCheckbox=false,clickRequestedAt=0,prompted=false,wasVerified=false,readyLogged=false;
  // Prepare-now does not wait for a nonexistent release countdown.
  if(c.mode==="now"){
    plan.release=Date.now();plan.clickAt=plan.release+Math.round(c.offset*1000);plan.captchaAt=Date.now();
  }
  // The CAPTCHA time is an actual scheduled trigger, not just a hint to the
  // polling loop. Stop making status RPCs before that instant, then request
  // the checkbox first. Typing must already have finished.
  const deadline=Math.max(plan.clickAt,Date.now())+Math.max(5,c.late)*1000;
  if(c.mode==="scheduled"&&Date.now()>plan.captchaAt)
    log("Running late: typing is complete. Requesting CAPTCHA now, not abandoning this attempt.");
  if(Date.now()<plan.captchaAt){
    stage("Waiting for CAPTCHA","Typing is complete. The CAPTCHA request is scheduled automatically.",52);
    await waitUntil(plan.captchaAt,run);
  }
  checkAbort(run);
  if(!run.typingFinishedAt)throw Error("Typing has not finished. CAPTCHA cannot be requested yet.");
  clickedCheckbox=true;clickRequestedAt=Date.now();
  log("CAPTCHA requested after all booking fields were freshly typed and verified.");
  await clickCaptchaOnce();
  while(true){
    checkAbort(run);
    const s=await message(bookingTabId,"HKU_STATUS");
    if(s.login)throw Error("Your HKU session expired during preparation. Sign in again; no click was sent.");
    if(!s.form)throw Error("The booking tab no longer contains the expected form. No click was sent.");
    if(!s.typing?.complete || s.typing.runId!==c.runId)throw Error("Fresh typing for this attempt is missing (the page may have reloaded). No Create click was sent.");
    const cap=s.captcha,ready=!cap.present||(cap.verified&&!cap.challenge);
    if(ready){
      show("captchaBanner",false);
      if(!readyLogged){log(cap.present?"A non-empty reCAPTCHA response is present. HKU will validate it on submission.":"No reCAPTCHA widget was detected on this form.");readyLogged=true;}
      wasVerified=cap.verified;
      stage(c.dryRun?"Rehearsal ready":"Ready for release",c.dryRun?"The form is prepared. Create will not be clicked.":`The booking will be submitted at its scheduled time if verification remains valid. The server decides acceptance.`,70);
      if(c.dryRun)return {rehearsal:true};
      if(s.createEnabled){
        // Return as soon as prepared. runBooking() waits on the exact Create
        // target independently instead of polling the page at that instant.
        // The HKU page helper rechecks CAPTCHA and fields before any click.
        return {rehearsal:false};
      }
      stage("Waiting for Create to enable","Details are typed, but HKU has not enabled Create yet. No forced click will be sent.",72);
      if(Date.now()>deadline)throw Error("Create stayed disabled until the allowed submission window ended. No Create click was sent.");
    }else{
      if(wasVerified){wasVerified=false;readyLogged=false;prompted=false;log("The reCAPTCHA response disappeared before submission.");}
      if((cap.challenge||cap.expired||(clickedCheckbox&&Date.now()-clickRequestedAt>2500))&&!prompted){
        prompted=true;
        stage("Manual CAPTCHA needed","Solve the challenge in the HKU tab. The assistant checks the response field, not whether the challenge merely disappeared.",60);
        await showCaptchaPrompt(run,"Complete reCAPTCHA in the booking tab. Submission waits for verification. The late allowance starts at the later of the target time or completed preparation.");
      }
      if(Date.now()>deadline)throw Error("reCAPTCHA was not verified before the late allowance ended. No Create click was sent.");
    }
    updateCountdown(plan.clickAt);
    // Browser DOM checks only; no repeated HKU server polling.
    await delay(150);
  }
}
async function showResult(result,title="Response received"){
  lastResult={...result,at:Date.now()};
  $("resultText").textContent=result.text||"No unambiguous booking response was captured. Inspect the HKU tab and My Reservations before trying again.";
  $("resultMeta").textContent=[title,result.source,result.status!=null?`HTTP ${result.status} (transport status only)`:"",result.truncated?"Raw response truncated to 60,000 characters":""].filter(Boolean).join(" | ");
  $("rawResponse").textContent=result.raw||"";show("rawDetails",!!result.raw);show("resultSection");
  await chrome.storage.local.set({lastResult:{...lastResult,raw:""}});
}
async function collectResult(run){
  stage("Create attempted - waiting for response","Do not resubmit while the result is unknown. The booking tab stays open.",88);
  const until=Date.now()+25000;
  let latest=null;
  while(Date.now()<until){
    // Never retry the click, including if its acknowledgement was lost on navigation.
    try{
      const s=await message(bookingTabId,"HKU_STATUS");
      if(s.login)throw Error("Login page returned after Create. The booking outcome is unconfirmed.");
      if(s.result?.text){latest=s.result;await delay(650);try{const newer=await message(bookingTabId,"HKU_STATUS");if(newer.result?.text)latest=newer.result;}catch{}break;}
    }catch(e){if(e.message.includes("Login page returned"))throw e;}
    await delay(350);
  }
  if(!latest){
    stage("Outcome not confirmed","No recognizable response was captured. Inspect the still-open HKU tab before any retry.",100);
    log("No definitive response was captured. This does NOT mean that the booking failed. Do not retry without checking My Reservations.");
    await showResult({text:"No recognizable booking response was captured within 25 seconds. The request may still have succeeded or failed. Check the HKU page and My Reservations. No retry was made.",source:"Assistant diagnostic"},"Outcome unknown");
    return "unknown";
  }
  const kind=HKU.classify(latest.text);
  const titles={success:"HKU response indicates success",rejected:"HKU response indicates rejection",pending:"Reservation needs approval",response:"HKU response received - read below"};
  stage(titles[kind],"The text below is captured from the site. The HKU tab remains open for inspection.",100);
  log(`${titles[kind]}. No automatic retry will be made.`);
  await showResult({text:latest.text,source:latest.source,status:latest.network?.status,raw:latest.network?.body||"",truncated:!!latest.network?.truncated},titles[kind]);
  return kind==="response"?"unknown":kind;
}
async function runBooking(c){
  if(currentRun)return;
  const run={id:c.runId,cancelled:false,attempted:false};currentRun=run;++loginWatch;
  busy(true);flash("");lastResult=null;logs=[];$("log").textContent="";show("resultSection",false);show("captchaBanner",false);
  show("progressSection");$("progressSection").scrollIntoView({block:"start",behavior:"smooth"});
  let plan=HKUTyping.plan(c);
  try{
    const lock=await chrome.storage.session.get("activeRun");
    if(lock.activeRun && lock.activeRun.id!==run.id)throw Error("Another booking attempt is active. Cancel or close that companion before starting a second one.");
    await window.HKUPlanner?.assertAvailable(c);
    run.ledgerOwned=true;
    await window.HKUPlanner?.mark(c,"running",run.id);
    await savePrefs();await chrome.storage.local.remove("lastResult");await chrome.storage.session.set({activeRun:{id:run.id,startedAt:Date.now()}});
    log(`${c.dryRun?"REHEARSAL (no Create click)":"LIVE BOOKING AUTHORIZED"}: ${HKU.ROOMS.find(r=>r.id===c.roomId).name}, ${c.date}, ${c.start}-${c.end} HKT.`);
    await ensureLogin(run);
    if(Date.now()>=HKU.hkEpoch(c.date,c.start))throw Error("The requested room session has started while you were signing in. No booking was attempted.");
    stage("Waiting to open the form",`Form preparation target: ${HKU.hkStamp(plan.openAt)}. Keep this companion window open.`,25);
    log(`Form open target: ${HKU.hkStamp(plan.openAt)}.`);
    if(c.mode==="scheduled")log(`Recommended start/confirm time: ${HKU.hkStamp(plan.recommendedStartAt)} (includes login allowance).`);
    if(c.mode==="scheduled"&&Date.now()>plan.recommendedStartAt)log(`WARNING: The recommended time to start this attempt was ${HKU.hkStamp(plan.recommendedStartAt)}. Preparation may finish late; the app will not skip typing.`);
    if(c.mode==="scheduled")log(`Release: ${HKU.hkStamp(plan.release)}. Preparation, CAPTCHA and Create scheduling are automatic.`);
    await waitUntil(plan.openAt,run);
    if(c.mode==="scheduled")log("The form will open ahead of release to prepare the booking.");
    stage("Opening the reservation form","Loading a fresh form using the current Edge session.",35);
    bookingTabId=await openSite(HKU.reservationURL(c));
    await chrome.storage.session.set({bookingTabId});
    try{await chrome.tabs.update(bookingTabId,{autoDiscardable:false});}catch{}
    await waitForForm(bookingTabId,run,c);checkAbort(run);
    try{await chrome.scripting.executeScript({target:{tabId:bookingTabId},world:"MAIN",files:["response-bridge.js"]});}
    catch{log("Network response observer was unavailable. Visible HKU response text will still be checked.");}
    stage("Typing your booking details","Clearing each field, typing with variable pauses, and verifying every value. Leave the booking tab untouched during this step.",42);
    await HKUTyping.fill(c,{
      tabId:bookingTabId,guard:()=>checkAbort(run),typingTarget:plan.typingTarget,
      message:async(...args)=>{checkAbort(run);const reply=await message(...args);checkAbort(run);return reply;},
      sleep:async ms=>{checkAbort(run);await delay(ms);checkAbort(run);},
      progress:text=>log(text)
    });
    checkAbort(run);
    run.typingFinishedAt=Date.now();
    log(`Fresh typing completed at ${HKU.hkStamp(run.typingFinishedAt)}; all three fields verified, agreement checked, and keyboard connection closed. No CAPTCHA or Create click yet.`);
    if(c.mode==="scheduled"&&run.typingFinishedAt>plan.typingTarget)log(`WARNING: Typing completed after the preferred buffer before CAPTCHA. Form loading or starting late can cause this; all characters were still typed with randomized 60-150ms pauses.`);
    if(c.mode==="scheduled"&&run.typingFinishedAt>=plan.clickAt)log("WARNING: The planned Create time has passed before CAPTCHA. This attempt may no longer be competitive.");
    stage("Form prepared","Waiting for the CAPTCHA trigger and submission target.",50);
    const ready=await waitReady(c,plan,run);checkAbort(run);
    if(ready.rehearsal){
      stage("Rehearsal complete - nothing booked","The form is filled. Create was never clicked. Review the HKU tab. Test only must be off for a real attempt.",100);
      log("REHEARSAL COMPLETE: no Create click or reservation POST was initiated by the extension.");
      $("countdown").textContent="TEST";await window.HKUPlanner?.mark(c,"tested",run.id);return;
    }
    // Do not poll HKU_STATUS at the exact Create deadline. The content helper
    // revalidates CAPTCHA, agreement, and field integrity when it clicks.
    // Timing follows the edition-wide fixed CAPTCHA lead.
    if(Date.now()<plan.clickAt){
      stage("Ready - waiting for submission","Submitting automatically if verification remains valid.",78);
      await waitUntil(plan.clickAt,run);
    }
    // Exactly one call. A timeout/navigation never triggers a second call.
    checkAbort(run);
    if(Date.now()>=HKU.hkEpoch(c.date,c.start))throw Error("The room session has already started. No Create click was sent.");
    await window.HKUPlanner?.mark(c,"attempted",run.id);
    checkAbort(run);run.attempted=true;$("cancelBtn").disabled=true;
    const sentAt=Date.now();
    log("Sending the single Create attempt; waiting for the HKU response.");
    let reply;
    try{reply=await message(bookingTabId,"HKU_SUBMIT",{config:c});}
    catch(e){
      if(/No Create click|No click|not verified|disabled|validation|changed after|no longer matches|no longer checked|Expected one/i.test(e.message)){run.attempted=false;throw e;}
      log(`Create acknowledgement unavailable: ${e.message}. Treating outcome as uncertain; never clicking again.`);
    }
    if(reply?.clicked)log(`Page helper dispatched Create at ${HKU.hkStamp(reply.at)}. This is not yet confirmation.`);
    if(reply?.alreadySubmitted)log("The page reported that this run already attempted submission. No duplicate click was sent.");
    $("countdown").textContent="SENT";
    const outcome=await collectResult(run);
    await window.HKUPlanner?.mark(c,outcome||"unknown",run.id);
  }catch(e){
    if(run.ledgerOwned)await window.HKUPlanner?.mark(c,run.attempted?"unknown":run.cancelled?"cancelled":"needsAttention",run.id).catch(()=>{});
    const title=run.cancelled?"Attempt cancelled":run.attempted?"Submission needs inspection":"Stopped before submission";
    stage(title,e.message,100);log(e.message);$("countdown").textContent="STOP";
    flash(run.attempted?`${e.message} Check My Reservations before retrying; no second click will be sent.`:e.message);
  }finally{
    currentRun=null;busy(false);show("captchaBanner",false);
    const active=await chrome.storage.session.get("activeRun");if(active.activeRun?.id===run.id)await chrome.storage.session.remove("activeRun");
    try{if(bookingTabId)await chrome.tabs.update(bookingTabId,{autoDiscardable:true});}catch{}
    try{await chrome.notifications.clear(`hku-${run.id}-captcha`);}catch{}
  }
}
async function openCalendar(){
  flash("");const room=HKU.ROOMS.find(r=>r.id===$("room").value);
  if(!$("date").value)throw Error("Choose a booking date first.");
  const u=new URL("schedule.php",HKU.BASE);u.search=new URLSearchParams({sid:room.sid,sd:$("date").value}).toString();
  calendarTabId=await openSite(u.href);
  $("availabilityNote").textContent="The live HKU calendar is open. Choose the room/date there if HKU ignores the URL filter. Click a bookable slot, then return here and select Use selected HKU slot. Or try Read slot links.";
}
async function readSlots(){
  if(!calendarTabId)throw Error("Open the live HKU calendar first.");
  const p=await probe(calendarTabId);if(!p?.authenticated)throw Error("Finish HKU login and load the calendar before reading slots.");
  const data=await message(calendarTabId,"HKU_READ_SLOTS",{config:{roomId:$("room").value,date:$("date").value}});
  $("slots").replaceChildren();
  for(const s of data.slots){const b=document.createElement("button");b.type="button";b.className="slot";b.textContent=`${s.start.slice(0,5)} - ${s.end.slice(0,5)}`;b.addEventListener("click",()=>applySlot(s));$("slots").append(b);}
  $("availabilityNote").textContent=data.slots.length?`${data.slots.length} selectable slot links read from this calendar at ${HKU.hkStamp(data.checkedAt)}. Availability can change; HKU validates the final request.`:"No readable slot links were exposed for that room/date. This does NOT mean no rooms are available. Use HKU's native calendar: click a bookable slot there, then Use selected HKU slot here.";
}
function applySlot(s){
  $("room").value=s.roomId;$("date").value=s.date;$("start").value=s.start.slice(0,5);$("end").value=s.end.slice(0,5);
  weeklySelection=null;show("weeklySelectionNote",false);updateRelease();
  $("availabilityNote").textContent="Room and time imported from an actual HKU reservation URL. This is not a hold or guarantee of availability.";
}
async function importSlot(){
  const tabs=await chrome.tabs.query({url:HKU.BASE+"reservation/*"});
  const valid=tabs.map(t=>({tab:t,slot:HKU.parseReservationURL(t.url)})).filter(x=>x.slot);
  valid.sort((a,b)=>(b.tab.id===calendarTabId?1:0)-(a.tab.id===calendarTabId?1:0)||(b.tab.lastAccessed||0)-(a.tab.lastAccessed||0));
  if(!valid.length)throw Error("Click a slot in the live HKU calendar first, so its reservation form is open. Do not submit it. Then import the selection here.");
  applySlot(valid[0].slot);flash("Imported the selected HKU reservation slot. Review its room, date, and times before confirming.");
}
function safe(fn){return (...args)=>Promise.resolve().then(()=>fn(...args)).catch(e=>flash(e.message));}
function reviewError(text=""){
  $("reviewError").textContent=text;show("reviewError",!!text);
  if(text)$("reviewError").scrollIntoView({block:"center",behavior:"smooth"});
}
function updateRunMode(){
  const test=$("dryRun").checked;
  $("runModeNotice").textContent=test?"TEST ONLY: the form will be prepared, but Create will never be clicked.":"LIVE BOOKING: after you review and confirm, one real reservation request may be sent.";
  $("runModeNotice").classList.toggle("test",test);
}
$("dryRun").addEventListener("change",updateRunMode);
$("instructionBtn").addEventListener("click",()=>$("instructionDialog").showModal());
for(const id of ["instructionClose","instructionDone"])$(id).addEventListener("click",()=>$("instructionDialog").close());
$("portalBtn").addEventListener("click",safe(loginOnly));
$("reserveBtn").addEventListener("click",()=>{
  // This button explicitly selects a standalone reservation. Never carry a
  // weekly attempt lock into a manual booking, even with identical slot values.
  weeklySelection=null;window.HKUPlanner?.clearSelection();
  show("weeklySelectionNote",false);reviewError();
  show("weeklySection",false);show("reservationSection");
  $("reservationSection").scrollIntoView({behavior:"smooth"});
});
$("calendarBtn").addEventListener("click",safe(openCalendar));
$("readSlotsBtn").addEventListener("click",safe(readSlots));
$("importSlotBtn").addEventListener("click",safe(importSlot));
$("showTabBtn").addEventListener("click",safe(()=>focusTab()));$("solveBtn").addEventListener("click",safe(()=>focusTab()));
$("cancelBtn").addEventListener("click",()=>{if(currentRun&&!currentRun.attempted){currentRun.cancelled=true;$("cancelBtn").disabled=true;log("Cancellation requested. No further automated submission will be sent.");}});
$("bookingForm").addEventListener("submit",e=>{
  e.preventDefault();flash("");reviewError();
  if(currentRun){reviewError("A booking attempt is already running. Finish or cancel it before reviewing another reservation.");return;}
  try{
    normalizeTimingInputs();updateRelease();const c=readConfig();HKU.validate(c);const p=HKUTyping.plan(c);preparedConfig=c;
    const room=HKU.ROOMS.find(r=>r.id===c.roomId);
    $("reviewTitle").textContent=c.dryRun?"Review rehearsal - no booking":"Review live booking";
    $("reviewSummary").textContent=`Room: ${room.name}\nBooking: ${c.date}, ${c.start}-${c.end} HKT${HKU.endDate(c)!==c.date?" (ends next day)":""}\nPeople: ${c.people}\nMode: ${c.dryRun?"REHEARSAL - never click Create":"LIVE - one Create attempt"}\n${c.mode==="scheduled"?`Release: ${HKU.hkStamp(p.release)}\nRecommended time to start/confirm: ${HKU.hkStamp(p.recommendedStartAt)}${p.clickAt<Date.now()?"\nRelease has passed: prepare immediately after confirmation.":""}${p.preparationMarginMs<0?"\nWARNING: Estimated typing/loading may exceed the preparation window.":""}${Date.now()>p.recommendedStartAt?"\nWARNING: Recommended preparation lead has already passed; timing is not guaranteed.":""}`:"Prepare immediately after login check; submit after CAPTCHA is ready."}\nTiming: managed automatically. Manual CAPTCHA may require your attention.\nYour UID, phone and user count will be cleared and freshly typed on HKU's form for this attempt.`;
    $("reviewStart").textContent=c.dryRun?"Confirm test only":"Confirm live booking";
    $("reviewDialog").showModal();
  }catch(err){reviewError(err.message);flash(err.message);}
});
$("reviewBack").addEventListener("click",()=>$("reviewDialog").close());
$("reviewStart").addEventListener("click",async()=>{
  const c=preparedConfig;
  if(!c||currentRun||$("reviewStart").disabled)return;
  $("reviewStart").disabled=true;
  try{
    // debugger is a required manifest permission; Chromium does not allow it as optional.
    const allowed=await chrome.permissions.contains({permissions:["debugger"]});
    if(!allowed)throw Error("Keyboard-input permission is unavailable. Nothing was started. Reload or re-enable the updated extension at edge://extensions and approve its required permissions.");
    HKU.validate(c);
    await window.HKUPlanner?.assertAvailable(c);
    await savePrefs();
    const opened=await chrome.runtime.sendMessage({type:'HKU_START_MANUAL',config:c});
    if(!opened?.ok)throw Error(opened?.error||'Could not open the dedicated booking window.');
    $("reviewDialog").close();
    flash(`Booking opened in a SEPARATE Edge window. You may continue browsing here. Keep that window open; reCAPTCHA may need your attention. The booking result will appear there. Run ${opened.runId?.slice(0,8)||''}.`);
    // The independent runner owns the booking even if this companion closes.
  }catch(e){$("reviewDialog").close();flash(e.message);}
  finally{$("reviewStart").disabled=false;}
});
$("bookingForm").addEventListener("input",()=>reviewError());
$("mode").addEventListener("change",updateRelease);
$("autoRelease").addEventListener("change",updateRelease);
for(const id of ["date","start","end","releaseDate","releaseTime"]){$(id).addEventListener("change",()=>{if(["date","start","end"].includes(id)){weeklySelection=null;show("weeklySelectionNote",false);}updateRelease();});}
// No editable CAPTCHA or Create timing fields in this edition.
$("agreement").addEventListener("change",safe(async()=>{
  await chrome.storage.local.set({agreementConsent:{accepted:$("agreement").checked,at:Date.now()}});
  $("agreementSaved").textContent=$("agreement").checked?"Saved on this device. Untick to revoke; review HKU rules when they change.":"Not accepted. Tick once after reading the booking conditions.";
}));
for(const id of formKeys)$(id).addEventListener("change",safe(savePrefs));
$("people").addEventListener("change",timingPreview);
for(const id of ["uid","phone"])$(id).addEventListener("input",()=>{timingPreview();clearTimeout(prefsTimer);prefsTimer=setTimeout(()=>savePrefs().catch(e=>flash(e.message)),250);});
for(const id of ["room","date"]){$(id).addEventListener("change",()=>{weeklySelection=null;show("weeklySelectionNote",false);$("slots").replaceChildren();$("availabilityNote").textContent="Selection changed. Check HKU's live calendar for this room/date; no availability is assumed.";});}
$("exportBtn").addEventListener("click",()=>{
  const text=logs.join("\n")+(lastResult?"\n\nSITE RESPONSE:\n"+lastResult.text:"");
  const url=URL.createObjectURL(new Blob([text],{type:"text/plain;charset=utf-8"}));
  const a=document.createElement("a");a.href=url;a.download=`HKU-booking-log-${HKU.hkParts().date}.txt`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
$("clearBtn").addEventListener("click",safe(async()=>{
  if(currentRun)throw Error("Cancel the active attempt before clearing details.");
  if(!confirm("Clear saved personal details, agreement consent, and booking log? Your weekly timetable will be kept."))return;
  clearTimeout(prefsTimer);await prefsWrite;await logWrite;
  await chrome.storage.local.remove(["preferences","agreementConsent","progressLog","lastResult"]);
  // Never leave unattended weekly booking armed after removing the details it needs.
  await chrome.storage.local.set({autoWeeklyEnabled:false});
  logs=[];lastResult=null;$("uid").value="";$("phone").value="";$("agreement").checked=false;$("log").textContent="";$("agreementSaved").textContent="Agreement consent cleared.";
  show("resultSection",false);flash("Personal details and consent cleared. Automatic weekly booking is now OFF. Your timetable and HKU login are unchanged.");
}));
window.addEventListener("beforeunload",e=>{if(currentRun&&!currentRun.attempted){e.preventDefault();e.returnValue="";}});
async function init(){
  for(const room of HKU.ROOMS){const opt=document.createElement("option");opt.value=room.id;opt.textContent=room.name;$("room").append(opt);}
  $("date").value=HKU.hkParts(Date.now()+6*86400000).date;$("releaseDate").value=HKU.hkParts().date;
  const data=await chrome.storage.local.get(["preferences","progressLog","lastResult","agreementConsent"]);
  if(data.preferences)for(const id of formKeys)if(data.preferences[id]!==undefined){if($(id).type==="checkbox")$(id).checked=data.preferences[id];else $(id).value=data.preferences[id];}
  $("agreement").checked=data.agreementConsent?.accepted===true;
  $("agreementSaved").textContent=$("agreement").checked?"Agreement remembered on this device. Untick to revoke.":"Tick once after reading the conditions. Your choice is saved on this device.";
  normalizeTimingInputs();updateRelease();
  // Each newly opened companion defaults to LIVE, as requested. Confirmation is still mandatory.
  $("dryRun").checked=false;
  updateRunMode();
  if(data.progressLog?.length){logs=data.progressLog;$("log").textContent=logs.join("\n");show("progressSection");stage("Previous session log","No task is automatically resumed. Review settings before starting a new attempt.",100);}
  if(data.lastResult)await showResult(data.lastResult,"Previous response");
  const session=await chrome.storage.session.get(["bookingTabId"]);bookingTabId=session.bookingTabId||null;
  busy(false);
  const clock=()=>{$("clock").textContent=HKU.hkStamp().replace(/\.\d{3}/,"");};clock();setInterval(clock,1000);
}
// planner.js starts init(), then loads the saved weekly planner.
