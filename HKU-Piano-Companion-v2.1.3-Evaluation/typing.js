/* Native browser keyboard input for the three confirmed HKU booking fields.
 * No CAPTCHA solving, fingerprint changes, or generic debugging RPC is exposed.
 * The companion awaits the full typing receipt before it can send Create.
 */
(function(root){
  "use strict";
  const KEY_DELAY={min:60,max:150};
  const HOLD_DELAY={min:10,max:25};
  const FIELD_DELAY={min:75,max:150};
  const FIELDS=[{key:"uid",label:"Student UID"},{key:"phone",label:"Contact number"},{key:"people",label:"Number of room users"}];
  // Estimate with the full 150 ms character pause, keyboard/event overhead,
  // page navigation and a 2-second gap before the CAPTCHA target.
  // These are conservative estimates, not hard limits on a frozen browser.
  const BUFFER_MS=2000, LOAD_ALLOWANCE_MS=20000, LOGIN_ALLOWANCE_MS=30000;
  const BROWSER_BASE_MS=3000, BROWSER_PER_CHARACTER_MS=180, BROWSER_PER_FIELD_MS=1800;
  function estimate(c){
    const chars=FIELDS.reduce((n,f)=>n+Array.from(String(c[f.key]||"")).length,0);
    const pauses=chars*(KEY_DELAY.max+HOLD_DELAY.max)+FIELDS.length*2*FIELD_DELAY.max;
    const browser=BROWSER_BASE_MS+chars*BROWSER_PER_CHARACTER_MS+FIELDS.length*BROWSER_PER_FIELD_MS;
    return {chars,pauses,browser,total:pauses+browser,minimumPerCharacterBudget:chars*KEY_DELAY.max};
  }
  function plan(c,now=Date.now()){
    const p=root.HKU.plan(c,now),e=estimate(c);
    if(c.mode!=="scheduled")return {...p,typingTarget:null,effectiveEarly:0,advancedBy:0,recommendedStartAt:now};
    const typingTarget=p.captchaAt-BUFFER_MS;
    // Fixed 60-second lead independent of user-controlled Create offset.
    // Do not move the CAPTCHA/Create times based on typing estimates.
    const estimatedTypingFinishAt=p.openAt+LOAD_ALLOWANCE_MS+e.total;
    const preparationMarginMs=typingTarget-estimatedTypingFinishAt;
    return {...p,typingTarget,effectiveEarly:root.HKU.FORM_OPEN_LEAD_MS/1000,advancedBy:0,
      recommendedStartAt:p.openAt-LOGIN_ALLOWANCE_MS,minimumTypingLeadMs:e.total+LOAD_ALLOWANCE_MS+BUFFER_MS,
      estimatedTypingFinishAt,preparationMarginMs};
  }
  // Select each pause once and honor it, even when the scheduled time is
  // already past. No deadline-based compression or skipped keystrokes.
  // Opening stays at 60 seconds before release; no countdown-driven pause compression.
  function createPacer(c,target=null,{clock=Date.now,rng=Math.random}={}){
    const pauses=[];
    for(const f of FIELDS){
      pauses.push(randomDelay(FIELD_DELAY,rng));
      for(const ch of String(c[f.key]||"")){
        pauses.push(randomDelay(KEY_DELAY,rng),randomDelay(HOLD_DELAY,rng));
      }
      pauses.push(randomDelay(FIELD_DELAY,rng));
    }
    let index=0;
    return {
      observe(){},
      next(){return pauses[index++]||0;},
      get compressed(){return false;},
      get late(){return Number.isFinite(target)&&clock()>target;}
    };
  }
  function randomDelay(range,rng=Math.random){return Math.floor(range.min+rng()*(range.max-range.min+1));}
  function keyFor(char){
    if(/^[0-9]$/.test(char))return {key:char,code:`Digit${char}`,windowsVirtualKeyCode:char.charCodeAt(0)};
    if(/^[a-z]$/i.test(char))return {key:char,code:`Key${char.toUpperCase()}`,windowsVirtualKeyCode:char.toUpperCase().charCodeAt(0)};
    const map={" ":["Space",32],"-":["Minus",189],"+":["Equal",187],"(":["Digit9",57],")":["Digit0",48],".":["Period",190],"@":["Digit2",50],"_":["Minus",189]};
    const mapped=map[char];
    return {key:char,code:mapped?mapped[0]:"",windowsVirtualKeyCode:mapped?mapped[1]:0};
  }
  function validateURL(value,c){
    const s=root.HKU.parseReservationURL(value);
    if(!s || s.roomId!==c.roomId || s.date!==c.date || s.start!==root.HKU.timeValue(c.start) || s.end!==root.HKU.timeValue(c.end) || root.HKU.endDate(s)!==root.HKU.endDate(c)){
      throw Error("Keyboard input is restricted to this attempt's confirmed HKU reservation tab. No Create click was sent.");
    }
  }
  async function fill(c,{tabId,message:rawMessage,guard,sleep,progress=()=>{},typingTarget=null}){
    const pacer=createPacer(c,typingTarget);
    const measure=async fn=>{const start=Date.now();try{return await fn();}finally{pacer.observe(Date.now()-start);}};
    const message=(...args)=>measure(()=>rawMessage(...args));
    const pause=async()=>{
      const ms=pacer.next();
      await sleep(ms);guard();
    };
    if(!Number.isInteger(tabId))throw Error("The booking tab is missing. No Create click was sent.");
    if(!chrome.debugger?.attach)throw Error("Browser keyboard input is unavailable. Allow the typing permission in Edge and try a rehearsal. No Create click was sent.");
    const target={tabId};let attached=false,unsafeNavigation=false;
    // The page remains restricted to the selected reservation URL. Listening
    // for navigation lets us avoid a slow chrome.tabs.get call before every
    // individual keydown/keyup; the URL is still checked at each field boundary.
    const onUpdated=(id,change)=>{
      if(id===tabId&&change?.url){
        try{validateURL(change.url,c);}catch{unsafeNavigation=true;}
      }
    };
    const onRemoved=id=>{if(id===tabId)unsafeNavigation=true;};
    const safeGuard=()=>{
      guard();
      if(unsafeNavigation)throw Error("The HKU booking tab navigated away during typing. No Create click was sent.");
    };
    const checkTab=async()=>{
      safeGuard();const tab=await chrome.tabs.get(tabId);safeGuard();validateURL(tab.url,c);
    };
    const send=async params=>{
      safeGuard();
      await measure(()=>chrome.debugger.sendCommand(target,"Input.dispatchKeyEvent",params));
      safeGuard();
    };
    const press=async(key,code,virtualKey,extra={})=>{
      await send({type:"rawKeyDown",key,code,windowsVirtualKeyCode:virtualKey,...extra});
      await send({type:"keyUp",key,code,windowsVirtualKeyCode:virtualKey,...extra});
    };
    try{
      chrome.tabs.onUpdated?.addListener(onUpdated);
      chrome.tabs.onRemoved?.addListener(onRemoved);
      await checkTab();
      await chrome.storage.session.set({typingTabId:tabId});safeGuard();
      try{await chrome.debugger.attach(target,"1.3");attached=true;}
      catch(e){throw Error(`Could not start browser keyboard input. Allow the typing permission and close Developer Tools on the booking tab. ${e.message}. No Create click was sent.`);}
      guard();await message(tabId,"HKU_TYPE_BEGIN",{config:c});
      for(let index=0;index<FIELDS.length;index++){
        await checkTab();safeGuard();const spec=FIELDS[index],text=String(c[spec.key]);
        progress(`Clearing and typing ${spec.label} (${index+1}/${FIELDS.length}).`);
        await message(tabId,"HKU_TYPE_FOCUS",{config:c,index});
        // Browser editing command avoids assuming Ctrl vs Command on the user's OS.
        // Never assign el.value, even if the page already shows the correct details.
        await press("a","KeyA",65,{commands:["selectAll"]});
        await press("Backspace","Backspace",8);
        await message(tabId,"HKU_TYPE_CHECK",{config:c,index,expected:""});
        // Commit the empty value before retyping. Otherwise clearing and retyping
        // an identical prefilled value may produce no change event on final blur.
        await press("Tab","Tab",9);
        await pause();
        await message(tabId,"HKU_TYPE_REFOCUS",{config:c,index});
        // Browser-generated key and input events are counted by the HKU page
        // helper. Checking after every character added many slow browser RPCs;
        // one full-field check and the trusted-event receipt give the same
        // failure-safe validation without repeated round trips.
        for(const char of text){
          await pause();
          const key=keyFor(char);
          await send({type:"keyDown",...key,text:char,unmodifiedText:char});
          await pause();
          await send({type:"keyUp",...key});
        }
        await message(tabId,"HKU_TYPE_CHECK",{config:c,index,expected:text});
        // Tab commits change/blur handlers like normal keyboard form entry.
        await press("Tab","Tab",9);
        await pause();
        await message(tabId,"HKU_TYPE_COMMIT",{config:c,index});
        await checkTab();
      }
      guard();const receipt=await message(tabId,"HKU_TYPE_FINISH",{config:c});
      if(!receipt.freshlyTyped)throw Error("The fresh typing receipt was not returned. No Create click was sent.");
      return receipt;
    }finally{
      chrome.tabs.onUpdated?.removeListener?.(onUpdated);
      chrome.tabs.onRemoved?.removeListener?.(onRemoved);
      if(attached){try{await chrome.debugger.detach(target);}catch{}}
      try{await chrome.storage.session.remove("typingTabId");}catch{}
    }
  }
  root.HKUTyping={fill,randomDelay,keyFor,validateURL,KEY_DELAY,HOLD_DELAY,FIELD_DELAY,estimate,plan,createPacer,BUFFER_MS,LOAD_ALLOWANCE_MS,LOGIN_ALLOWANCE_MS};
  if(typeof module!=="undefined")module.exports=root.HKUTyping;
})(typeof globalThis!=="undefined"?globalThis:this);
