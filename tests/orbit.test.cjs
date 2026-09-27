const {test}=require('node:test');
const assert=require('node:assert/strict');
const g=require('../static/orbit-geometry.js');
const earth=6378.137,mu=398600.4418;
const cfg={altitude:1280,inclination:42,planes:8,per_plane:16,phasing:1};
const model=c=>({earth_radius_km:earth,rotation_rate:7.292115e-5,period_seconds:2*Math.PI*Math.sqrt((earth+c.altitude)**3/mu)});
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
test('satellite radii preserve physical altitude at all supported heights',()=>{
 for(const altitude of [300,500,888,1280,2000])for(const time of [0,300,86400]){
  const c={...cfg,altitude};for(const id of [0,17,127])close(Math.hypot(...g.position(c,model(c),id,time)),1+altitude/earth);
 }
});
test('equatorial quarter orbit includes Earth rotation',()=>{
 const c={...cfg,inclination:0,planes:1,per_plane:1,phasing:0},m=model(c),t=m.period_seconds/4,p=g.latLon(g.position(c,m,0,t));
 close(p.lat,0);close(p.lon,90-m.rotation_rate*t*180/Math.PI);
});
test('an elevated satellite behind the limb is visible while surface and central far side are hidden',()=>{
 const f=g.frame({lat:0,lon:0});
 assert.equal(g.project(g.vector(0,180,1.2),f).visible,false);
 assert.equal(g.project(g.vector(0,110,1),f).visible,false);
 assert.equal(g.project(g.vector(0,110,1.2),f).visible,true);
 assert.equal(g.project(g.vector(0,0,1.2),f).visible,true);
});
test('projection distinguishes a satellite from its subpoint',()=>{
 const f=g.frame({lat:0,lon:0}),surface=g.project(g.vector(0,90),f),sat=g.project(g.vector(0,90,1.2),f);
 close(sat.x/surface.x,1.2);assert.ok(sat.x>1);
});
test('every ring closes and stays in its inclined plane at a fixed epoch',()=>{
 const m=model(cfg),t=7200;
 for(let plane=0;plane<cfg.planes;plane++){
  const first=g.orbitPoint(cfg,m,plane,0,t),last=g.orbitPoint(cfg,m,plane,2*Math.PI,t);
  first.forEach((v,i)=>close(v,last[i]));
  const a=2*Math.PI*plane/cfg.planes-m.rotation_rate*t,inc=cfg.inclination*Math.PI/180;
  const normal=[Math.sin(a)*Math.sin(inc),-Math.cos(a)*Math.sin(inc),Math.cos(inc)];
  for(let u=0;u<6.3;u+=.2)close(g.orbitPoint(cfg,m,plane,u,t).reduce((sum,v,i)=>sum+v*normal[i],0),0);
 }
});
test('Walker phasing places each satellite on the matching orbital plane',()=>{
 const m=model(cfg),id=19,t=400,plane=1;
 const u=2*Math.PI*(3/16+cfg.phasing*plane/128+t/m.period_seconds);
 g.position(cfg,m,id,t).forEach((v,i)=>close(v,g.orbitPoint(cfg,m,plane,u,t)[i]));
});
