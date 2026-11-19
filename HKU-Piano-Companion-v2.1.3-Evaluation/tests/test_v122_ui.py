import asyncio
from pathlib import Path
from playwright.async_api import async_playwright
P=Path(__file__).resolve().parents[1]
async def main():
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True,executable_path="/usr/bin/chromium")
        page=await browser.new_page()
        html=(P/'app.html').read_text()
        html=html[:html.index('<script src="shared.js">')]+ '</body></html>'
        await page.set_content(html)
        await page.evaluate('''() => {Object.defineProperty(window.crypto,"randomUUID",{value:()=>"test-123",configurable:true});window.chrome={storage:{local:{get:async()=>({}),set:async()=>{},remove:async()=>{}},session:{get:async()=>({}),set:async()=>{},remove:async()=>{}}}};}''')
        for filename in ['shared.js','typing.js','schedule.js','app.js']:
            await page.add_script_tag(content=(P/filename).read_text())
        await page.evaluate('init()')
        assert await page.locator('#early').count()==0
        await page.locator("#reserveBtn").click()
        before=await page.evaluate('HKUTyping.plan(readConfig())')
        await page.locator('#offset').fill('1.375')
        await page.locator('#offset').dispatch_event('change')
        after=await page.evaluate('HKUTyping.plan(readConfig())')
        assert after['openAt']==before['openAt'],(before,after)
        assert after['captchaAt']==before['captchaAt']
        assert after['clickAt']-before['clickAt']==1175
        assert await page.locator('#offset').input_value()=='1.375'
        preview=await page.locator('#timingPreview').inner_text()
        assert 'release + 1.375s' in preview,preview
        assert 'fixed 60s' in preview,preview
        print('PASS: UI offset editing preserves opening and CAPTCHA, updates Create by 1175ms.')
        await browser.close()
asyncio.run(main())
