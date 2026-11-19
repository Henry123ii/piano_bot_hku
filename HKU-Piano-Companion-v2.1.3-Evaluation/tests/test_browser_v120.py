"""DOM fixtures with mocked extension/network APIs. All real requests are blocked. Never books HKU."""
import json
import os
import shutil
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright
import asyncio
import fnmatch
import mimetypes

EXT=Path(__file__).resolve().parents[1]
OUT=EXT / "test-output"
OUT.mkdir(exist_ok=True)
BASE='https://hkufbs.hku.hk/fbs/centralbook/book/Web/'
state={'auth':True,'captcha':'auto','response':'success','posts':0,'post_times':[],'button_enabled':True,'permission':True,'prefill_same':True,'detaches':0}
results=[]
errors=[]

def dashboard():
    return '<!doctype html><title>HKUFBS Dashboard</title><h1>Dashboard</h1><a href="logout.php">Log out</a><a href="schedule.php">Bookings</a>'

def calendar(url):
    date=parse_qs(urlparse(url).query).get('sd',['2026-11-12'])[0]
    def link(room,start,end,cls=''):
        return f'<a class="{cls}" href="reservation/?rid={room}&sid=421&rd={date}&sd={date}%20{start}%3A00%3A00&ed={date}%20{end}%3A00%3A00">{start}:00 to {end}:00</a><br>'
    return '<!doctype html><title>HKUFBS Bookings</title><a href="logout.php">Log out</a><h1>Live schedule fixture</h1>'+link('2871','14','15')+link('2871','15','16')+link('2873','14','15')+link('2871','16','17','reserved')

def reservation():
    cap=state['captcha']
    script='''
    let verifyCount=0;
    window.typingEvents=[];
    const typedFields=['attribute-uid','attribute-phone','attribute-people'];
    window.fieldEvidence=Object.fromEntries(typedFields.map(id=>[id,{keys:0,inputs:0,changes:0,empty:false}]));
    for(const id of typedFields){
      const el=document.getElementById(id);
      for(const kind of ['keydown','input','change','blur'])el.addEventListener(kind,e=>{
        window.typingEvents.push({id,kind,trusted:e.isTrusted,at:performance.now(),value:el.value,key:e.key||''});
        const f=window.fieldEvidence[id];
        if(e.isTrusted){
          if(kind==='keydown' && e.key.length===1)f.keys++;
          if(kind==='input'){f.inputs++;if(el.value==='')f.empty=true;}
          if(kind==='change')f.changes++;
        }
        document.querySelector('button[type=submit]').disabled=!ALLOW_BUTTON || !typedFields.every(id=>{
          const f=window.fieldEvidence[id],v=document.getElementById(id).value;
          return f.empty && f.keys>=v.length && f.inputs>=v.length && f.changes>0 && v.length>0;
        });
      });
    }
    function solveFixture(){document.getElementById('g-recaptcha-response').value='TEST-RESPONSE';document.getElementById('challenge').style.display='none';}
    window.addEventListener('message',e=>{
      if(e.data?.fixture==='verified'){
        solveFixture();verifyCount++;
        if(CAPTCHA==='expire' && verifyCount===1)setTimeout(()=>{document.getElementById('g-recaptcha-response').value='';},350);
      }
      if(e.data?.fixture==='challenge')document.getElementById('challenge').style.display='block';
    });
    document.getElementById('manual-solve').onclick=solveFixture;
    document.getElementById('booking').onsubmit=async e=>{
      e.preventDefault();window.clickCount=(window.clickCount||0)+1;
      const r=await fetch('/fbs/centralbook/book/Web/reservation_save.php',{method:'POST',body:'fixture=1'});
      const text=await r.text();
      const div=document.getElementById('reservationResponse');div.textContent=text;div.style.display='block';
    };
    '''.replace('CAPTCHA',json.dumps(cap)).replace('ALLOW_BUTTON',json.dumps(state['button_enabled']))
    return f'''<!doctype html><title>HKUFBS Reservation</title><a href="../logout.php">Log out</a>
    <style>body{{font:16px sans-serif}}label,input{{display:block;margin:8px}}textarea{{display:none}}#challenge{{display:none}}</style>
    <div class="alert">Reservation created successfully last week. This is an OLD announcement.</div>
    <form id="booking">
    <label for="attribute-uid">Student UID No.</label><input id="attribute-uid" required value="{'TEST-STUDENT' if state['prefill_same'] else 'STALE'}">
    <label for="attribute-phone">Contact No.</label><input id="attribute-phone" required value="{'12345678' if state['prefill_same'] else 'STALE'}">
    <label for="attribute-people">Total Number of People Using the Room</label><input id="attribute-people" required type="number" value="{'1' if state['prefill_same'] else '99'}">
    <label><input id="attribute-65" type="checkbox" required>Agreement</label>
    <iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor?fixture={cap}" width="310" height="90"></iframe>
    <textarea id="g-recaptcha-response" name="g-recaptcha-response"></textarea>
    <iframe id="challenge" title="recaptcha challenge" src="https://www.google.com/recaptcha/api2/bframe?fixture=1" width="400" height="300"></iframe>
    <button type="button" id="manual-solve">Fixture: user solves challenge</button>
    <button type="submit" disabled>Create</button>
    </form><div id="reservationResponse" role="alert" style="display:none"></div>
    <script>{script}</script>'''

