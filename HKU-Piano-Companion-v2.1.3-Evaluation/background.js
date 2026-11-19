'use strict';
importScripts('shared.js','schedule.js');
let opening=null,syncQueue=Promise.resolve();
async function openPanel(weeklyKey=undefined){
  if(weeklyKey!==undefined)await chrome.storage.session.set({openWeeklyKey:weeklyKey});
  if(opening)return opening;
  opening=(async()=>{
    const existing=await chrome.tabs.query({url:chrome.runtime.getURL('app.html')+'*'});
    if(existing.length){
      const t=existing[0];await chrome.windows.update(t.windowId,{focused:true,state:'normal'});
      await chrome.storage.session.set({panelWindowId:t.windowId});
      if(weeklyKey!==undefined){try{await chrome.runtime.sendMessage({type:'HKU_OPEN_WEEKLY',key:weeklyKey});await chrome.storage.session.remove('openWeeklyKey');}catch{}}
      return;
    }
    const w=await chrome.windows.create({url:chrome.runtime.getURL('app.html')+(weeklyKey!==undefined?'#weekly':''),type:'popup',width:1120,height:900,focused:true});
    await chrome.storage.session.set({panelWindowId:w.id});
  })();
  try{return await opening;}finally{opening=null;}
}
async function notification(id,title,message){
  const permission=await chrome.notifications.getPermissionLevel();
  if(permission!=='granted')throw Error('Notifications are blocked. Enable them in Edge and your system settings.');
  await chrome.notifications.create(id,{type:'basic',iconUrl:'icons/icon128.png',title,message,priority:2,requireInteraction:true});
}
async function reconcile(trigger){
  const now=Date.now(),d=await chrome.storage.local.get(['weeklyEntries','weeklyHistory','weeklyReminders','remindersSent','autoWeeklyEnabled']);
  const enabled=d.weeklyReminders!==false,entries=d.weeklyEntries||[],history=d.weeklyHistory||{},sent=d.remindersSent||{};
  const permission=await chrome.notifications.getPermissionLevel();let deliveryError='';
  const existing=await chrome.alarms.getAll();let jobs=enabled?HKUWeekly.reminderJobs(entries,history,sent,now):[];
  let changed=false;
  for(const [k,v]of Object.entries(sent))if(v<now-60*HKUWeekly.DAY){delete sent[k];changed=true;}
  // Reconcile after browser restart too. If waking late, explicitly call it a late
  // reminder; never execute a booking. Old occurrences (>1h past release) are not nagged.
  for(const job of jobs){
    const due=job.reminderAt<=now && (job.releaseAt>=now-HKUWeekly.HOUR);
    if(!due||permission!=='granted')continue;
    const room=HKU.ROOMS.find(r=>r.id===job.roomId)?.name||'Music room';
    const left=Math.max(0,Math.ceil((job.releaseAt-now)/60000));
    const title=job.releaseAt<=now?'HKU release has already opened':`HKU slot releases in about ${left} min`;
    const text=d.autoWeeklyEnabled?`${room}: ${job.date} ${job.start}-${job.end} HKT. Automatic mode is enabled; watch for login/CAPTCHA/result alerts. No result yet.`:`${room}: ${job.date} ${job.start}-${job.end} HKT. Release ${HKUWeekly.stamp(job.releaseAt)} HKT. Open the timetable, review and confirm. No booking has been started.`;
    // Deterministic ID updates an existing popup instead of duplicating it.
    try{await notification('hku-weekly:'+job.key,title,text);sent[job.key]=now;changed=true;}
    catch(e){deliveryError=e.message;}
  }
  if(changed)await chrome.storage.local.set({remindersSent:sent});
  jobs=enabled?HKUWeekly.reminderJobs(entries,history,sent,now).filter(j=>j.reminderAt>now):[];
  const desired=new Map(jobs.map(j=>[j.alarmName,j]));
  for(const alarm of existing){
    if(alarm.name.startsWith('hku-weekly:')&&!desired.has(alarm.name))await chrome.alarms.clear(alarm.name);
  }
  for(const job of jobs){
    const old=existing.find(a=>a.name===job.alarmName);
    if(!old||Math.abs(old.scheduledTime-job.alarmAt)>1000)await chrome.alarms.create(job.alarmName,{when:job.alarmAt});
  }
  // Repairs new weekly occurrences and lost alarms. Not used for sub-second clicks.
  if(!existing.some(a=>a.name==='hku-weekly-maintenance'))await chrome.alarms.create('hku-weekly-maintenance',{periodInMinutes:60});
  const status={updatedAt:now,count:jobs.length,permission,enabled,...(deliveryError?{error:deliveryError}:{})};
  await chrome.storage.local.set({reminderStatus:status});return status;
}
function syncReminders(trigger){
  syncQueue=syncQueue.catch(()=>{}).then(()=>reconcile(trigger)).catch(async e=>{
    const status={updatedAt:Date.now(),error:e.message,count:0};await chrome.storage.local.set({reminderStatus:status});return status;
  });return syncQueue;
}
chrome.action.onClicked.addListener(()=>openPanel().catch(console.error));
chrome.alarms.onAlarm.addListener(alarm=>syncReminders(alarm.name));
chrome.runtime.onStartup.addListener(()=>syncReminders('startup'));
chrome.runtime.onInstalled.addListener(()=>syncReminders('installed'));
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==='local'&&(changes.weeklyEntries||changes.weeklyReminders||changes.weeklyHistory))syncReminders('changed');
});
chrome.runtime.onMessage.addListener((m,s,reply)=>{
  if(!['HKU_SYNC_REMINDERS','HKU_TEST_REMINDER'].includes(m?.type))return;
  // Only our extension page can request planner actions, never a web page.
  if(!s.url?.startsWith(chrome.runtime.getURL(''))){reply({ok:false,error:'This action is available only in the companion.'});return;}
  const op=m.type==='HKU_TEST_REMINDER'?notification('hku-weekly-test','HKU Piano Companion: reminders work','This is a test. Real reminders are requested 30 minutes before release. Click to open your weekly timetable. No booking has been made.'):syncReminders('panel');
  Promise.resolve(op).then(status=>reply({ok:!status?.error,...(status?.error?{error:status.error}:{}),status})).catch(e=>reply({ok:false,error:e.message}));
  return true;
});
chrome.notifications.onClicked.addListener(async id=>{
  try{
    if(id.startsWith('hku-weekly:')||id==='hku-weekly-test')await openPanel(id.startsWith('hku-weekly:')?id.slice('hku-weekly:'.length):'');
    else{
      if(id.startsWith('hku-auto-')||id.startsWith('hku-run-'))return;
      const {bookingTabId}=await chrome.storage.session.get('bookingTabId');
      if(bookingTabId){const t=await chrome.tabs.update(bookingTabId,{active:true});await chrome.windows.update(t.windowId,{focused:true,state:'normal'});}
      else await openPanel();
    }
  }catch{await openPanel();}
  await chrome.notifications.clear(id);
});
chrome.windows.onRemoved.addListener(async id=>{
  const d=await chrome.storage.session.get('panelWindowId');
  if(id===d.panelWindowId)await chrome.storage.session.remove('panelWindowId');
  // Closing the companion must NOT cancel a run in a separate Edge window.
});
syncReminders('worker-start');
importScripts('auto-backend.js');
