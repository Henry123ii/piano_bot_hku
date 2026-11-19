/* Weekly recurrence and reminder calculations. Release rule is supplied by the
 * project owner: whole one-hour slot available when its END is six days away.
 * Pure HKT arithmetic; never uses the computer's local timezone or DST. */
(function(root){
  'use strict';
  const H=root.HKU || (typeof require!=='undefined'?require('./shared.js'):null);
  const DAY=86400000,HOUR=3600000,WEEK=7*DAY,LEAD=6*DAY,REMINDER=30*60000,RUN_LEAD=5*60000;
  const DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  function weekday(date){return new Date(H.hkEpoch(date,'12:00')+8*HOUR).getUTCDay();}
  function validateEntry(e,others=[]){
    if(!e || !/^[a-zA-Z0-9_-]{1,80}$/.test(e.id||''))throw Error('Invalid weekly record. Please add it again.');
    if(!Number.isInteger(+e.weekday)||+e.weekday<0||+e.weekday>6)throw Error('Choose a day of the week.');
    H.timeValue(e.start);
    if(!/^\d{2}:00$/.test(e.start))throw Error('Weekly bookings must start on a full clock hour (for example, 14:00). Each session lasts exactly one hour.');
    if(!H.ROOMS.some(r=>r.id===e.roomId))throw Error('Choose a music room.');
    const minute=+e.weekday*1440 + +e.start.slice(0,2)*60 + +e.start.slice(3,5);
    for(const other of others){
      if(other.id===e.id||other.enabled===false||e.enabled===false)continue;
      const om=+other.weekday*1440 + +other.start.slice(0,2)*60 + +other.start.slice(3,5);
      if([-10080,0,10080].some(shift=>minute<om+shift+60 && minute+60>om+shift)){
        throw Error('This overlaps another saved weekly session. Edit that session instead, or choose a different hour.');
      }
    }
    return true;
  }
  function occurrence(e,date){
    const startAt=H.hkEpoch(date,e.start),endAt=startAt+HOUR,end=H.hkParts(endAt),releaseAt=endAt-LEAD;
    const start=H.timeValue(e.start).slice(0,5);
    const key=`${e.roomId}:${date}:${start}`;
    return {key,entryId:e.id,weekday:+e.weekday,roomId:e.roomId,date,start,end:end.time.slice(0,5),
      endDate:end.date,startAt,endAt,releaseAt,reminderAt:releaseAt-REMINDER,runAt:releaseAt-RUN_LEAD};
  }
  function occurrences(entries,now=Date.now(),days=14){
    const today=H.hkParts(now).date,out=[];
    for(const e of entries||[]){
      if(e.enabled===false)continue;
      try{validateEntry(e);}catch{continue;}
      const first=(+e.weekday-weekday(today)+7)%7;
      for(let n=first;n<=days;n+=7){
        const o=occurrence(e,H.addDays(today,n));
        if(o.startAt>now && o.startAt<now+days*DAY)out.push(o);
      }
    }
    return out.sort((a,b)=>a.releaseAt-b.releaseAt||a.roomId.localeCompare(b.roomId));
  }
  function config(o,prefs={},now=Date.now()){
    const r=H.hkParts(o.releaseAt);
    return {...prefs,roomId:o.roomId,date:o.date,start:o.start,end:o.end,endDate:o.endDate,
      mode:o.releaseAt>now?'scheduled':'now',releaseDate:r.date,releaseTime:r.time,
      weeklyKey:o.key,weeklyEntryId:o.entryId};
  }
  function status(o,history={},now=Date.now()){
    const saved=history[o.key]?.status;
    if(['success','pending','attempted','unknown','handled','skipped','running','needsAttention','cancelled','rejected','tested','manualOnly'].includes(saved))return saved;
    if(o.releaseAt<=now)return 'released';
    if(o.releaseAt-now<=REMINDER)return 'due';
    return 'upcoming';
  }
  function reminderJobs(entries,history={},sent={},now=Date.now()){
    return occurrences(entries,now,15).filter(o=>
      !['success','pending','attempted','unknown','handled','skipped','running'].includes(history[o.key]?.status) &&
      !sent[o.key] && o.releaseAt>=now-HOUR
    ).map(o=>({...o,alarmAt:Math.max(now+1500,o.reminderAt),alarmName:'hku-weekly:'+o.key}));
  }
  function stamp(ms){return new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Hong_Kong',weekday:'short',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(ms);}
  const api={DAY,HOUR,WEEK,LEAD,REMINDER,RUN_LEAD,DAYS,weekday,validateEntry,occurrence,occurrences,config,status,reminderJobs,stamp};
  root.HKUWeekly=api;if(typeof module!=='undefined')module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