# This environment blocks loading extensions by browser policy. We test the real
# application/content scripts in Chromium with a narrow Chrome API test double.
# These tests do NOT validate Edge extension installation or OS notifications.
STORAGE={'local':{},'session':{}}
NOTIFICATIONS=[]
SEQUENCE=[]
TAB_PAGES={}

async def main():
    async with async_playwright() as p:
        exe=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium')
        kwargs={'headless':True,'timeout':15000}
        if exe: kwargs['executable_path']=exe
        browser=await p.chromium.launch(**kwargs)
        ctx=await browser.new_context(viewport={'width':1060,'height':900})
        ctx.set_default_timeout(12000)
        # Managed Chromium blocks URL navigation; use inert about:blank DOM fixtures.
        # No real network requests are made or permitted by this test.
        async def deny_network(route): await route.abort()
        await ctx.route("**/*",deny_network)
        next_id=1
        TAB_URLS={}
        TAB_KINDS={}
        CDP={}
        KEY_CALLS=[]
        def tab_info(id,page):
            return {'id':id,'windowId':1,'url':TAB_URLS[id],'status':'complete','lastAccessed':id*1000}
        async def bridge(source,op,args):
            nonlocal next_id
            if op=='permissions.contains':return state['permission']
            if op=='runtime.sendMessage':
                if args[0]['type']=='HKU_TEST_REMINDER':NOTIFICATIONS.append({'test':True})
                return {'ok':True}

            if op=='debugger.attach':
                id=args[0]['tabId']
                CDP[id]=await ctx.new_cdp_session(TAB_PAGES[id])
                return None
            if op=='debugger.detach':
                id=args[0]['tabId']
                if id in CDP:
                    await CDP.pop(id).detach();state['detaches']+=1
                return None
            if op=='debugger.sendCommand':
                id=args[0]['tabId']
                assert args[1]=='Input.dispatchKeyEvent', 'Unexpected debugging capability used'
                KEY_CALLS.append({'tabId':id,'params':args[2],'at':time.time()})
                return await CDP[id].send(args[1],args[2])
            if op.startswith('storage.'):
                _,area,method=op.split('.')
                store=STORAGE[area]
                if method=='get':
                    keys=args[0]
                    if isinstance(keys,str):keys=[keys]
                    return {k:store[k] for k in (keys or store.keys()) if k in store}
                if method=='set':store.update(args[0]);return None
                if method=='remove':
                    keys=args[0];keys=[keys] if isinstance(keys,str) else keys
                    for key in keys:store.pop(key,None)
                    return None
                if method=='clear':store.clear();return None
            if op=='windows.getAll':return [{'id':1,'focused':True,'state':'normal','type':'normal'}]
            if op=='windows.get':return {'id':1,'state':'normal'}
            if op=='windows.update':return {'id':1,'state':'normal'}
            if op=='tabs.create':
                id=next_id;next_id+=1
                page=await ctx.new_page();TAB_PAGES[id]=page
                TAB_URLS[id]=args[0]['url']
                await render_site(page,args[0]['url'],id)
                return tab_info(id,page)
            if op=='tabs.get':return tab_info(args[0],TAB_PAGES[args[0]])
            if op=='tabs.update':
                page=TAB_PAGES[args[0]]
                if args[1].get('url'):
                    TAB_URLS[args[0]]=args[1]['url']
                    await render_site(page,args[1]['url'],args[0])
                return tab_info(args[0],page)
            if op=='tabs.query':
                pattern=args[0].get('url','*')
                return [tab_info(i,page) for i,page in TAB_PAGES.items() if fnmatch.fnmatch(TAB_URLS[i],pattern)]
            if op=='tabs.sendMessage':
                id,msg=args[:2];page=TAB_PAGES[id]
                if msg.get('type') in ['HKU_TYPE_FINISH','HKU_CAPTCHA_CLICK','HKU_SUBMIT']:
                    SEQUENCE.append({'type':msg['type'],'at':time.time()*1000,'tabId':id})
                if len(args)>2 and args[2].get('frameId')==0:
                    return await page.evaluate('(m)=>window.__fixtureDispatch?.(m)',msg)
                for frame in page.frames:
                    ans=await frame.evaluate('(m)=>window.__fixtureDispatch?.(m)',msg)
                    if ans is not None:return ans
                return None
            if op=='scripting.executeScript':
                opts=args[0];page=TAB_PAGES[opts['target']['tabId']]
                for file in opts['files']:
                    await page.evaluate('(a)=>new Function("location",a.code)(new URL(a.url))',{'code':(EXT/file).read_text(),'url':TAB_URLS[opts['target']['tabId']]})
                return []
            if op=='notifications.create':NOTIFICATIONS.append(args);return args[0]
            if op=='notifications.clear':return True
            raise RuntimeError('Unimplemented test API '+op)
        await ctx.expose_binding('__fixtureChrome',bridge)
        app_stub='''
        (()=>{
        const call=(op)=>(...args)=>window.__fixtureChrome(op,args);
        const storage={};for(const area of ['local','session']){storage[area]={};for(const m of ['get','set','remove','clear'])storage[area][m]=call('storage.'+area+'.'+m);}
        window.chrome={permissions:{contains:call('permissions.contains')},debugger:{attach:call('debugger.attach'),detach:call('debugger.detach'),sendCommand:call('debugger.sendCommand')},storage,tabs:{create:call('tabs.create'),get:call('tabs.get'),update:call('tabs.update'),query:call('tabs.query'),sendMessage:call('tabs.sendMessage')},
        windows:{getAll:call('windows.getAll'),get:call('windows.get'),update:call('windows.update')},
        scripting:{executeScript:call('scripting.executeScript')},notifications:{create:call('notifications.create'),clear:call('notifications.clear')},
        runtime:{getURL:(s)=>'http://localhost:8765/'+s,sendMessage:call('runtime.sendMessage'),onMessage:{addListener:()=>{}}}};
        })();'''
        content_stub='''
        window.__fixtureListeners=[];
        window.chrome={runtime:{onMessage:{addListener:(f)=>window.__fixtureListeners.push(f)}}};
        window.__fixtureDispatch=(m)=>{let answer=null;for(const f of window.__fixtureListeners)f(m,{},(r)=>answer=r);return answer;};
        '''
        main_sources=(EXT/'shared.js').read_text()+'\n'+(EXT/'content.js').read_text()
        frame_source=(EXT/'captcha-frame.js').read_text()
        init=f'''
        if(location.hostname==='localhost'){{{app_stub}}}
        else if(location.hostname==='hkufbs.hku.hk'){{{content_stub};document.addEventListener('DOMContentLoaded',()=>{{(0,eval)({json.dumps(main_sources)});}});}}
        else if(location.hostname==='www.google.com'){{{content_stub};document.addEventListener('DOMContentLoaded',()=>{{(0,eval)({json.dumps(frame_source)});}});}}
        '''
        async def render_site(page,url,id):
            await page.goto('about:blank')
            if 'schedule.php' in url:
                body=calendar(url)
            elif '/reservation/?' in url:
                body=reservation()
            elif not state['auth']:
                body='<title>HKUFBS - Log In</title><a href="#" id="test-login">Log In With HKU SSO</a>'
            else:
                body=dashboard()
            await page.set_content(body,wait_until='domcontentloaded')
            if not state['auth'] and '/dashboard.php' in url:
                async def do_login(source):
                    state['auth']=True
                    await render_site(page,url,id)
                try:await page.expose_binding('__fixtureLogin',do_login)
                except:pass
                await page.evaluate("() => { document.getElementById('test-login').onclick=(e)=>{e.preventDefault();window.__fixtureLogin();}; }")
            await page.evaluate(content_stub)
            await page.evaluate("window.__fixtureSession={values:{},getItem(k){return this.values[k]||null},setItem(k,v){this.values[k]=v},removeItem(k){delete this.values[k]}}")
            await page.evaluate('(a)=>new Function("location","sessionStorage",a.code)(new URL(a.url),window.__fixtureSession)',{'code':main_sources,'url':url})
            if '/reservation/?' in url:
                async def post(source):
                    state['posts']+=1;state['post_times'].append(time.time()*1000)
                    return 'Reservation created successfully.\nReference number: TEST-0001' if state['response']=='success' else 'Reservation could not be made: the selected time conflicts with an existing reservation.'
                await page.expose_binding('__fixturePost',post)
                await page.evaluate("() => { window.fetch=async function(){return new Response(await window.__fixturePost(),{status:200,headers:{'Content-Type':'text/plain'}})}; }")
                evt='challenge' if state['captcha']=='manual' else 'verified'
                anchor='<button role="checkbox" aria-checked="false" id="recaptcha-anchor">I am not a robot</button><script>document.getElementById("recaptcha-anchor").onclick=function(){this.setAttribute("aria-checked","true");parent.postMessage({fixture:'+json.dumps(evt)+'},"*");};</script>'
                await page.locator('iframe[title="reCAPTCHA"]').evaluate('(el,html)=>el.srcdoc=html',anchor)
                await page.locator('#challenge').evaluate('(el)=>el.srcdoc="<p>SIMULATED CHALLENGE</p>"')
                await page.wait_for_timeout(100)
                for frame in page.frames:
                    if frame!=page.main_frame:
                        await frame.evaluate(content_stub)
                        await frame.evaluate(frame_source)

        app=await ctx.new_page()
        app.on('pageerror',lambda e:errors.append(str(e)))
        html=(EXT/'app.html').read_text()
        html=html.replace('<link rel="stylesheet" href="app.css">','<style>'+(EXT/'app.css').read_text()+'</style>')
        boot=app_stub+'\nif(!crypto.randomUUID)crypto.randomUUID=()=>"fixture-"+Date.now()+"-"+Math.floor(Math.random()*1000000);'
        import re
        html=re.sub(r'<script src="([^"]+)"></script>',lambda m:'<script>'+ (EXT/m.group(1)).read_text()+'</script>',html)
        html=html.replace('<script>','<script>'+boot+'</script><script>',1)
        await app.set_content(html,wait_until='domcontentloaded')

        await app.wait_for_selector('#weeklyRoom option',state='attached')
        await app.wait_for_timeout(200)
        def passed(text):results.append('PASS '+text);print(results[-1],flush=True)
        async def finish(text,timeout=30000):
            try:
                await app.wait_for_function('(s)=>document.getElementById("stage").textContent.includes(s) && !document.getElementById("confirmBtn").disabled',arg=text,timeout=timeout)
            except:
                print('LOG',await app.locator('#log').inner_text(),flush=True)
                print('FLASH',await app.locator('#flash').inner_text(),flush=True)
                print('STAGE',await app.locator('#stageDetail').inner_text(),flush=True)
                print('ERRORS',errors,flush=True)
                raise
        async def book(dry=False):
            await app.locator('#dryRun').set_checked(dry)
            await app.locator('#confirmBtn').click()
            await app.locator('#reviewDialog').wait_for(state='visible')
            await app.locator('#reviewStart').click()
            await app.wait_for_function('currentRun!==null',timeout=5000)
        def booking():return next(page for i,page in reversed(list(TAB_PAGES.items())) if '/reservation/?' in TAB_URLS[i])
        # Only the critical order/timing case when requested; keep the original
        # complete regression suite accessible without running it by default.
        if os.environ.get('HKU_FOCUSED_ORDER_TEST')=='1':
            await app.locator('#reserveBtn').click()
            await app.locator('#uid').fill('TEST-STUDENT')
            await app.locator('#phone').fill('12345678')
            await app.locator('#agreement').check()
            await app.locator('#autoRelease').uncheck()
            await app.locator('#mode').select_option('scheduled')
            at=await app.evaluate('HKU.hkParts(Date.now()+17500)')
            await app.locator('#releaseDate').fill(at['date'])
            await app.locator('#releaseTime').fill(at['time'])
            await app.locator('#captchaLead').fill('5')
            await app.locator('#captchaLead').dispatch_event('change')
            target=await app.evaluate('HKUTyping.plan(readConfig())')
            await book(False)
            await finish('indicates success',35000)
            bp=booking()
            id=next(i for i,p in TAB_PAGES.items() if p==bp)
            seq=[x for x in SEQUENCE if x['tabId']==id]
            typed=next(x['at'] for x in seq if x['type']=='HKU_TYPE_FINISH')
            captcha=next(x['at'] for x in seq if x['type']=='HKU_CAPTCHA_CLICK')
            create=next(x['at'] for x in seq if x['type']=='HKU_SUBMIT')
            assert typed<captcha<create,(typed,captcha,create)
            assert typed<target['captchaAt'],(typed,target['captchaAt'])
            assert captcha<target['clickAt'],(captcha,target['clickAt'])
            assert create>=target['clickAt']-250,(create,target['clickAt'])
            assert state['posts']==1,state['posts']
            assert all(v['empty'] and v['keys']>0 and v['changes']>0 for v in (await bp.evaluate('window.fieldEvidence')).values() )
            passed('LIVE browser fixture: all fields freshly retyped and verified BEFORE scheduled CAPTCHA BEFORE Create')
            passed('CAPTCHA precedes target Create time; exactly one POST; no field skipped')
            assert not errors,errors
            report={'checks':results,'timing':{'typed':typed,'captcha':captcha,'create':create,'scheduled_captcha':target['captchaAt'],'scheduled_create':target['clickAt']},'real_HKU_network':False}
            (OUT/'focused-browser-v121.json').write_text(json.dumps(report,indent=2))
            await browser.close()
            return
        assert not await app.locator('#dryRun').is_checked()
        assert await app.locator('#weeklyBtn').is_visible()
        assert await app.locator('#instructionBtn').is_visible()
        await app.screenshot(path=str(OUT/'home-preview.png'),full_page=True)
        await app.locator('#instructionBtn').click()
        text=await app.locator('#instructionDialog').inner_text()
        assert all(x in text for x in ['VPN','manually','six days','Test only','Hong Kong'])
        await app.screenshot(path=str(OUT/'instruction-preview.png'),full_page=True)
        await app.locator('#instructionDone').click()
        passed('three home actions, instructions and live default render without starting a booking')

        await app.locator('#reserveBtn').click()
        await app.locator('#uid').fill('TEST-STUDENT');await app.locator('#phone').fill('12345678')
        await app.locator('#agreement').check();await app.wait_for_timeout(350)
        assert STORAGE['local']['agreementConsent']['accepted'] is True
        assert STORAGE['local']['preferences']['uid']=='TEST-STUDENT'
        passed('agreement and remembered personal details save immediately, before any booking')

        # Invalid combinations normalize without changing the room/release selection.
        await app.locator('#captchaLead').fill('50');await app.locator('#captchaLead').dispatch_event('change')
        await app.locator('#early').fill('5');await app.locator('#early').dispatch_event('change')
        values=await app.evaluate('({e:+document.getElementById("early").value,c:+document.getElementById("captchaLead").value,o:+document.getElementById("offset").value})')
        assert values['e']>=values['c']+5 and values['c']+values['o']<=20.001
        await app.locator('#captchaLead').fill('10');await app.locator('#captchaLead').dispatch_event('change')
        await app.locator('#early').fill('30');await app.locator('#early').dispatch_event('change')
        passed('conflicting timing entries are corrected to keep opening before CAPTCHA and <=20s to Create')

        await app.locator('#weeklyBtn').click()
        target_day=await app.evaluate('HKUWeekly.weekday(HKU.hkParts(Date.now()+2*86400000).date)')
        await app.locator('#weeklyDay').select_option(str(target_day))
        await app.locator('#weeklyStart').fill('11:00')
        await app.locator('#weeklySave').click();await app.wait_for_timeout(250)
        assert len(STORAGE['local'].get('weeklyEntries',[]))==1,await app.locator('#flash').inner_text()
        assert await app.locator('#weeklyRuns tr').count()>=2
        before=state['posts'];await app.locator('#weeklySave').click();await app.wait_for_timeout(200)
        assert len(STORAGE['local']['weeklyEntries'])==1 and state['posts']==before
        assert 'overlaps' in await app.locator('#flash').inner_text()
        # Add two more non-overlapping days for screenshot and recurrence coverage.
        for day,start in [((target_day+2)%7,'16:00'),((target_day+4)%7,'23:00')]:
            await app.locator('#weeklyDay').select_option(str(day));await app.locator('#weeklyStart').fill(start)
            await app.locator('#weeklySave').click();await app.wait_for_timeout(200)
        await app.evaluate('flash("")')
        await app.screenshot(path=str(OUT/'weekly-preview.png'),full_page=True)
        assert state['posts']==before
        passed('weekly rows persist, calculate a 14-day run table, reject overlaps and send no booking')

        await app.locator('#testReminderBtn').click();await app.wait_for_timeout(150)
        assert any(isinstance(x,dict) and x.get('test') for x in NOTIFICATIONS)
        passed('notification test requests an alert without creating or submitting an HKU tab')

        # Select a released future session; it must retain its date, not roll to next week.
        o=await app.evaluate('async()=>HKUWeekly.occurrences((await chrome.storage.local.get("weeklyEntries")).weeklyEntries).find(o=>o.releaseAt<Date.now())')
        # evaluate expression above needs an async function in page context
        await app.evaluate('(o)=>HKUPlanner.select(o)',o)
        await app.locator('#reviewDialog').wait_for(state='visible')
        assert await app.locator('#date').input_value()==o['date']
        assert await app.locator('#mode').input_value()=='now'
        assert state['posts']==before
        await app.locator('#reviewBack').click()
        passed('weekly slot opens a review for its exact dated occurrence; no submission without confirm')

        await book(True);await finish('Rehearsal complete')
        bp=booking();evidence=await bp.evaluate('window.fieldEvidence')
        assert all(v['empty'] and v['keys']>0 and v['changes']>0 for v in evidence.values())
        events=await bp.evaluate('window.typingEvents')
        assert all(e['trusted'] for e in events if e['kind'] in ['keydown','input','change'])
        assert state['posts']==before
        seq=[x['type'] for x in SEQUENCE if x['tabId']==next(i for i,p in TAB_PAGES.items() if p==bp)]
        assert seq.index('HKU_TYPE_FINISH')<seq.index('HKU_CAPTCHA_CLICK') and 'HKU_SUBMIT' not in seq
        passed('native randomized typing clears matching prefills and completes BEFORE CAPTCHA; rehearsal never submits')

        await book(False);await finish('indicates success')
        assert state['posts']==before+1
        assert STORAGE['local']['weeklyHistory'][o['key']]['status']=='success'
        await app.locator('#confirmBtn').click();await app.locator('#reviewStart').click();await app.wait_for_timeout(200)
        assert 'already' in await app.locator('#flash').inner_text()
        assert state['posts']==before+1
        passed('one confirmed weekly booking captures exact response and its saved status prevents a silent second attempt')

        # Clear weekly association via a user change, then check a future timed run.
        await app.locator('#date').fill(await app.evaluate('HKU.hkParts(Date.now()+10*86400000).date'))
        await app.locator('#date').dispatch_event('change')
        await app.locator('#autoRelease').uncheck()
        await app.locator('#mode').select_option('scheduled')
        scheduled=await app.evaluate('HKU.hkParts(Date.now()+22000)')
        await app.locator('#releaseDate').fill(scheduled['date']);await app.locator('#releaseTime').fill(scheduled['time'])
        await app.locator('#captchaLead').fill('10');await app.locator('#captchaLead').dispatch_event('change')
        target=await app.evaluate('HKUTyping.plan(readConfig())')
        before=state['posts'];await book(False);await finish('indicates success',35000)
        assert state['posts']==before+1
        bp=booking();id=next(i for i,p in TAB_PAGES.items() if p==bp)
        seq=[x for x in SEQUENCE if x['tabId']==id]
        typed=next(x['at'] for x in seq if x['type']=='HKU_TYPE_FINISH')
        cap=next(x['at'] for x in seq if x['type']=='HKU_CAPTCHA_CLICK')
        submit=next(x['at'] for x in seq if x['type']=='HKU_SUBMIT')
        assert typed<cap and cap>=target['captchaAt']-2 and submit>=target['clickAt']-2
        passed('scheduled run finishes typing first, requests CAPTCHA at its target, and never sends Create early')

        # Deliberately missed CAPTCHA/release: complete all characters, then proceed.
        old=await app.evaluate('HKU.hkParts(Date.now()-2000)')
        await app.locator('#releaseDate').fill(old['date']);await app.locator('#releaseTime').fill(old['time'])
        before=state['posts'];await book(False);await finish('indicates success')
        assert state['posts']==before+1
        assert 'Running late: typing is complete' in await app.locator('#log').inner_text()
        assert 'Fresh typing completed' in await app.locator('#log').inner_text()
        passed('late preparation accelerates remaining pauses and continues instead of cancelling at the old deadline')

        state['captcha']='manual';await app.locator('#mode').select_option('now')
        before=state['posts'];await book(False)
        await app.locator('#captchaBanner').wait_for(state='visible',timeout=25000)
        assert state['posts']==before
        await booking().locator('#manual-solve').click();await finish('indicates success')
        assert state['posts']==before+1
        passed('manual CAPTCHA triggers a warning and blocks Create until the user verifies it')

        # Reopen in a fresh JS document while keeping the same mocked local storage.
        await app.goto('about:blank')
        await app.set_content(html,wait_until='domcontentloaded')
        await app.wait_for_selector('#weeklyRoom option',state='attached');await app.wait_for_timeout(200)
        assert await app.locator('#agreement').is_checked()
        assert await app.locator('#uid').input_value()=='TEST-STUDENT'
        await app.locator('#weeklyBtn').click();assert await app.locator('.weekly-slot').count()==3
        passed('reopening restores agreement, personal details, weekly rows and attempt history without auto-starting')
        assert not errors,errors
        passed('no JavaScript page errors in the tested flows')
        report={'passed':len(results),'tests':results,'page_errors':errors,'real_network_requests_sent':False,'chrome_extension_apis_mocked':True,'keyboard_input':'real Chromium CDP Input.dispatchKeyEvent','edge_installation_tested':False,'os_notification_delivery_tested':False,'sequence':SEQUENCE}
        (OUT/'browser-test-report.json').write_text(json.dumps(report,indent=2))
        await browser.close()

asyncio.run(main())
