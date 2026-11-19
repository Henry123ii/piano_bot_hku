/* Weekly automatic-booking schedule. No network, no side effects. */
(function(root){
  'use strict';
  const W=root.HKUWeekly || (typeof require!=='undefined'?require('./schedule.js'):null);
  const LOGIN_LEAD=30*60*1000;
  const RUN_LEAD=90*1000;
  const START_GRACE=20*1000;
  const BLOCKED=new Set(['running','attempted','unknown','success','pending','handled','skipped','needsAttention','rejected','cancelled','manualOnly']);
  function jobs(entries,history={},enabledAt=0,now=Date.now()){
    return W.occurrences(entries,now,16).filter(o=>
      o.releaseAt > enabledAt &&
      o.releaseAt > Number(entries.find(e=>e.id===o.entryId)?.updatedAt||entries.find(e=>e.id===o.entryId)?.createdAt||0) &&
      !BLOCKED.has(history[o.key]?.status)
    ).map(o=>({...o,loginAt:o.releaseAt-LOGIN_LEAD,startAt:o.releaseAt-RUN_LEAD,
      loginAlarm:'hku-auto-login:'+o.key,runAlarm:'hku-auto-run:'+o.key}));
  }
  function isStartTimely(job,now=Date.now()){
    return now <= job.startAt+START_GRACE && now < job.releaseAt;
  }
  function find(jobsList,key){return jobsList.find(j=>j.key===key)||null;}
  root.HKUAuto={LOGIN_LEAD,RUN_LEAD,START_GRACE,BLOCKED,jobs,isStartTimely,find};
  if(typeof module!=='undefined')module.exports=root.HKUAuto;
})(typeof globalThis!=='undefined'?globalThis:this);
