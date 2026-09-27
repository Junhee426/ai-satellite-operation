const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1050}}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.goto(process.env.ORBIT_LAB_URL||'http://127.0.0.1:8766');
  await page.waitForFunction(()=>data?.orbit&&!busy);
  // Independent agreement with Python output, including retrograde and dense constellations.
  for(const config of [
   {altitude:500,inclination:0,planes:1,per_plane:1,phasing:0},
   {altitude:888,inclination:42,planes:8,per_plane:16,phasing:1},
   {altitude:1280,inclination:90,planes:4,per_plane:16,phasing:2},
   {altitude:2000,inclination:98,planes:32,per_plane:16,phasing:31}]){
   for(const elapsed of [0,1234,86400]){
    const result=await page.evaluate(async({config,elapsed})=>{
     const response=await fetch('/api/simulate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({config,elapsed})});
     const result=await response.json();
     return result.satellites.every(s=>{
      const p=OrbitGeometry.latLon(OrbitGeometry.position(config,result.orbit,s.id,elapsed));
      const lonError=Math.abs(((p.lon-s.lon+540)%360)-180);
      return Math.abs(p.lat-s.lat)<.00051&&lonError<.00051;
     });
    },{config,elapsed});assert.equal(result,true,JSON.stringify({config,elapsed}));
   }
  }
  const projection=await page.evaluate(()=>{
   const f=OrbitGeometry.frame(camera),r=1+state.config.altitude/data.orbit.earth_radius_km;
   const points=data.satellites.map(s=>OrbitGeometry.project(OrbitGeometry.position(state.config,data.orbit,s.id,state.elapsed),f));
   return {outside:points.filter(p=>Math.hypot(p.x,p.y)>1).length,hidden:points.filter(p=>!p.visible).length,hits:hitPoints.length,visible:points.filter(p=>p.visible).length,r};
  });
  assert.ok(projection.outside>0);assert.ok(projection.hidden>0);assert.equal(projection.hits,projection.visible);
  for(const mode of ['selected','none','all'])await page.locator('#orbitLines').selectOption(mode);
  await page.locator('#showGroundTrack').check();await page.locator('#showGroundTrack').uncheck();
  const canvas=page.locator('#orbitCanvas');const box=await canvas.boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+60,box.y+box.height/2+25,{steps:5});await page.mouse.up();
  assert.ok(await page.evaluate(()=>Math.abs(camera.lon-103)>1));
  await page.locator('#play').click();await page.waitForFunction(()=>orbitMotion!==null);
  const first=await page.evaluate(()=>orbitTime());await page.waitForTimeout(180);const second=await page.evaluate(()=>orbitTime());assert.ok(second>first);
  await page.locator('#play').click();assert.equal(await page.evaluate(()=>orbitMotion),null);
  const chosen=await page.evaluate(()=>hitPoints.find(p=>p.id!==state.selected));
  await page.mouse.click(box.x+chosen.x,box.y+chosen.y);await page.waitForFunction(id=>state.selected===id&&!busy,chosen.id);
  await page.locator('#mapView').click();assert.equal(await page.locator('#orbitLines').isDisabled(),true);
  assert.match(await page.locator('#orbitDescription').textContent(),/지상 직하점/);
  await page.locator('#globeView').click();await page.locator('#outlineStyle').click();await page.locator('#imageStyle').click();
  await page.evaluate(()=>{camera={lat:25,lon:100};drawOrbit();});
  if(process.env.ORBIT_LAB_SCREENSHOTS)await page.locator('.orbit-panel').screenshot({path:process.env.ORBIT_LAB_SCREENSHOTS+'/orbit-3d-desktop.png'});
  await page.setViewportSize({width:360,height:800});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(process.env.ORBIT_LAB_SCREENSHOTS)await page.locator('.orbit-panel').screenshot({path:process.env.ORBIT_LAB_SCREENSHOTS+'/orbit-3d-mobile.png'});
  await page.emulateMedia({reducedMotion:'reduce'});await page.locator('#play').click();const old=await page.evaluate(()=>state.elapsed);
  await page.waitForFunction(old=>state.elapsed>old,old);assert.equal(await page.evaluate(()=>orbitMotion),null);await page.locator('#play').click();
  assert.deepEqual(errors,[]);console.log('PASS: 12 Python/JS geometry comparisons, altitude, occultation, orbit controls, animation, picking, map and mobile');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
