/* Weekly planner UI. Records are local preferences, not authorizations to book. */
(function(){
  'use strict';
  const W=HKUWeekly;
  let entries=[],history={},editing=null,reminders=true,autoEnabled=false,selectedKey=null;
  const labels={upcoming:'Not due yet',due:'Release within 30 min',released:'Already released',running:'Attempt running',attempted:'Sent - check HKU',unknown:'Outcome unknown',success:'HKU reported success',pending:'Awaiting approval',handled:'Marked handled',skipped:'Skipped this week',rejected:'Rejected',needsAttention:'Needs attention',cancelled:'Cancelled',tested:'Tested only',manualOnly:'Manual review only (missed auto)'};
  const locked=new Set(['running','attempted','unknown','success','pending','handled','skipped','needsAttention','rejected','cancelled']);
  const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
  function action(text,fn,cls='text-button'){
    const b=el('button',text,cls);b.type='button';b.disabled=!!currentRun;b.addEventListener('click',safe(fn));return b;
  }
  async function syncReminders(){
    try{
      const r=await chrome.runtime.sendMessage({type:'HKU_SYNC_REMINDERS'});
      if(r?.error)throw Error(r.error);
    }catch(e){$('reminderStatus').textContent='Reminder service not confirmed: '+e.message+'. Your saved timetable is still available.';}
    await displayReminderStatus();
  }
  async function displayReminderStatus(){
    const d=await chrome.storage.local.get(['reminderStatus','autoScheduleStatus']),s=d.reminderStatus;
    $('weeklyReminders').checked=reminders;
    $('reminderStatus').textContent=!reminders?'Reminders are off. Your timetable is still saved.':s?.error?'Reminders need attention: '+s.error:s?.permission==='denied'?'Notifications are blocked in Edge. Enable extension notifications and check system notification settings.':s?`Reminders enabled. ${s.count||0} upcoming alerts scheduled. Last checked ${HKUWeekly.stamp(s.updatedAt)} HKT. Delivery can still be muted by system settings.`:'Reminders requested. Use Test notification to check this computer.';
  }
  async function displayAuto(){
    const d=await chrome.storage.local.get(['autoWeeklyEnabled','autoScheduleStatus','lastAutoRunSummary']);
    autoEnabled=d.autoWeeklyEnabled===true;$('autoWeeklyToggle').checked=autoEnabled;
    const next=HKUWeekly.occurrences(entries).filter(o=>o.releaseAt>Date.now());
    $('autoWeeklyStatus').textContent=autoEnabled
      ?`ON — ${next.length} future dated occurrence(s) visible in the next two weeks. Edge must be running and awake. Login is checked 30 minutes before release; a separate booking window starts 90 seconds before release. No CAPTCHA challenge is solved automatically. Notifications and exact timing may be delayed.`
      :'OFF — weekly sessions are reminders and planning entries only. Nothing will submit without your separate manual confirmation.';
    if(d.lastAutoRunSummary?.auto)$('autoWeeklyLast').textContent=`Last automatic result: ${d.lastAutoRunSummary.outcome} · ${HKU.hkStamp(d.lastAutoRunSummary.at)}`;
  }
  async function switchAuto(){
    const turnOn=$('autoWeeklyToggle').checked;
    if(turnOn){
      const fresh=await chrome.storage.local.get(['preferences','agreementConsent','weeklyEntries']);
      await prefsWrite;
      await savePrefs();
      const p=(await chrome.storage.local.get('preferences')).preferences||{};
      if(!String(p.uid||'').trim()||!String(p.phone||'').trim()||p.remember!==true||fresh.agreementConsent?.accepted!==true)
        throw Error('To enable automatic weekly booking: open Reservation, enter UID and phone, tick Remember, and accept the agreement. Then try again.');
      if(!(fresh.weeklyEntries||[]).length)throw Error('Add at least one weekly session before enabling automatic booking.');
      const perm=await chrome.notifications.getPermissionLevel();
      if(perm!=='granted')throw Error('Allow Edge extension notifications before enabling automatic booking: otherwise login and CAPTCHA warnings cannot reach you.');
      if(!confirm('TURN ON AUTOMATIC WEEKLY BOOKING?\n\nFor EACH upcoming saved weekly session, this authorizes the extension to send ONE real HKU Create attempt without asking you again.\n\nIt checks login 30 minutes early, opens a separate Edge window, and alerts you for manual CAPTCHA or results. Keep Edge and your computer awake. Results and timing are not guaranteed.\n\nContinue?')){
        $('autoWeeklyToggle').checked=false;return;
      }
      autoEnabled=true;
      await chrome.storage.local.set({autoWeeklyEnabled:true,autoWeeklyEnabledAt:Date.now()});
    }else{
      autoEnabled=false;await chrome.storage.local.set({autoWeeklyEnabled:false});
      flash('Automatic weekly booking turned OFF. An already-running booking window is not cancelled; cancel it there if necessary.');
    }
    const r=await chrome.runtime.sendMessage({type:'HKU_AUTO_SYNC'});
    if(!r?.ok)flash('Automatic scheduling needs attention: '+(r?.error||'Unknown error'));
    await displayAuto();render();
  }
  function weeklyError(text=''){ $('weeklySaveError').textContent=text;show('weeklySaveError',!!text);if(text)$('weeklySaveError').scrollIntoView({block:'center',behavior:'smooth'}); }
  function resetEditor(){editing=null;$('weeklyFormTitle').textContent='Add a weekly session';$('weeklySave').textContent='Add to weekly plan';show('weeklyEditCancel',false);weeklyError();}
  function editEntry(e){
    if(currentRun)throw Error('Finish or cancel the active attempt before editing your plan.');
    editing=e.id;$('weeklyDay').value=e.weekday;$('weeklyStart').value=e.start;$('weeklyRoom').value=e.roomId;
    $('weeklyFormTitle').textContent='Edit this weekly session';$('weeklySave').textContent='Save changes';show('weeklyEditCancel');updateEndHint();$('weeklyForm').scrollIntoView({behavior:'smooth'});
  }
  async function removeEntry(e){
    if(currentRun)return;
    if(!confirm(`Remove ${W.DAYS[e.weekday]} ${e.start} from your recurring plan? This does not cancel any existing HKU reservation.`))return;
    entries=entries.filter(x=>x.id!==e.id);await chrome.storage.local.set({weeklyEntries:entries});if(editing===e.id)resetEditor();render();await syncReminders();
  }
  async function rowStatus(o,status){
    if(currentRun)throw Error('Finish or cancel the active attempt first.');
    if(status==='reset'&&!confirm('First check My Reservations and the original booking tab. Reset permits another attempt and could otherwise duplicate a booking. Have you verified it is safe to try again?'))return;
    const data=await chrome.storage.local.get('weeklyHistory');history=data.weeklyHistory||{};
    if(status==='reset'){
      if(autoEnabled&&o.releaseAt<=Date.now())history[o.key]={status:'manualOnly',at:Date.now()};
      else delete history[o.key];
      // Reset is an explicit user decision after checking HKU. Clear the
      // matching one-shot attempt marker as well, or the Review button would
      // appear enabled but the worker would still reject it.
      const d=await chrome.storage.local.get(['bookingAttempts','autoRunStarted']);
      const attempts=d.bookingAttempts||{},started=d.autoRunStarted||{};
      delete attempts[o.key];delete started[o.key];
      await chrome.storage.local.set({bookingAttempts:attempts,autoRunStarted:started});
    }else history[o.key]={status,at:Date.now()};
    await chrome.storage.local.set({weeklyHistory:history});render();await syncReminders();
  }
  function render(){
    $('weeklyGrid').replaceChildren();
    for(const day of [1,2,3,4,5,6,0]){
      const col=el('section',null,'day-column');col.append(el('div',W.DAYS[day].slice(0,3).toUpperCase(),'day-title'));
      const list=entries.filter(e=>+e.weekday===day).sort((a,b)=>a.start.localeCompare(b.start));
      if(!list.length)col.append(el('p','No session','day-empty'));
      for(const e of list){
        const o=W.occurrence(e,'2026-11-16'),card=el('div',null,'weekly-slot');
        card.append(el('strong',`${e.start} - ${o.end}${o.endDate!==o.date?' +1 day':''}`),el('small',HKU.ROOMS.find(r=>r.id===e.roomId)?.name||'Unknown room'));
        const controls=el('div',null,'slot-actions');controls.append(action('Edit',()=>editEntry(e)),action('Delete',()=>removeEntry(e),'delete'));card.append(controls);col.append(card);
      }
      $('weeklyGrid').append(col);
    }
    const all=W.occurrences(entries);$('weeklyRuns').replaceChildren();show('weeklyEmpty',!all.length);
    for(const o of all){
      const status=W.status(o,history),saved=history[o.key],tr=el('tr');
      if(status==='due')tr.classList.add('due-row');if(o.key===selectedKey)tr.classList.add('selected-row');
      const session=el('td');session.append(el('strong',`${W.DAYS[o.weekday].slice(0,3)} ${o.date}`),el('div',`${o.start} - ${o.end}${o.endDate!==o.date?' (+1 day)':''}`),el('small',HKU.ROOMS.find(r=>r.id===o.roomId).name));
      const release=el('td');release.append(el('strong',W.stamp(o.releaseAt)),el('small',`${HKU.hkParts(o.releaseAt).date} HKT`));
      const run=el('td'),button=action(W.stamp(o.runAt),()=>select(o),'run-time');
      button.append(el('small',o.releaseAt<=Date.now()?'Review & try now':'Review & confirm'));button.disabled=!!currentRun||locked.has(status);
      button.title=currentRun?'A booking attempt is currently running.':locked.has(status)?'This occurrence needs review or was already attempted. Check HKU and use Reset after checking HKU to permit a new attempt.':'Review this dated slot; no reservation is sent by opening the review.';
      run.append(button,el('small',autoEnabled&&o.releaseAt>Date.now()?'AUTO ON: starts 90s before release · manual review still available':'Manual: review about 5 min before release')); 
      const state=el('td');state.append(el('span',labels[status]||status,`status-pill ${status}`));
      if(saved&&['needsAttention','cancelled','tested','rejected'].includes(saved.status))state.append(el('small',`Last run: ${labels[saved.status]}. No retry is automatic.`));
      const controls=el('div',null,'row-controls');
      if(locked.has(status)&&status!=='running')controls.append(action('Reset after checking HKU',()=>rowStatus(o,'reset')));
      else if(status!=='running')controls.append(action('Skip this week',()=>rowStatus(o,'skipped')),action('Already booked',()=>rowStatus(o,'handled')));
      state.append(controls);tr.append(session,release,run,state);$('weeklyRuns').append(tr);
    }
  }
  function updateEndHint(){
    try{const o=W.occurrence({roomId:$('weeklyRoom').value,weekday:+$('weeklyDay').value,id:'preview',start:$('weeklyStart').value},'2026-11-16');$('weeklyEndHint').textContent=`${W.DAYS[+$('weeklyDay').value]} ${o.start} - ${o.end}${o.endDate!==o.date?' the next day':''}. Exactly one hour. Your first dated occurrence and release will appear below.`;}
    catch{$('weeklyEndHint').textContent='Choose a start time; the end is calculated automatically.';}
  }
  async function select(o){
    if(currentRun)throw Error('A booking is already running. Finish or cancel it before selecting another slot.');
    const fresh=W.occurrences(entries).find(x=>x.key===o.key);
    if(!fresh)throw Error('This occurrence has started or the weekly row changed. Refresh the timetable and choose another slot.');
    const data=await chrome.storage.local.get('weeklyHistory');history=data.weeklyHistory||{};
    if(locked.has(W.status(fresh,history)))throw Error('This slot has already been handled or attempted. Check HKU before using Reset.');
    o=fresh;weeklySelection=o;selectedKey=o.key;
    const c=W.config(o);
    for(const k of ['date','start','end','releaseDate','releaseTime','mode'])$(k).value=c[k];$('room').value=o.roomId;
    $('autoRelease').checked=true;updateRelease();normalizeTimingInputs();
    $('availabilityNote').textContent='Loaded from your weekly preferences, not a live availability check. HKU decides whether this slot is available.';
    $('slots').replaceChildren();show('weeklySection',false);show('reservationSection');
    $('weeklySelectionNote').textContent=`Weekly selection: ${W.DAYS[o.weekday]}, ${o.date}, ${o.start}-${o.end}${o.endDate!==o.date?' (ends next day)':''}. Release: ${W.stamp(o.releaseAt)} HKT. ${o.releaseAt<=Date.now()?'Already released: this review will prepare immediately.':'Review and confirm only this occurrence.'}`;
    show('weeklySelectionNote');$('reservationSection').scrollIntoView({behavior:'smooth'});
    // The unified review handler validates the selected slot and saved
    // details and explains missing fields beside Review reservation.
    $('bookingForm').requestSubmit();
  }
  async function assertAvailable(c){
    if(!c.weeklyKey)return;
    const d=await chrome.storage.local.get(['weeklyEntries','weeklyHistory']);
    if(!(d.weeklyEntries||[]).some(e=>e.id===c.weeklyEntryId))throw Error('This weekly row was removed. Select a current row before confirming.');
    const h=d.weeklyHistory?.[c.weeklyKey];
    if(h&&locked.has(h.status))throw Error('This weekly slot has already been attempted or handled. Check HKU, then use Reset in Scheduled booking only if safe.');
  }
  async function mark(c,status,runId){
    if(!c.weeklyKey)return;
    const d=await chrome.storage.local.get('weeklyHistory');history=d.weeklyHistory||{};
    history[c.weeklyKey]={status,runId,at:Date.now()};
    // Keep recent history only; an occurrence key includes the actual date.
    for(const [k,v]of Object.entries(history))if(v.at<Date.now()-60*W.DAY)delete history[k];
    await chrome.storage.local.set({weeklyHistory:history});render();
  }
  function open(selected){
    selectedKey=selected||null;show('reservationSection',false);show('weeklySection');render();$('weeklySection').scrollIntoView({behavior:'smooth'});
  }
  async function load(){
    const d=await chrome.storage.local.get(['weeklyEntries','weeklyHistory','weeklyReminders']);
    entries=[];
    for(const e of d.weeklyEntries||[]){try{W.validateEntry(e);entries.push(e);}catch{flash('One invalid saved weekly record was ignored. Review your timetable.');}}
    history=d.weeklyHistory||{};reminders=d.weeklyReminders!==false;
    await displayAuto();render();await displayReminderStatus();
  }
  async function initPlanner(){
    for(const r of HKU.ROOMS){const opt=el('option',r.name);opt.value=r.id;$('weeklyRoom').append(opt);}
    await load();updateEndHint();
    // A running row without a live companion is recoverable; attempted rows are not retried.
    const active=await chrome.storage.session.get('activeRun');let repaired=false;
    for(const v of Object.values(history))if(v.status==='running'&&v.runId!==active.activeRun?.id){v.status='needsAttention';v.at=Date.now();repaired=true;}
    if(repaired)await chrome.storage.local.set({weeklyHistory:history});
    $('weeklyBtn').addEventListener('click',()=>open());
    $('weeklyForm').addEventListener('submit',e=>{e.preventDefault();weeklyError();Promise.resolve().then(async()=>{
      if(currentRun)throw Error('A booking is running. Finish or cancel it before changing the weekly plan.');
      const old=entries.find(e=>e.id===editing);
      const entry={id:editing||crypto.randomUUID(),weekday:+$('weeklyDay').value,start:$('weeklyStart').value,roomId:$('weeklyRoom').value,enabled:true,createdAt:old?.createdAt||Date.now(),updatedAt:Date.now()};
      W.validateEntry(entry,entries);if(!editing&&entries.length>=100)throw Error('Keep at most 100 weekly records. Remove old rows first.');
      entries=entries.filter(x=>x.id!==entry.id);entries.push(entry);
      await chrome.storage.local.set({weeklyEntries:entries,weeklyReminders:reminders});resetEditor();render();flash('Weekly session saved. The run timetable below shows its release dates. Nothing has been booked.');await syncReminders();
    }).catch(e=>{weeklyError(e.message);flash(e.message);});});
    $('weeklyEditCancel').addEventListener('click',resetEditor);
    for(const id of ['weeklyStart','weeklyDay'])$(id).addEventListener('change',updateEndHint);
    $('autoWeeklyToggle').addEventListener('change',()=>switchAuto().catch(e=>{autoEnabled=false;$('autoWeeklyToggle').checked=false;flash(e.message);displayAuto().catch(()=>{});}));
    $('weeklyReminders').addEventListener('change',safe(async()=>{reminders=$('weeklyReminders').checked;await chrome.storage.local.set({weeklyReminders:reminders});await syncReminders();}));
    $('refreshWeeklyBtn').addEventListener('click',safe(async()=>{await load();await syncReminders();}));
    $('testReminderBtn').addEventListener('click',safe(async()=>{
      const r=await chrome.runtime.sendMessage({type:'HKU_TEST_REMINDER'});if(!r?.ok)throw Error(r?.error||'Notification service did not respond. Reload the extension.');
      flash('A test notification was requested. If it is not visible, check Edge and your computer notification settings.');
    }));
    chrome.storage.onChanged?.addListener((changes,area)=>{
      if(area!=='local')return;
      if(changes.weeklyEntries||changes.weeklyHistory||changes.weeklyReminders||changes.autoWeeklyEnabled||changes.autoScheduleStatus||changes.lastAutoRunSummary)load().catch(e=>flash(e.message));
      if(changes.reminderStatus)displayReminderStatus().catch(()=>{});
    });
    chrome.runtime.onMessage?.addListener((m,s,reply)=>{
      if(m?.type!=='HKU_OPEN_WEEKLY')return;
      open(m.key);reply({ok:true});
    });
    const pending=await chrome.storage.session.get('openWeeklyKey');
    if(pending.openWeeklyKey!==undefined){open(pending.openWeeklyKey);await chrome.storage.session.remove('openWeeklyKey');}
    if(location.hash==='#weekly')open();
    setInterval(()=>{if(!$('weeklySection').hidden)render();},30000);
    await syncReminders();
  }
  window.HKUPlanner={render,mark,assertAvailable,open,select,load,clearSelection(){selectedKey=null;render();}};
  init().then(initPlanner).catch(e=>flash(e.message));
})();
