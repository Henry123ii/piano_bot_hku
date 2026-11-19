(() => {
  "use strict";
  if (window.__hkuPianoContentLoaded) return;
  window.__hkuPianoContentLoaded=true;
  const responseSelector="#reservationResponse,#reservationResult,#reservationCreated,#reservationFailed,#reservationErrors,#reservation-errors,#result,.alert,[role='alert'],[role='dialog'],.modal.show,.modal.in,.ui-dialog-content,.toast-message";
  let submitted=false, runId=null, responseBaseline=new Map(), network=[];
  let submittedAt=0, preparation=null, lastToken="", tokenSeenAt=0;
  const fieldSpecs=[
    {label:"Student UID No.",key:"uid"},
    {label:"Contact No.",key:"phone"},
    {label:"Total Number of People Using the Room",key:"people"}
  ];
  try {
    const old=JSON.parse(sessionStorage.getItem("hkuPianoPending")||"null");
    if(old && Date.now()-old.at<120000){submitted=true;runId=old.runId;submittedAt=old.at;}
  } catch {}
  const visible=el=>!!el && el.getClientRects().length>0 && getComputedStyle(el).visibility!=="hidden" && getComputedStyle(el).display!=="none";
  const norm=t=>String(t||"").toLowerCase().replace(/[^a-z0-9]/g,"");
  function field(labelText) {
    const matches=[];
    for (const label of document.querySelectorAll("label")) {
      if(norm(label.textContent)!==norm(labelText))continue;
      const el=label.control || (label.htmlFor?document.getElementById(label.htmlFor):label.querySelector("input,select,textarea"));
      if(el && visible(el)) matches.push(el);
    }
    if(matches.length===0) for(const el of document.querySelectorAll("input,textarea,select")) {
      if(visible(el) && norm(el.getAttribute("aria-label"))===norm(labelText))matches.push(el);
    }
    const unique=[...new Set(matches)];
    if(unique.length!==1)throw Error(`Expected one visible field labelled '${labelText}', found ${unique.length}. No submission was made.`);
    return unique[0];
  }
  function hasFields(){try{field("Student UID No.");field("Contact No.");field("Total Number of People Using the Room");return true;}catch{return false;}}
  function createButton() {
    const candidates=[...document.querySelectorAll("button,input[type=submit],input[type=button],[role=button]")]
      .filter(el=>visible(el) && /^create$/i.test((el.getAttribute("aria-label")||el.value||el.innerText||el.textContent||"").trim()));
    if(candidates.length!==1)throw Error(`Expected one visible Create button, found ${candidates.length}. Check the booking tab.`);
    return candidates[0];
  }
  function probe(){
    const login=!!document.querySelector("input[type=password]") || /(?:\bLog In\b|\bSign In\b)/i.test(document.title) || [...document.querySelectorAll("a,button")].some(el=>visible(el)&&/log in with hku sso/i.test(el.textContent));
    const logout=!!document.querySelector("a[href*='logout'],a[href*='signout'],form[action*='logout']");
    const form=hasFields();
    const schedule=!!document.querySelector("a[href*='schedule.php']") && /dashboard\.php|schedule\.php/.test(location.pathname);
    return {url:location.href,title:document.title,login,authenticated:!login&&(logout||form||schedule),form,
      labels:[...document.querySelectorAll("label")].slice(0,25).map(x=>x.textContent.trim())};
  }
  function assertTarget(c){
    const actual=HKU.parseReservationURL(location.href);
    if(!actual || actual.roomId!==c.roomId || actual.date!==c.date || actual.start!==HKU.timeValue(c.start) || actual.end!==HKU.timeValue(c.end) || HKU.endDate(actual)!==HKU.endDate(c))throw Error("The open reservation URL no longer matches the confirmed room/date/time. Stopped.");
  }
  // A per-run typing receipt is required. Matching prefilled values are NOT enough.
  // Only browser-generated keyboard/input events count, not dispatchEvent().
  function beginTyping(c){
    assertTarget(c);
    if(submitted)throw Error("This form already attempted a booking. Check My Reservations; no second click is allowed.");
    if(!c.runId)throw Error("Missing booking attempt identifier. No Create click was sent.");
    const targets=fieldSpecs.map(spec=>{
      const el=field(spec.label), value=String(c[spec.key]);
      if(el.disabled||el.readOnly)throw Error(`${spec.label} is disabled or read-only. No Create click was sent.`);
      if(!["INPUT","TEXTAREA"].includes(el.tagName) ||
         (el.tagName==="INPUT" && !["text","tel","number","search","email","url"].includes(el.type))) {
        throw Error(`${spec.label} is not a supported text field. Inspect the HKU form; no Create click was sent.`);
      }
      if(!value || /[\r\n\t]/.test(value))throw Error("Booking fields must contain a single line of text.");
      return {el,label:spec.label,value,sawEmpty:el.value==="",keys:0,inputs:0,changes:0,blurred:false,committed:false,listeners:[]};
    });
    const rules=document.querySelector("#attribute-65");
    if(!rules || rules.type!=="checkbox")throw Error("Agreement checkbox #attribute-65 was not found. No Create click was sent.");
    createButton();
    if(preparation)for(const t of preparation.targets)for(const [name,fn]of t.listeners)t.el.removeEventListener(name,fn,true);
    preparation={id:c.runId,targets,complete:false,completedAt:0,index:-1};
    for(const t of targets){
      const handlers={
        keydown:e=>{if(e.isTrusted && e.key.length===1 && !e.ctrlKey && !e.metaKey)t.keys++;},
        input:e=>{if(e.isTrusted){t.inputs++;if(t.el.value==="")t.sawEmpty=true;}},
        change:e=>{if(e.isTrusted)t.changes++;},
        blur:()=>{t.blurred=true;}
      };
      for(const [name,fn]of Object.entries(handlers)){t.el.addEventListener(name,fn,true);t.listeners.push([name,fn]);}
    }
    runId=c.runId;submittedAt=0;network=[];responseBaseline=new Map();
    sessionStorage.removeItem("hkuPianoPending");
    return {started:true,fieldCount:targets.length};
  }
  function typingTarget(c,index){
    assertTarget(c);
    if(!preparation || preparation.id!==c.runId || submitted)throw Error("Fresh typing for this booking attempt is missing. No Create click was sent.");
    const t=preparation.targets[index];
    if(!t || !t.el.isConnected || field(t.label)!==t.el || t.el.disabled || t.el.readOnly)throw Error("A booking field changed or became unavailable during typing. No Create click was sent.");
    if(t.value!==String(c[fieldSpecs[index].key]))throw Error("Booking details changed during preparation. No Create click was sent.");
    return t;
  }
  function focusTyping(c,index){
    const t=typingTarget(c,index);
    if(preparation.complete)throw Error("Typing for this run has already finished. No automatic retyping loop is allowed.");
    if(preparation.index!==index-1)throw Error("Booking fields must be freshly typed once in order.");
    preparation.index=index;
    t.el.scrollIntoView({block:"center"});t.el.focus();
    if(document.activeElement!==t.el)throw Error("The booking field could not receive keyboard focus. No Create click was sent.");
    return {focused:true};
  }
  function refocusTyping(c,index){
    const t=typingTarget(c,index);
    if(preparation.complete || preparation.index!==index || t.committed || t.el.value!=="")throw Error("The cleared booking field changed before typing. No Create click was sent.");
    t.blurred=false;t.el.focus();
    if(document.activeElement!==t.el)throw Error("The cleared booking field could not regain focus. No Create click was sent.");
    return {focused:true};
  }
  function checkTyping(c,index,expected){
    const t=typingTarget(c,index);
    if(document.activeElement!==t.el)throw Error("Typing was interrupted: focus left the booking field. Leave the booking tab untouched while typing. No Create click was sent.");
    if(t.el.value!==String(expected))throw Error(`The ${t.label} field did not retain the expected typed text. No Create click was sent.`);
    return {matches:true};
  }
  function commitTyping(c,index){
    const t=typingTarget(c,index);
    const length=Array.from(t.value).length;
    if(t.el.value!==t.value || !t.sawEmpty || t.keys<length || t.inputs<length || !t.blurred || t.changes<1){
      throw Error(`Fresh keyboard input for ${t.label} was not confirmed. No Create click was sent.`);
    }
    t.committed=true;
    return {committed:true};
  }
  function prepared(c){
    if(!preparation || !preparation.complete || preparation.id!==c.runId)return false;
    try{return preparation.targets.every((t,index)=>typingTarget(c,index).committed && t.el.value===t.value);}
    catch{return false;}
  }
  function finishTyping(c){
    assertTarget(c);
    if(c.agreementAccepted!==true)throw Error("Booking agreement has not been authorized. No Create click was sent.");
    if(!preparation || preparation.id!==c.runId || !preparation.targets.every(t=>t.committed))throw Error("Typing has not completed for every booking field. No Create click was sent.");
    for(let i=0;i<fieldSpecs.length;i++){const t=typingTarget(c,i);if(t.el.value!==t.value)throw Error("A typed field changed before preparation finished. No Create click was sent.");}
    const rules=document.querySelector("#attribute-65");
    if(!rules || rules.disabled)throw Error("The agreement checkbox is missing or disabled. No Create click was sent.");
    rules.scrollIntoView({block:"center"});if(!rules.checked)rules.click();
    if(!rules.checked)throw Error("The agreement checkbox could not be checked. No Create click was sent.");
    const button=createButton();button.scrollIntoView({block:"center"});
    preparation.complete=true;preparation.completedAt=Date.now();
    if(!prepared(c))throw Error("The page changed after typing. No Create click was sent.");
    return {filled:true,freshlyTyped:true,completedAt:preparation.completedAt,createEnabled:!button.disabled};
  }
  function captcha(){
    const responses=[...document.querySelectorAll("textarea[name='g-recaptcha-response'],input[name='g-recaptcha-response'],textarea[id^='g-recaptcha-response']")];
    const frame=document.querySelector("iframe[src*='/recaptcha/'][src*='/anchor'],iframe[title='reCAPTCHA']");
    const challenge=[...document.querySelectorAll("iframe[src*='/recaptcha/'][src*='/bframe'],iframe[title*='recaptcha challenge']")].some(visible);
    const present=!!frame || !!document.querySelector(".g-recaptcha,[data-sitekey]") || responses.length>0;
    const token=responses.map(x=>String(x.value||"").trim()).find(Boolean)||"";
    if(token!==lastToken){lastToken=token;tokenSeenAt=token?Date.now():0;}
    // Conservative local freshness guard; only the server can validate a token.
    const expired=!!token && Date.now()-tokenSeenAt>=110000;
    return {present,verified:!!token&&!expired,challenge,expired};
  }
  function rawToText(raw){
    if(!raw)return "";
    try {
      const data=JSON.parse(raw);
      if(typeof data==="string")return data;
      const messages=[];
      for(const k of ["message","Message","error","errors","Errors","statusMessage","confirmation"]) {
        const v=data[k];if(v)messages.push(typeof v==="string"?v:JSON.stringify(v,null,2));
      }
      if(messages.length)return messages.join("\n");
      return JSON.stringify(data,null,2);
    } catch {}
    if(/<[a-z][\s\S]*>/i.test(raw)){
      const d=new DOMParser().parseFromString(raw,"text/html");
      for(const el of d.querySelectorAll("script,style,noscript"))el.remove();
      return d.body.textContent.trim();
    }
    return raw;
  }
  function result(){
    if(!submitted)return {submitted:false};
    const list=[];
    for(const el of document.querySelectorAll(responseSelector)) {
      if(!visible(el))continue;
      const text=el.innerText?.trim();
      if(text && responseBaseline.get(el)!==text && !el.closest("#hku-piano-note"))list.push(text);
    }
    const unique=[...new Set(list)];
    const latest=network.at(-1)||null;
    const text=unique.join("\n\n") || (latest?rawToText(latest.body):"");
    return {submitted:true,submittedAt,text,source:unique.length?"Visible HKUFBS response":latest?.source||"",network:latest,url:location.href};
  }
  document.addEventListener("hku-piano-response",e=>{
    if(!submitted)return;
    try {const d=JSON.parse(e.detail);if(d && typeof d.body==="string"){network.push(d);network=network.slice(-6);}}catch{}
  });
  function submit(c){
    if(submitted && runId===c.runId)return {alreadySubmitted:true,at:submittedAt};
    assertTarget(c);
    if(!prepared(c))throw Error("Fresh typing for this booking attempt is incomplete or the form changed. No Create click was sent.");
    for(const [label,value]of [["Student UID No.",c.uid],["Contact No.",c.phone],["Total Number of People Using the Room",c.people]]) {
      if(field(label).value!==String(value))throw Error(`The ${label} field changed after preparation. Review the form; no automated submission was made.`);
    }
    const cap=captcha();
    if(cap.present&&(!cap.verified||cap.challenge))throw Error("reCAPTCHA is not verified. No Create click was sent.");
    const rules=document.querySelector("#attribute-65");
    if(!rules?.checked)throw Error("The agreement is no longer checked.");
    const button=createButton();
    if(button.disabled || button.getAttribute("aria-disabled")==="true")throw Error("Create is disabled on the live page. No click was sent.");
    if(button.form&&!button.form.checkValidity()){
      const invalid=[...button.form.elements].filter(e=>e.willValidate&&!e.checkValidity()).map(e=>e.validationMessage);
      button.form.reportValidity();throw Error(`Browser form validation: ${[...new Set(invalid)].join(" ")}`);
    }
    responseBaseline=new Map([...document.querySelectorAll(responseSelector)].map(el=>[el,el.innerText?.trim()]));
    submitted=true;runId=c.runId;submittedAt=Date.now();network=[];
    sessionStorage.setItem("hkuPianoPending",JSON.stringify({runId,at:submittedAt}));
    document.dispatchEvent(new Event("hku-piano-arm-response"));
    button.click();
    return {clicked:true,at:submittedAt};
  }
  function slots(c){
    const found=[];
    for(const a of document.querySelectorAll("a[href],[data-href],[data-url]")){
      if(!visible(a)||a.closest(".unreservable,.reserved,.pasttime,.disabled,[aria-disabled=true]"))continue;
      const url=a.getAttribute("href")||a.getAttribute("data-href")||a.getAttribute("data-url");
      const slot=HKU.parseReservationURL(url);
      if(slot && slot.roomId===c.roomId && slot.date===c.date)found.push({...slot,url:new URL(url,location.href).href});
    }
    const map=new Map(found.map(s=>[s.start+"|"+s.end,s]));
    return {slots:[...map.values()].sort((a,b)=>a.start.localeCompare(b.start)),checkedAt:Date.now(),pageURL:location.href};
  }
  function status(){
    let enabled=false,buttonError="";
    try{const b=createButton();enabled=!b.disabled&&b.getAttribute("aria-disabled")!=="true";}catch(e){buttonError=e.message;}
    return {...probe(),captcha:captcha(),createEnabled:enabled,buttonError,typing:{complete:!!preparation?.complete,runId:preparation?.id||null,completedAt:preparation?.completedAt||0},result:result()};
  }
  chrome.runtime.onMessage.addListener((m,s,reply)=>{
    if(!m || !String(m.type).startsWith("HKU_"))return;
    try {
      let data;
      switch(m.type){
        case "HKU_PROBE":data=probe();break;
        case "HKU_TYPE_BEGIN":data=beginTyping(m.config);break;
        case "HKU_TYPE_FOCUS":data=focusTyping(m.config,m.index);break;
        case "HKU_TYPE_CHECK":data=checkTyping(m.config,m.index,m.expected);break;
        case "HKU_TYPE_REFOCUS":data=refocusTyping(m.config,m.index);break;
        case "HKU_TYPE_COMMIT":data=commitTyping(m.config,m.index);break;
        case "HKU_TYPE_FINISH":data=finishTyping(m.config);break;
        case "HKU_STATUS":data=status();break;
        case "HKU_SUBMIT":data=submit(m.config);break;
        case "HKU_READ_SLOTS":data=slots(m.config);break;
        case "HKU_IMPORT_SLOT":data={slot:HKU.parseReservationURL(location.href)};break;
        default:return;
      }
      reply({ok:true,...data});
    }catch(e){reply({ok:false,error:e.message});}
  });
})();
