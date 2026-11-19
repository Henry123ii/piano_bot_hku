"""Simulated browser UI smoke test. No HKU requests; no extension installation."""
from pathlib import Path
import asyncio,json
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[1]

async def main():
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True,executable_path='/usr/bin/chromium')
        page=await browser.new_page(viewport={'width':1100,'height':800})
        html=(ROOT/'app.html').read_text()
        html=html[:html.index('<script src="shared.js">')]+ '</body></html>'
        await page.set_content(html)
        # Mirror the extension stylesheet in the inert browser fixture.
        await page.add_style_tag(content=(ROOT/'app.css').read_text())
        await page.evaluate('''() => {
          let n=1;Object.defineProperty(window.crypto,'randomUUID',{configurable:true,value:()=>('00000000-0000-4000-a000-'+String(n++).padStart(12,'0'))});
          const state={local:{},session:{}};window.__mockState=state;window.__mockCalls=[];
          const store=area=>({get:async keys=>Object.fromEntries((typeof keys==='string'?[keys]:keys||Object.keys(state[area])).filter(k=>Object.prototype.hasOwnProperty.call(state[area],k)).map(k=>[k,state[area][k]])),
            set:async o=>{Object.assign(state[area],o)},remove:async keys=>{for(const k of typeof keys==='string'?[keys]:keys)delete state[area][k]}});
          window.chrome={
            storage:{local:store('local'),session:store('session'),onChanged:{addListener:()=>{}}},
            runtime:{getURL:s=>'chrome-extension://test/'+s,onMessage:{addListener:()=>{}},sendMessage:async msg=>{
              window.__mockCalls.push(msg);
              if(msg.type==='HKU_START_MANUAL')return {ok:true,runId:msg.config.runId,windowId:78};
              return {ok:true};}},
            notifications:{getPermissionLevel:async()=> 'granted'},permissions:{contains:async()=> true}
          };
        }''')
        for f in ['shared.js','typing.js','schedule.js','app.js','planner.js']:
            await page.add_script_tag(content=(ROOT/f).read_text())
        await page.wait_for_function("document.getElementById('room').options.length===3")
        assert await page.locator('#autoWeeklyToggle').is_checked() is False
        await page.locator('#reserveBtn').click()
        await page.locator('#uid').fill('TEST-STUDENT')
        await page.locator('#phone').fill('12345678')
        await page.locator('#remember').check()
        await page.locator('#agreement').check()
        await page.wait_for_timeout(350)
        await page.locator('#weeklyBtn').click()
        await page.locator('#weeklySave').click()
        await page.wait_for_function('window.__mockState.local.weeklyEntries?.length===1')
        page.on('dialog',lambda dialog:asyncio.create_task(dialog.accept()))
        await page.locator('#autoWeeklyToggle').check()
        await page.wait_for_function('window.__mockState.local.autoWeeklyEnabled===true')
        assert await page.locator('#autoWeeklyToggle').is_checked()
        assert await page.locator('#autoWeeklyStatus').inner_text()
        await page.screenshot(path=str(ROOT/'docs/screenshots/automatic-weekly-v211.png'),full_page=True)
        await page.locator('#autoWeeklyToggle').uncheck()
        await page.wait_for_function('window.__mockState.local.autoWeeklyEnabled===false')
        await page.locator('#reserveBtn').click()
        # Set a dated one-hour manual booking independent of saved weekly entries.
        await page.locator('#room').select_option('2873')
        await page.locator('#start').fill('14:00')
        await page.locator('#end').fill('15:00')
        await page.locator('#mode').select_option('now')
        await page.locator('#confirmBtn').click()
        assert await page.locator('#reviewDialog').is_visible()
        await page.locator('#reviewStart').click()
        await page.wait_for_function("window.__mockCalls.some(x=>x.type==='HKU_START_MANUAL')")
        assert not await page.locator('#reviewDialog').is_visible()
        assert 'SEPARATE Edge window' in await page.locator('#flash').inner_text()
        count=await page.evaluate("window.__mockCalls.filter(x=>x.type==='HKU_START_MANUAL').length")
        assert count==1
        print('PASS: automatic mode defaults OFF; opt-in/out and weekly Save work; manual review starts independent window exactly once.')
        await browser.close()

if __name__=='__main__':asyncio.run(main())
