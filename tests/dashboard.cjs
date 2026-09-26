// Run against a local server: ORBIT_LAB_URL defaults to http://127.0.0.1:8000.
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('dialog',d=>d.accept());
  const url=process.env.ORBIT_LAB_URL||'http://127.0.0.1:8000';
  const ready=()=>page.waitForFunction(()=>document.querySelector('#total').textContent==='128'&&!document.querySelector('#advance').disabled);
  const saved=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('orbit-lab.current.v1')).simulation);
  async function action(selector){await page.locator(selector).click();await page.waitForFunction(()=>!document.querySelector('#advance').disabled);}
  await page.goto(url);await ready();assert.equal((await saved()).elapsed,0);
  await action('#demo');assert.equal((await saved()).elapsed,600);
  await action('#advance');assert.equal((await saved()).elapsed,900);
  await page.reload();await ready();assert.equal(await page.locator('#clock').textContent(),'00:15:00');
  assert.equal(await page.locator('#play').textContent(),'▶ 시작');
  await page.locator('#fleetSearch').fill('001');assert.equal(await page.locator('#fleet button').count(),1);
  await page.locator('#fleetSearch').fill('no match');assert.equal(await page.locator('#fleet button').count(),0);
  await page.locator('#fleetSearch').fill('');await page.locator('#fleetSort').selectOption('risk');
  assert.equal(await page.locator('#fleet button').first().textContent(),'001');
  await page.locator('#mapView').click();await page.locator('#focusSatellite').click();
  assert.equal(await page.locator('#globeView').getAttribute('aria-pressed'),'true');
  assert.equal(await page.evaluate(()=>Math.abs(camera.lon-data.selected.lon)<.001&&Math.abs(camera.lat-data.selected.lat)<.001),true);
  const before=await saved();
  await page.locator('[name=planes]').fill('1');await action('#configForm button');
  assert.deepEqual(await saved(),before); // rejected F >= planes does not replace storage
  await page.locator('[name=planes]').fill('8');await action('#configForm button');assert.equal((await saved()).elapsed,0);
  await action('#restorePrevious');assert.equal((await saved()).elapsed,900);
  await action('#restorePrevious');assert.equal((await saved()).elapsed,0);
  await action('#restorePrevious');
  const payload={format:'orbit-lab-v1',simulation:{config:{altitude:'600'},elapsed:'120'}};
  await page.locator('#file').setInputFiles({name:'partial.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(payload))});
  await page.waitForFunction(()=>document.querySelector('#clock').textContent==='00:02:00'&&!document.querySelector('#advance').disabled);
  assert.equal(await page.locator('[name=altitude]').inputValue(),'600');assert.equal((await saved()).seed,42);
  await page.locator('#file').setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{')});
  await page.waitForFunction(()=>document.querySelector('#notice').classList.contains('error'));assert.equal((await saved()).elapsed,120);
  await action('#restorePrevious');assert.equal((await saved()).elapsed,900);
  if(process.env.ORBIT_LAB_SCREENSHOTS)await page.screenshot({path:process.env.ORBIT_LAB_SCREENSHOTS+'/dashboard-desktop.png',fullPage:true});
  for(const width of [360,768,1024]){
   await page.setViewportSize({width,height:900});
   await page.waitForTimeout(100);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`overflow at ${width}`);
  }
  await page.setViewportSize({width:360,height:800});
  if(process.env.ORBIT_LAB_SCREENSHOTS)await page.screenshot({path:process.env.ORBIT_LAB_SCREENSHOTS+'/dashboard-mobile.png',fullPage:true});
  await page.evaluate(()=>{Storage.prototype.setItem=function(){throw new DOMException('Quota exceeded','QuotaExceededError');};});
  await action('#advance');assert.equal(await page.locator('#clock').textContent(),'00:20:00');
  assert.match(await page.locator('#saveStatus').textContent(),/자동 저장 불가/);assert.equal((await saved()).elapsed,900);
  await page.reload();await ready();assert.equal((await saved()).elapsed,900);
  await page.evaluate(()=>localStorage.setItem('orbit-lab.current.v1','broken-json'));
  await page.reload();await ready();
  assert.equal(await page.evaluate(()=>localStorage.getItem('orbit-lab.current.v1')),'broken-json');
  assert.match(await page.locator('#notice').textContent(),/읽지 못했습니다/);
  await action('#demo');assert.equal((await saved()).elapsed,600);
  assert.deepEqual(errors,[]);
  console.log('PASS: restore, rollback, validation, search, sorting, focus, responsive layouts, storage failure and corrupt recovery');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
