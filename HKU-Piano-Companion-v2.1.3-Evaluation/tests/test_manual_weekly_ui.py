import asyncio, re, json
from pathlib import Path
from playwright.async_api import async_playwright
P=Path(__file__).resolve().parents[1]
STUB='''
const STORES={local:{},session:{}};
function get(area,keys){const s=STORES[area];if(typeof keys==='string')keys=[keys];return Object.fromEntries((Array.isArray(keys)?keys:Object.keys(s)).filter(k=>k in s).map(k=>[k,s[k]]));}
window.chrome={
 storage:{local:{get:async(k)=>get('local',k),set:async(v)=>Object.assign(STORES.local,v),remove:async(k)=>{(Array.isArray(k)?k:[k]).forEach(x=>delete STORES.local[x]);}},
 session:{get:async(k)=>get('session',k),set:async(v)=>Object.assign(STORES.session,v),remove:async(k)=>{(Array.isArray(k)?k:[k]).forEach(x=>delete STORES.session[x]);}},
 onChanged:{addListener:()=>{}}},
 runtime:{sendMessage:async()=>({ok:true}),onMessage:{addListener:()=>{}}},permissions:{contains:async()=>true},
 notifications:{create:async()=>'',clear:async()=>true},tabs:{query:async()=>[],get:async()=>({status:'complete',url:'https://hkufbs.hku.hk/fbs/centralbook/book/Web/dashboard.php'})},windows:{getAll:async()=>[]}
};
if(!crypto.randomUUID)crypto.randomUUID=()=>('fixture_'+Math.random().toString(36).slice(2));
'''
html=(P/'app.html').read_text().replace('<link rel="stylesheet" href="app.css">','<style>'+(P/'app.css').read_text()+'</style>')
html=re.sub(r'<script src="([^"]+)"></script>',lambda m:'<script>'+ (P/m.group(1)).read_text()+'</script>',html)
html=html.replace('<script>','<script>'+STUB+'</script><script>',1)
async def main():
 async with async_playwright() as p:
  b=await p.chromium.launch(executable_path='/usr/bin/chromium',headless=True)
  page=await b.new_page(viewport={'width':1200,'height':900})
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  await page.route('**/*',lambda route:route.abort())  # No external network requests.
  await page.set_content(html);await page.wait_for_selector('#weeklyRoom option',state='attached');await page.wait_for_timeout(70)
  passed=[]
  def check(test, msg):
   assert test,msg
   passed.append(msg);print('PASS',msg,flush=True)
  await page.locator('#reserveBtn').click()
  check(await page.locator('#confirmBtn').is_enabled(),'manual Review button enabled on independent Reservation screen')
  # No silent native invalid: user needs to know what's missing.
  await page.locator('#confirmBtn').click()
  check('UID' in await page.locator('#reviewError').inner_text(),'missing manual personal details explained beside Review')
  await page.locator('#uid').fill('DEMO-ID');await page.locator('#phone').fill('12345678');await page.locator('#agreement').check()
  await page.locator('#confirmBtn').click()
  check(await page.locator('#reviewDialog').evaluate('(e)=>e.open'),'valid one-off session opens review modal')
  await page.locator('#reviewBack').click()
  await page.locator('#start').fill('14:30');await page.locator('#end').fill('15:30')
  await page.locator('#confirmBtn').click()
  check('full clock hour' in await page.locator('#reviewError').inner_text(),'invalid manual times show meaningful inline error instead of silent disabled click')
  await page.locator('#start').fill('14:00');await page.locator('#end').fill('15:00')
  await page.locator('#people').fill('101')
  await page.locator('#confirmBtn').click()
  check('1 to 100' in await page.locator('#reviewError').inner_text(),'explicit validation blocks >100 people without native validation')
  await page.locator('#people').fill('1')
  await page.locator('#weeklyBtn').click()
  await page.locator('#weeklyStart').fill('11:30')
  await page.locator('#weeklySave').click()
  await page.wait_for_timeout(100)
  check('full clock hour' in await page.locator('#weeklySaveError').inner_text(),'weekly Save invalid start error is visible beside button')
  await page.locator('#weeklyStart').fill('11:00')
  await page.locator('#weeklySave').click()
  await page.wait_for_function('document.querySelectorAll("#weeklyRuns tr").length>0')
  check(await page.locator('#weeklyRuns tr').count()>0,'valid weekly record creates dated run timetable rows')
  await page.locator('#weeklyRuns .run-time').first.click()
  await page.wait_for_timeout(70)
  check(await page.locator('#reviewDialog').evaluate('(e)=>e.open'),'weekly run button enters same Review modal')
  linked=await page.evaluate('readConfig().weeklyKey')
  check(bool(linked),'weekly selection is associated with dated occurrence before manual switch')
  await page.locator('#reviewBack').click()
  await page.locator('#reserveBtn').click()
  check(await page.evaluate('readConfig().weeklyKey===undefined'),'manual Reservation clears previous weekly selection and restrictions')
  await page.locator('#confirmBtn').click()
  check(await page.locator('#reviewDialog').evaluate('(e)=>e.open'),'manual review works after visiting scheduled booking without stale weekly lock')
  await page.locator('#reviewBack').click()
  await page.locator('#weeklyBtn').click()
  histKey=(await page.evaluate('HKUWeekly.occurrences(STORES.local.weeklyEntries)[0].key'))
  await page.evaluate('async (key)=>{STORES.local.weeklyHistory={[key]:{status:"attempted",at:Date.now()}};await window.HKUPlanner.load();}',histKey)
  check(await page.locator('#weeklyRuns .run-time').first.is_disabled(),'previously attempted weekly run remains intentionally locked')
  check(await page.locator('#weeklyRuns button').filter(has_text='Reset after checking HKU').count()>0,'Reset after checking HKU remains available for locked weekly run')
  check(not errors,'no page JavaScript errors during manual and weekly review')
  print('TOTAL',len(passed),'checks passed; no network requests or HKU reservations')
  await b.close()
asyncio.run(main())
