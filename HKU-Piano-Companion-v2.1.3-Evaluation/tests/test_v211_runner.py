"""Real Chromium keyboard/input smoke test of runner.js against inert mock HKU pages.
No live network requests or official extension installation occur.
"""
import asyncio, time, os
from pathlib import Path
from playwright.async_api import async_playwright
P=Path(__file__).resolve().parents[1]
BASE='https://hkufbs.hku.hk/fbs/centralbook/book/Web/'
ID='22222222-2222-4222-a222-222222222222'
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(headless=True,executable_path='/usr/bin/chromium')
  ctx=await browser.new_context(viewport={'width':1040,'height':820});pages={};urls={};cdps={};nextid=20
  hist={'local':{},'session':{}};hist['session']['activeRun']={'id':ID,'status':'reserved','auto':True,'runnerWindowId':5};
  now=int(time.time()*1000)
  # Past relative to release; prepare-now is the rehearsal of the same engine.
  booking_date=__import__('datetime').datetime.fromtimestamp(time.time()+9*86400,__import__('datetime').timezone.utc).date().isoformat()
  timed=os.environ.get('HKU_RUNNER_TIMED')=='1'
  from datetime import datetime, timezone, timedelta
  release=datetime.now(timezone(timedelta(hours=8)))+timedelta(seconds=21)
  c={'roomId':'2871','date':booking_date,'start':'14:00','end':'15:00','people':'1','uid':'TEST-STUDENT','phone':'12345678','agreementAccepted':True,
     'mode':'scheduled' if timed else 'now','releaseDate':release.strftime('%Y-%m-%d'),'releaseTime':release.strftime('%H:%M:%S'),'offset':0.2 if timed else 0,'captchaLead':8 if timed else 10,'late':15,'dryRun':False,'runId':ID}
  hist['session']['runPayload']={'config':c,'auto':True}
  sent={'posts':0,'outcome':None,'attempts':0,'screenshots':0,'events':[]}
  errors=[]
  def store(area):
   d=hist[area]
   return d
  async def bridge(source,op,args):
   nonlocal nextid
   if op.startswith('storage.'):
    _,area,method=op.split('.');d=store(area)
    if method=='get':
     keys=args[0];keys=[keys] if isinstance(keys,str) else keys
     return {k:d[k] for k in (keys or d) if k in d}
    if method=='set':d.update(args[0]);return None
    if method=='remove':
     keys=args[0];keys=[keys] if isinstance(keys,str) else keys
     for k in keys:d.pop(k,None)
     return None
   if op=='tabs.getCurrent':return {'id':1,'windowId':5}
   if op=='tabs.create':
    t=args[0];id=nextid;nextid+=1;url=t['url'];page=await ctx.new_page();pages[id]=page;urls[id]=url
    if 'dashboard.php' in url:
     body='<!doctype html><title>HKUFBS Dashboard</title><a href="logout.php">Log out</a><a href="schedule.php">Booking</a>'
    else:
     body='''<!doctype html><title>HKUFBS reservation</title><a href="logout.php">Log out</a>
     <form id="booking"><label for="uid">Student UID No.</label><input id="uid" value="TEST-STUDENT">
     <label for="phone">Contact No.</label><input id="phone" value="12345678">
     <label for="people">Total Number of People Using the Room</label><input id="people" type="number" value="1">
     <input id="attribute-65" type="checkbox"><button type="submit">Create</button></form>
     <div id="reservationResponse" role="alert" style="display:none"></div>
     <script>window.__mockPosts=0;document.querySelector('#booking').addEventListener('submit',e=>{e.preventDefault();window.__mockPosts++;const el=document.querySelector('#reservationResponse');el.style.display='block';el.textContent='Reservation created successfully. Reference number: TEST-0001';});</script>'''
    await page.set_content(body)
    await page.evaluate('''() => {
     window.__fixtureSession={values:{},getItem(k){return this.values[k]||null},setItem(k,v){this.values[k]=v},removeItem(k){delete this.values[k]}};
     window.__listeners=[];
     window.chrome={runtime:{onMessage:{addListener:f=>window.__listeners.push(f)}}};
     window.__dispatch=m=>{let r;for(const f of window.__listeners){f(m,{},v=>r=v);}return r;};
    }''')
    code=(P/'shared.js').read_text()+'\n'+(P/'content.js').read_text()
    await page.evaluate('(a)=>new Function("location","sessionStorage",a.code)(new URL(a.url),window.__fixtureSession)',{'code':code,'url':url})
    return {'id':id,'url':url,'windowId':5,'status':'complete'}
   if op=='tabs.get':return {'id':args[0],'url':urls[args[0]],'status':'complete','windowId':5}
   if op=='tabs.update':return {'id':args[0],'url':urls[args[0]],'status':'complete','windowId':5}
   if op=='tabs.sendMessage':
    id,msg=args[0],args[1]
    if msg['type'] in ['HKU_CAPTCHA_CLICK','HKU_TYPE_FINISH','HKU_SUBMIT']:
     sent['events'].append((msg['type'],time.time()*1000))
    if msg['type']=='HKU_CAPTCHA_CLICK':return {'ok':True,'clicked':False}
    return await pages[id].evaluate('m=>window.__dispatch(m)',msg)
   if op=='scripting.executeScript':return []
   if op=='debugger.attach':cdps[args[0]['tabId']]=await ctx.new_cdp_session(pages[args[0]['tabId']]);return None
   if op=='debugger.sendCommand':return await cdps[args[0]['tabId']].send(args[1],args[2])
   if op=='debugger.detach':
    id=args[0]['tabId'];await cdps.pop(id).detach();return None
   if op=='runtime.sendMessage':
    m=args[0]
    if m['type']=='HKU_CLAIM_RUN':
     if hist['session']['activeRun']['status']!='reserved':return {'ok':True,'alreadyClaimed':True}
     hist['session']['activeRun']['status']='running';return {'ok':True,'alreadyClaimed':False}
    if m['type']=='HKU_RUN_ATTEMPT':hist['session']['activeRun']['status']='attempted';sent['attempts']+=1;return {'ok':True}
    if m['type']=='HKU_RUN_FINISHED':sent['outcome']=m['outcome'];hist['session'].pop('activeRun',None);return {'ok':True}
    raise RuntimeError('unexpected runtime '+m['type'])
   if op=='notifications.create':return args[0]
   if op=='windows.get':return {'id':5,'state':'normal'}
   if op=='windows.update':return {'id':5,'state':'normal'}
   raise RuntimeError('unhandled '+op)
  await ctx.expose_binding('__testChrome',bridge)
  runner=await ctx.new_page();runner.on('pageerror',lambda e:errors.append(str(e)))
  html=(P/'runner.html').read_text();import re
  html=re.sub(r'<link rel="stylesheet" href="([^"]+)">',lambda m:'<style>'+(P/m.group(1)).read_text()+'</style>',html)
  html=re.sub(r'<script src="([^"]+)"></script>',lambda m:'<script>'+(P/m.group(1)).read_text()+'</script>',html)
  stub='''window.chrome={
   runtime:{sendMessage:(...a)=>__testChrome('runtime.sendMessage',a)},
   storage:{local:{get:(...a)=>__testChrome('storage.local.get',a),set:(...a)=>__testChrome('storage.local.set',a)},session:{get:(...a)=>__testChrome('storage.session.get',a),set:(...a)=>__testChrome('storage.session.set',a),remove:(...a)=>__testChrome('storage.session.remove',a)}},
   tabs:{getCurrent:(...a)=>__testChrome('tabs.getCurrent',a),create:(...a)=>__testChrome('tabs.create',a),get:(...a)=>__testChrome('tabs.get',a),update:(...a)=>__testChrome('tabs.update',a),sendMessage:(...a)=>__testChrome('tabs.sendMessage',a)},
   debugger:{attach:(...a)=>__testChrome('debugger.attach',a),sendCommand:(...a)=>__testChrome('debugger.sendCommand',a),detach:(...a)=>__testChrome('debugger.detach',a)},
   scripting:{executeScript:(...a)=>__testChrome('scripting.executeScript',a)},
   notifications:{create:(...a)=>__testChrome('notifications.create',a)},
   windows:{get:(...a)=>__testChrome('windows.get',a),update:(...a)=>__testChrome('windows.update',a)}
   };
   if(!crypto.randomUUID)crypto.randomUUID=()=>"11111111-1111-4111-a111-111111111111";'''
  html=html.replace('<script>', '<script>'+stub,1)
  # Chromium about:blank URL cannot have query; simulate through a wrapper URL API.
  html=html.replace("const getParam=new URL(location.href).searchParams;",f"const getParam=new URL('https://example.invalid/runner.html?run={ID}').searchParams;")
  await runner.set_content(html)
  await runner.wait_for_function("document.getElementById('stage').textContent.includes('success') || document.getElementById('stage').textContent.includes('Stopped')",timeout=40000)
  assert sent['outcome']=='success',await runner.locator('#log').inner_text()
  assert sent['attempts']==1
  book=next((p for i,p in pages.items() if '/reservation/?' in urls[i]),None)
  assert book is not None
  assert await book.evaluate('window.__mockPosts')==1
  assert 'successfully' in await runner.locator('#resultText').inner_text()
  assert not errors,errors
  if not timed: await runner.screenshot(path=str(P/'docs/screenshots/runner-v211.png'),full_page=True)
  if timed:
   seq={name:at for name,at in sent['events']}
   target=release.replace(microsecond=0).timestamp()*1000+200
   assert seq['HKU_TYPE_FINISH']<seq['HKU_CAPTCHA_CLICK']<seq['HKU_SUBMIT'],seq
   assert seq['HKU_SUBMIT']>=target-5,(seq,target)
   print('PASS: scheduled runner: typing before CAPTCHA before Create; one submitted request at or after target.')
  print('PASS: dedicated runner freshly typed and submitted exactly once; simulated HKU success captured with no live network.')
  await browser.close()
if __name__=='__main__':asyncio.run(main())
