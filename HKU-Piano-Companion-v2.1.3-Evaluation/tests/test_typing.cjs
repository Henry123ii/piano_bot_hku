const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const H=require('../shared.js');
const T=require('../typing.js');
const c={roomId:'2871',date:'2026-12-20',start:'14:00',end:'15:00',uid:'TEST-01',phone:'+852 12345678',people:'1',runId:'fixture-run'};
function setup(options={}){
 const state={events:[],values:['PREFILL','PREFILL','99'],focus:-1,url:H.reservationURL(c),cancelled:false,attached:0,detached:0,sleeps:[],lookups:0};
 const updatedListeners=new Set(),removedListeners=new Set();
 global.chrome={
  tabs:{
   get:async()=>{state.lookups++;return {url:state.url};},
   onUpdated:{addListener:f=>updatedListeners.add(f),removeListener:f=>updatedListeners.delete(f)},
   onRemoved:{addListener:f=>removedListeners.add(f),removeListener:f=>removedListeners.delete(f)}
  },
  storage:{session:{set:async()=>{},remove:async()=>{}}},
  debugger:{
   attach:async()=>{if(options.attachError)throw Error('Blocked');state.attached++;},
   detach:async()=>{state.detached++;},
   sendCommand:async(_,method,k)=>{
    assert.equal(method,'Input.dispatchKeyEvent');state.events.push(k);
    if(k.type==='rawKeyDown'&&k.key==='Backspace')state.values[state.focus]='';
    if(k.type==='keyDown'&&k.text){
     state.values[state.focus]+=k.text;
     if(options.cancel)state.cancelled=true;
     if(options.navigateDuringChar && !state.navigated){
       state.navigated=true;state.url='https://example.org/';
       for(const listener of updatedListeners)listener(42,{url:state.url});
     }
    }
   }
  }
 };
 const guard=()=>{if(state.cancelled)throw Error('Cancelled');};
 const message=async(_tab,type,args)=>{
  state.events.push(type);
  if(type==='HKU_TYPE_FOCUS'||type==='HKU_TYPE_REFOCUS')state.focus=args.index;
  if(type==='HKU_TYPE_CHECK'){
   if(options.interrupt && args.expected==='')throw Error('Typing was interrupted');
   assert.equal(state.values[args.index],args.expected);
  }
  if(type==='HKU_TYPE_FINISH')return {freshlyTyped:!options.noReceipt};
  return {ok:true};
 };
 return {state,opts:{tabId:42,message,guard,sleep:async n=>{state.sleeps.push(n);},progress:()=>{}}};
}
test('debugger is required, never optional, in the shipped manifest',()=>{
 const m=JSON.parse(fs.readFileSync(require.resolve('../manifest.json')));
 assert(m.permissions.includes('debugger'));assert(!m.optional_permissions?.includes('debugger'));
});
test('randomized inter-key delays stay in the configured 60-150ms range',()=>{
 assert.equal(T.randomDelay(T.KEY_DELAY,()=>0),60);assert.equal(T.randomDelay(T.KEY_DELAY,()=>0.999999),150);
 const draws=Array.from({length:100},()=>T.randomDelay(T.KEY_DELAY));assert(draws.every(x=>x>=60&&x<=150));assert(new Set(draws).size>10);
});
test('digit key mapping includes browser keyboard code',()=>assert.deepEqual(T.keyFor('7'),{key:'7',code:'Digit7',windowsVirtualKeyCode:55}));
test('typing target must exactly match confirmed HKU booking',()=>{
 assert.doesNotThrow(()=>T.validateURL(H.reservationURL(c),c));
 assert.throws(()=>T.validateURL(H.reservationURL(c).replace('hkufbs.hku.hk','other.example'),c));
 assert.throws(()=>T.validateURL(H.reservationURL({...c,roomId:'2873'}),c));
});
test('full typing sequence commits clearing then commits new text before its receipt',async()=>{
 const {state,opts}=setup();await T.fill(c,opts);
 assert.deepEqual(state.values,[c.uid,c.phone,c.people]);
 assert.equal(state.attached,1);assert.equal(state.detached,1);
 assert.equal(state.events.filter(x=>x==='HKU_TYPE_REFOCUS').length,3);
 assert.equal(state.events.filter(x=>x==='HKU_TYPE_COMMIT').length,3);
 assert.equal(state.events.filter(x=>x?.key==='Tab'&&x.type==='rawKeyDown').length,6);
 assert.equal(state.events.at(-1),'HKU_TYPE_FINISH');assert(state.sleeps.length>20);
 assert(state.lookups<=10,`Too many slow tab URL round-trips: ${state.lookups}`);
});
test('every invocation repeats all fields even when saved values already match',async()=>{
 const {state,opts}=setup();state.values=[c.uid,c.phone,c.people];await T.fill(c,opts);await T.fill({...c,runId:'another-run'},opts);
 assert.equal(state.events.filter(x=>x==='HKU_TYPE_BEGIN').length,2);
 assert.equal(state.events.filter(x=>x==='HKU_TYPE_COMMIT').length,6);
 assert.equal(state.detached,2);
});
test('cancelling partway detaches keyboard and cannot return a ready receipt',async()=>{
 const {state,opts}=setup({cancel:true});await assert.rejects(T.fill(c,opts),/Cancelled/);
 assert.equal(state.detached,1);assert(!state.events.includes('HKU_TYPE_FINISH'));
});
test('focus/text interruption detaches and fails closed',async()=>{
 const {state,opts}=setup({interrupt:true});await assert.rejects(T.fill(c,opts),/interrupted/);assert.equal(state.detached,1);
});
test('unrelated URL receives no debugger attachment and no keystrokes',async()=>{
 const {state,opts}=setup();state.url='https://example.org/';await assert.rejects(T.fill(c,opts),/restricted/);assert.equal(state.attached,0);assert.equal(state.events.length,0);
});
test('attachment failure reports a usable error without attempting fields',async()=>{
 const {state,opts}=setup({attachError:true});await assert.rejects(T.fill(c,opts),/Could not start browser keyboard input/);assert.equal(state.events.length,0);
});
test('a missing preparation receipt is not silently accepted',async()=>{
 const {state,opts}=setup({noReceipt:true});await assert.rejects(T.fill(c,opts),/receipt/);assert.equal(state.detached,1);
});

test('navigation away during typing aborts immediately and detaches keyboard',async()=>{
 const {state,opts}=setup({navigateDuringChar:true});
 await assert.rejects(T.fill(c,opts),/navigated away/);
 assert.equal(state.detached,1);
 assert(!state.events.includes('HKU_TYPE_FINISH'));
});
