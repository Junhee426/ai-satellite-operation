'use strict';
const $ = id => document.getElementById(id);
const clone = x => JSON.parse(JSON.stringify(x));
// randomUUID exists only in secure contexts (HTTPS, localhost); `python main.py` also serves plain HTTP to the LAN.
const newId = () => crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
const defaults = {config:{altitude:1280,inclination:42,planes:8,per_plane:16,phasing:1,min_elevation:10},elapsed:0,seed:42,selected:0,faults:[],actions:[]};
let state=clone(defaults), data=null, catalog=null, busy=false, playing=false, timer=null;
let earthStyle='image';
const lab=OrbitLabState;
let previousExperiment=null, locallySaved=false;
function persistExperiment(){
  try{
    // Save the recovery point first; never report success after a partial write.
    if(previousExperiment)localStorage.setItem(lab.PREVIOUS,lab.encode(previousExperiment));
    localStorage.setItem(lab.CURRENT,lab.encode(state));
    locallySaved=true;
    $('saveStatus').textContent=`자동 저장됨 · T+ ${clock(state.elapsed)}`;
  }catch(e){locallySaved=false;$('saveStatus').textContent='자동 저장 불가 · 실험 저장으로 JSON을 보관하세요.';}
}
$('restorePrevious').onclick=async()=>{
  if(busy||!previousExperiment)return;
  pause();
  if(await refresh(clone(previousExperiment),{archive:true})){
    fillConfig();notice('이전 실험을 복원했습니다. 되돌리기를 다시 누르면 방금 실험으로 돌아갑니다.');
  }
};
$('focusSatellite').onclick=()=>{
  if(!data)return;camera={lon:data.selected.lon,lat:data.selected.lat};view='globe';setView();
};
let view='globe', camera={lon:103,lat:22}, hitPoints=[], drag=null, world=[];
let orbitMotion=null,orbitFrame=null;
const orbitMath=OrbitGeometry;
const colors={normal:'#6addb4',warning:'#ffc570',critical:'#ff7d8b',selected:'#59d8ed'};

// Shared Earth globe renderer (identical across K-LEO services): textured orthographic
// sphere using the same Blue Marble texture, projection math, and atmosphere glow.
let earthTexture=null,earthImage=null;const globeCache={};
function observerFrame(latDeg,lonDeg){
  const lat=latDeg*Math.PI/180,lon=lonDeg*Math.PI/180;
  return{up:[Math.cos(lat)*Math.cos(lon),Math.cos(lat)*Math.sin(lon),Math.sin(lat)],
    east:[-Math.sin(lon),Math.cos(lon),0],
    north:[-Math.sin(lat)*Math.cos(lon),-Math.sin(lat)*Math.sin(lon),Math.cos(lat)]};
}
(function loadEarthTexture(){
  const img=new Image();
  img.onload=()=>{
    earthImage=img;
    const off=document.createElement('canvas');off.width=img.width;off.height=img.height;
    const c=off.getContext('2d',{willReadFrequently:true});c.drawImage(img,0,0);
    earthTexture={width:img.width,height:img.height,data:c.getImageData(0,0,img.width,img.height).data};
    globeCache.key=null;drawOrbit();
  };
  img.src='/static/earth.jpg';
})();
function paintGlobeTexture(ctx,cx,cy,radius,dpr,latDeg,lonDeg){
  const size=Math.max(32,Math.min(650,Math.round(radius*2*dpr)));
  const key=[size,latDeg,lonDeg,!!earthTexture].join(':');
  if(globeCache.key!==key){
    const off=document.createElement('canvas');off.width=off.height=size;
    const octx=off.getContext('2d');
    const pixels=octx.createImageData(size,size),d=pixels.data,r=size/2,frame=observerFrame(latDeg,lonDeg),tex=earthTexture;
    for(let y=0;y<size;y++)for(let x=0;x<size;x++){
      const ex=(x+.5-r)/r,ny=-(y+.5-r)/r,dist=ex*ex+ny*ny;
      if(dist>1)continue;
      const uz=Math.sqrt(1-dist),index=(y*size+x)*4;
      const worldX=frame.east[0]*ex+frame.north[0]*ny+frame.up[0]*uz;
      const worldY=frame.east[1]*ex+frame.north[1]*ny+frame.up[1]*uz;
      const worldZ=frame.east[2]*ex+frame.north[2]*ny+frame.up[2]*uz;
      const lon=Math.atan2(worldY,worldX),lat=Math.asin(Math.max(-1,Math.min(1,worldZ)));
      const light=.42+.58*uz;
      if(tex){
        const tx=Math.min(tex.width-1,Math.floor((lon/(2*Math.PI)+.5)*tex.width));
        const ty=Math.min(tex.height-1,Math.max(0,Math.floor((.5-lat/Math.PI)*tex.height)));
        const offset=(ty*tex.width+tx)*4;
        d[index]=tex.data[offset]*light;d[index+1]=tex.data[offset+1]*light;d[index+2]=tex.data[offset+2]*light;
      }else{d[index]=20*light;d[index+1]=75*light;d[index+2]=120*light;}
      d[index+3]=Math.min(255,(1-dist)*size*180);
    }
    octx.putImageData(pixels,0,0);globeCache.key=key;globeCache.canvas=off;
  }
  const gradient=ctx.createRadialGradient(cx,cy,radius*.96,cx,cy,radius*1.09);
  gradient.addColorStop(0,'rgba(43,150,201,.24)');gradient.addColorStop(1,'rgba(43,150,201,0)');
  ctx.fillStyle=gradient;ctx.beginPath();ctx.arc(cx,cy,radius*1.09,0,Math.PI*2);ctx.fill();
  ctx.drawImage(globeCache.canvas,cx-radius,cy-radius,radius*2,radius*2);
}
const statusNames={normal:'정상',warning:'관심',critical:'경고'};
const specs={battery:['배터리','%',1],temperature:['탑재체 온도','°C',1],cpu:['CPU','%',1],pointing:['지향 오차','°',2],packet_loss:['패킷 손실','%',1],wheel:['휠 속도','rpm',0],risk:['AI 이상지수','',1],capacity:['처리용량 지수','%',1]};
const escape = s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clock = s=>[Math.floor(s/3600),Math.floor(s%3600/60),Math.floor(s%60)].map(x=>String(x).padStart(2,'0')).join(':');
function notice(message,error=false){$('notice').textContent=message;$('notice').classList.toggle('error',error);$('notice').hidden=!message;}
function setBusy(v){busy=v;for(const id of ['advance','inject','demo','csv','save','load','satSelect'])$(id).disabled=v;$('configForm').querySelector('button').disabled=v;document.querySelectorAll('[data-action]').forEach(b=>b.disabled=v);$('restorePrevious').disabled=v||!previousExperiment;}
async function request(path,payload){
  const ctrl=new AbortController(),timeout=setTimeout(()=>ctrl.abort(),30000);
  try{
    const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:ctrl.signal});
    if(!r.ok){const e=await r.json().catch(()=>({detail:'서버 응답 오류'}));const message=Array.isArray(e.detail)?e.detail.map(x=>`${x.loc?.slice(1).join('.')}: ${x.msg}`).join(' / '):e.detail;throw Error(message||`HTTP ${r.status}`);}
    return r;
  }finally{clearTimeout(timeout);}
}
async function refresh(next=state,{archive=false,persist=true}={}){
  if(busy)return false;
  setBusy(true);
  try{
    const r=await request('/api/simulate',next),result=await r.json();
    const validated=clone(lab.normalize(next,defaults));
    if(archive&&data)previousExperiment=clone(state);
    const priorTime=orbitTime(),smooth=playing&&data&&validated.elapsed>state.elapsed&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
    data=result;state=validated;locallySaved=false;
    orbitMotion=smooth?{from:priorTime,started:performance.now()}:null;
    if(smooth)animateOrbit();
    $('connection').textContent='Python 엔진 연결됨';render();
    if(persist)persistExperiment();return true;
  }
  catch(e){if(data)$('satSelect').value=state.selected;pause();$('connection').textContent='연결 확인 필요';notice(e.name==='AbortError'?'응답이 지연되었습니다. 잠시 후 다시 시도하세요.':e.message,true);return false;}
  finally{setBusy(false);}
}
function orbitTime(){
  if(!orbitMotion)return state.elapsed;
  const fraction=Math.min(1,(performance.now()-orbitMotion.started)/700);
  return orbitMotion.from+(state.elapsed-orbitMotion.from)*fraction;
}
function animateOrbit(){
  cancelAnimationFrame(orbitFrame);
  const tick=()=>{drawOrbit();if(orbitMotion&&performance.now()-orbitMotion.started<700)orbitFrame=requestAnimationFrame(tick);else orbitMotion=null;};
  orbitFrame=requestAnimationFrame(tick);
}
function pause(){playing=false;clearTimeout(timer);cancelAnimationFrame(orbitFrame);orbitMotion=null;$('play').textContent='▶ 시작';drawOrbit();}
function schedule(){clearTimeout(timer);if(!playing)return;timer=setTimeout(async()=>{if(!playing)return;if(!busy){const next=clone(state);next.elapsed=Math.min(86400,next.elapsed+Number($('speed').value));await refresh(next);if(state.elapsed>=86400){pause();notice('24시간 실험이 종료되었습니다. 설정 적용으로 새 실험을 시작하세요.');}}schedule();},1000);}
$('play').onclick=()=>{if(playing){pause();return;}if(!data||busy){notice('엔진이 준비된 뒤 시작하세요.');return;}if(state.elapsed>=86400){notice('24시간에 도달했습니다. 새 실험을 시작하세요.');return;}playing=true;$('play').textContent='Ⅱ 일시정지';notice('');schedule();};
$('advance').onclick=async()=>{pause();const next=clone(state);next.elapsed=Math.min(86400,next.elapsed+300);notice('');await refresh(next);};
function fillConfig(){
  const altitude=$('configForm').elements.namedItem('altitude');
  altitude.querySelectorAll('[data-custom]').forEach(option=>option.remove());
  if(!Array.from(altitude.options).some(option=>Number(option.value)===state.config.altitude)){
    const option=new Option(String(state.config.altitude),String(state.config.altitude));option.dataset.custom='true';altitude.add(option);
  }
  for(const [k,v] of Object.entries(state.config))$('configForm').elements.namedItem(k).value=v;
}
$('configForm').onsubmit=async e=>{e.preventDefault();pause();const next=clone(defaults);for(const [k,v] of new FormData(e.target))next.config[k]=Number(v);if(await refresh(next,{archive:true})){notice('새 설정을 적용했습니다. 이전 실험으로 되돌릴 수 있습니다.');fillConfig();}};
$('satSelect').onchange=async e=>{const next=clone(state);next.selected=Number(e.target.value);await refresh(next);};
async function selectSatellite(id){if(busy)return;const next=clone(state);next.selected=id;await refresh(next);}
$('severity').oninput=e=>$('severityValue').textContent=e.target.value+'%';
$('inject').onclick=async()=>{
  if(!data||busy)return;pause();const kind=$('faultKind').value;
  if(state.faults.some(f=>f.satellite===state.selected&&f.kind===kind)){notice('이 위성에는 같은 장애가 이미 있습니다. 새 실험 또는 다른 위성을 선택하세요.');return;}
  const next=clone(state);next.faults.push({id:newId(),satellite:state.selected,kind,at:state.elapsed,severity:Number($('severity').value)/100});
  if(await refresh(next)){notice(`${data.selected.name}에 ${catalog.faults[kind].name} 장애를 주입했습니다. +5분 또는 시작을 눌러 진행하세요.`);$('metric').value={thermal:'temperature',battery:'battery',attitude:'pointing',link:'packet_loss',cpu:'cpu'}[kind];drawChart();}
};
$('demo').onclick=async()=>{pause();const next=clone(defaults);next.elapsed=600;next.faults=[{id:'demo-thermal',satellite:0,kind:'thermal',at:180,severity:1}];if(await refresh(next,{archive:true})){fillConfig();$('metric').value='temperature';drawChart();notice('과열 예제를 불러왔습니다. 오른쪽 권고의 모의 실행 → +5분으로 대응 효과를 확인하세요.');}};
async function execute(faultId,kind){
  if(busy)return;pause();const next=clone(state);next.actions.push({fault_id:faultId,kind,at:state.elapsed});
  if(await refresh(next))notice(`${catalog.actions[kind].name} 모의 명령을 실행했습니다. +5분을 눌러 복구 추이를 비교하세요.`);
}
$('filter').onchange=renderFleet;$('fleetSearch').oninput=renderFleet;$('fleetSort').onchange=renderFleet;$('metric').onchange=drawChart;
$('globeView').onclick=()=>{view='globe';setView();};$('mapView').onclick=()=>{view='map';setView();};
function setEarthStyle(style){
  earthStyle=style;
  for(const [id,value] of [['outlineStyle','outline'],['imageStyle','image']]){
    const on=style===value;$(id).classList.toggle('active',on);$(id).setAttribute('aria-pressed',String(on));
  }
  drawOrbit();
}
$('outlineStyle').onclick=()=>setEarthStyle('outline');
$('imageStyle').onclick=()=>setEarthStyle('image');
$('orbitLines').onchange=drawOrbit;$('showGroundTrack').onchange=drawOrbit;
function setView(){
  $('orbitCanvas').parentElement.dataset.view=view;
  for(const [id,v] of [['globeView','globe'],['mapView','map']]){const on=view===v;$(id).classList.toggle('active',on);$(id).setAttribute('aria-pressed',String(on));}
  $('orbitLines').disabled=view==='map';$('showGroundTrack').disabled=view==='map';
  $('orbitDescription').textContent=view==='globe'?'지구·고도 비율 반영 · 실선은 현재 궤도면 · 위성 표식은 확대 표시':'점은 지상 직하점 · 점선은 선택 위성의 향후 1주기 지상궤적';
  $('orbitHint').textContent=view==='globe'?'드래그로 회전 · 위성 클릭으로 선택':'위성 클릭으로 선택 · 지상궤적에는 지구 자전을 반영';drawOrbit();
}
$('guideButton').onclick=()=>$('guide').showModal();$('closeGuide').onclick=()=>$('guide').close();
function download(blob,name){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('save').onclick=()=>{pause();download(new Blob([JSON.stringify({format:'orbit-lab-v1',simulation:state},null,2)],{type:'application/json'}),'orbit-lab-experiment.json');notice('현재 설정·장애·대응 시각을 저장했습니다.');};
$('csv').onclick=async()=>{pause();if(busy)return;setBusy(true);try{const r=await request('/api/export',state);download(await r.blob(),'satellite-telemetry.csv');notice('현재 시각의 전체 위성 텔레메트리를 저장했습니다.');}catch(e){notice(e.message,true);}finally{setBusy(false);}};
$('load').onclick=()=>$('file').click();
$('file').onchange=async e=>{pause();const f=e.target.files[0];if(!f)return;try{if(f.size>65536)throw Error('실험 파일은 64 KB 이하여야 합니다.');const simulation=lab.decode(await f.text());if(await refresh(simulation,{archive:true})){fillConfig();notice('저장한 실험을 복원했습니다.');}}catch(e){notice(e.message,true);}finally{e.target.value='';}};

function render(){
  const s=data.summary,sat=data.selected;$('clock').textContent=clock(state.elapsed);
  for(const k of ['total','normal','warning','critical'])$(k).textContent=s[k];
  $('visible').textContent=data.stations[0].visible;$('capacity').textContent=s.mean_capacity.toFixed(1);
  $('orbitInfo').textContent=`${state.config.planes}개 면 × ${state.config.per_plane}기 · ${s.period_minutes}분/주기`;
  $('elevationInfo').textContent=`최소 앙각 ${state.config.min_elevation}°`;
  $('selectedLabel').textContent=`${sat.name} · ${sat.plane}번 궤도면 · 직하점 ${sat.lat.toFixed(1)}°, ${sat.lon.toFixed(1)}°`;
  const options=data.satellites.map(s=>`<option value="${s.id}">${s.name}</option>`).join('');
  if($('satSelect').options.length!==data.satellites.length)$('satSelect').innerHTML=options;
  $('satSelect').value=state.selected;
  $('metrics').innerHTML=Object.entries(sat.telemetry).map(([k,v])=>`<div class="metric"><span>${specs[k][0]}</span><strong>${v.toFixed(specs[k][2])}<small>${specs[k][1]}</small></strong></div>`).join('');
  $('risk').innerHTML=`${sat.risk.toFixed(1)}<small>/100</small>`;
  $('riskBar').style.width=sat.risk+'%';$('riskBar').style.background=colors[sat.status];
  $('statusBadge').className='badge '+sat.status;$('statusBadge').textContent=statusNames[sat.status];
  $('contributors').innerHTML=data.contributors.map(c=>`<div class="contributor"><span>${c.label}</span><b>${c.deviation.toFixed(1)} σ</b></div>`).join('');
  const recommendations=$('recommendations');recommendations.replaceChildren();
  if(!sat.alerts.length)recommendations.innerHTML='<p class="muted">현재 관측값에서 대응이 필요한 이상 징후가 없습니다.</p>';
  sat.alerts.forEach(a=>{
    const el=document.createElement('div');el.className='recommendation';
    const action=catalog.actions[a.action];
    el.innerHTML=`<strong>${escape(a.evidence)}</strong>${action?`<p>${escape(action.effect)}</p><small>${escape(action.tradeoff)}</small>`:'<p>원인 미확정 · 추세와 원시 관측값을 추가 확인하세요.</p>'}`;
    if(action){
      const f=state.faults.find(f=>f.satellite===sat.id&&f.kind===a.kind&&f.at<=state.elapsed);
      const done=f&&state.actions.some(x=>x.fault_id===f.id&&x.at<=state.elapsed);
      if(f&&!done){const button=document.createElement('button');button.textContent=`모의 실행 · ${action.name}`;button.dataset.action=a.action;button.onclick=()=>execute(f.id,a.action);el.append(button);}
      else{const p=document.createElement('p');p.className='footnote';p.textContent=done?'대응 실행됨 · 시간을 진행해 경과를 관찰하세요.':'연관 장애가 확인되지 않아 관측만 권고합니다.';el.append(p);}
    }
    recommendations.append(el);
  });
  const applied=state.actions.filter(a=>a.at<=state.elapsed&&state.faults.some(f=>f.id===a.fault_id&&f.satellite===sat.id));
  for(const a of applied){if(!sat.alerts.some(x=>x.action===a.kind)){const p=document.createElement('p');p.className='footnote';p.textContent=`${catalog.actions[a.kind].name} 실행 상태 · ${catalog.actions[a.kind].tradeoff}`;recommendations.append(p);}}
  $('stations').innerHTML=data.stations.map(s=>`<div class="station"><span>${s.name}</span><div><b>${s.visible}</b><small>/ ${s.serviceable}</small></div></div>`).join('');
  const events=[...state.faults.map(f=>({at:f.at,text:`K-LEO ${String(f.satellite+1).padStart(3,'0')} · ${catalog.faults[f.kind].name} 주입`})),...state.actions.map(a=>({at:a.at,text:`${catalog.actions[a.kind].name} 실행 · ${state.faults.find(f=>f.id===a.fault_id)?.satellite+1}번 위성`}))].filter(e=>e.at<=state.elapsed).sort((a,b)=>b.at-a.at);
  $('eventCount').textContent=events.length;
  $('events').innerHTML=events.length?events.map(e=>`<div class="event"><time>T+ ${clock(e.at)}</time>${escape(e.text)}</div>`).join(''):'<p class="muted">아직 이벤트가 없습니다.</p>';
  renderFleet();drawOrbit();drawChart();
}
function renderFleet(){
  if(!data)return;const fragment=document.createDocumentFragment();
  const satellites=lab.fleet(data.satellites,{mode:$('filter').value,query:$('fleetSearch').value,sort:$('fleetSort').value});
  $('fleetCount').textContent=`${satellites.length} / ${data.satellites.length}기 표시 · 선택 ${data.selected.name}`;
  for(const sat of satellites){
    const b=document.createElement('button');b.textContent=String(sat.id+1).padStart(3,'0');b.className=sat.status+(sat.id===state.selected?' selected':'');
    b.title=`${sat.name} · ${statusNames[sat.status]} · 이상지수 ${sat.risk}`;b.setAttribute('aria-label',b.title);b.setAttribute('aria-pressed',String(sat.id===state.selected));b.onclick=()=>selectSatellite(sat.id);fragment.append(b);
  }$('fleetEmpty').hidden=fragment.childNodes.length>0;$('fleet').replaceChildren(fragment);
}
function canvasSize(canvas){const r=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(r.width*dpr);canvas.height=Math.round(r.height*dpr);const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);return {ctx,w:r.width,h:r.height,dpr};}
function drawOrbit(){
  if(!data||!data.orbit)return;const {ctx,w,h,dpr}=canvasSize($('orbitCanvas'));if(!w)return;
  const model=data.orbit,t=orbitTime(),ratio=1+state.config.altitude/model.earth_radius_km;
  const radius=Math.min((w-48)/2,(h-58)/2)/ratio,cx=w/2,cy=h/2+5,basis=orbitMath.frame(camera);
  const mapWidth=Math.max(1,Math.min(w-64,(h-64)*2)),mapHeight=mapWidth/2;
  const mapLeft=(w-mapWidth)/2,mapTop=24+(h-64-mapHeight)/2;
  const space=point=>{const p=orbitMath.project(point,basis);return {...p,x:cx+radius*p.x,y:cy-radius*p.y,front:p.visible};};
  const project=(lat,lon)=>view==='map'?{x:mapLeft+(lon+180)/360*mapWidth,y:mapTop+(90-lat)/180*mapHeight,front:true}:space(orbitMath.vector(lat,lon));
  function stroke(points,color,width=1,dash=[],wrap=false){
    ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=width;ctx.setLineDash(dash);let prev=null;
    for(const p of points){if(p.front){if(!prev||(wrap&&Math.abs(p.x-prev.x)>mapWidth/2))ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y);prev=p;}else prev=null;}
    ctx.stroke();ctx.setLineDash([]);
  }
  const surfaceLine=(points,color,width=1,dash=[])=>stroke(points.map(([lat,lon])=>project(lat,lon)),color,width,dash,view==='map');
  if(view==='globe'){
    // Opaque sphere in both display styles; hidden orbits never shine through.
    ctx.fillStyle='#0a1b2b';ctx.beginPath();ctx.arc(cx,cy,radius,0,Math.PI*2);ctx.fill();
    if(earthStyle==='image')paintGlobeTexture(ctx,cx,cy,radius,dpr,camera.lat,camera.lon);
    else{ctx.strokeStyle='#45758a';ctx.lineWidth=1;ctx.stroke();}
  }else if(earthStyle==='image'&&earthImage)ctx.drawImage(earthImage,mapLeft,mapTop,mapWidth,mapHeight);
  for(let lat=-60;lat<=60;lat+=30)surfaceLine(Array.from({length:181},(_,i)=>[lat,-180+i*2]),lat===0?'#34607a':'#25435a',.6);
  for(let lon=-180;lon<180;lon+=30)surfaceLine(Array.from({length:91},(_,i)=>[-90+i*2,lon]),'#25435a',.6);
  for(const outline of world)surfaceLine(outline,'#45758a',.75);
  if(view==='map'){
    ctx.font='11px system-ui';ctx.fillStyle='#7793ae';ctx.textAlign='center';
    for(let lon=-180;lon<=180;lon+=60){const p=project(0,lon);ctx.fillText(lon+'°',p.x,mapTop+mapHeight+18);}
    ctx.textAlign='right';for(let lat=-60;lat<=60;lat+=30){const p=project(lat,-180);ctx.fillText(lat+'°',p.x-4,p.y+4);}
  }
  if(view==='map'||$('showGroundTrack').checked)surfaceLine(data.track,'#ffcf7eaa',1.4,[3,5]);
  const selectedPlane=Math.floor(state.selected/state.config.per_plane);
  if(view==='globe'&&$('orbitLines').value!=='none'){
    // Each ring is a simultaneous orbital plane, not a future Earth-fixed ground track.
    const planes=Array.from({length:state.config.planes},(_,i)=>i).filter(i=>i!==selectedPlane);planes.push(selectedPlane);
    for(const plane of planes){
      if($('orbitLines').value==='selected'&&plane!==selectedPlane)continue;
      const points=Array.from({length:361},(_,i)=>space(orbitMath.orbitPoint(state.config,model,plane,i*Math.PI/180,t)));
      stroke(points,plane===selectedPlane?'#70dff4':'#719eb057',plane===selectedPlane?1.8:1);
    }
  }
  const located=data.satellites.map(sat=>{
    const point=orbitMath.position(state.config,model,sat.id,t),location=orbitMath.latLon(point);
    return {sat,location,p:view==='globe'?space(point):project(location.lat,location.lon)};
  }).sort((a,b)=>(a.p.z||0)-(b.p.z||0));
  if(view==='globe'){
    const selected=located.find(item=>item.sat.id===state.selected),foot=project(selected.location.lat,selected.location.lon);
    if(selected.p.front&&foot.front){
      stroke([foot,selected.p],'#ffcf7ecc',1,[3,3]);ctx.strokeStyle='#ffcf7e';ctx.lineWidth=1;
      ctx.beginPath();ctx.arc(foot.x,foot.y,3,0,Math.PI*2);ctx.stroke();
    }
  }
  hitPoints=[];
  for(const {sat,p} of located){
    if(!p.front)continue;const selected=sat.id===state.selected;
    ctx.fillStyle=selected?colors.selected:colors[sat.status];ctx.beginPath();ctx.arc(p.x,p.y,3,0,Math.PI*2);ctx.fill();
    if(selected){ctx.strokeStyle='#a5f0ff';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(p.x,p.y,7,0,Math.PI*2);ctx.stroke();ctx.fillStyle='#d9faff';ctx.font='12px system-ui';ctx.textAlign='left';ctx.fillText(sat.name,Math.max(4,Math.min(p.x+12,w-95)),Math.max(34,p.y-12));}
    hitPoints.push({x:p.x,y:p.y,id:sat.id});
  }
  for(const site of data.stations){const p=project(site.lat,site.lon);if(!p.front)continue;ctx.strokeStyle='#d3dbe9';ctx.fillStyle='#e8f4ff';ctx.lineWidth=1.5;ctx.strokeRect(p.x-3,p.y-3,6,6);ctx.font='11px system-ui';ctx.textAlign='left';ctx.fillText(site.name,Math.min(p.x+8,w-65),p.y+14);}
  ctx.font='11px system-ui';ctx.textAlign='left';ctx.fillStyle='#a5bdd3';ctx.fillText(`고도 ${state.config.altitude.toLocaleString()} km · 경사각 ${state.config.inclination}°`,8,16);
  ctx.textAlign='right';ctx.fillText(`궤도 T+ ${clock(t)}`,w-8,h-6);
}
function drawChart(){
  if(!data)return;const {ctx,w,h}=canvasSize($('chartCanvas')),key=$('metric').value,history=data.history;
  const value=(row,counter=false)=>key==='risk'?(counter?row.unmitigated_risk:row.risk):key==='capacity'?(counter?row.unmitigated_capacity:row.capacity):(counter?row.unmitigated[key]:row.values[key]);
  const actual=history.map(x=>value(x)),counter=history.map(x=>value(x,true));
  let low=Math.min(...actual,...counter),high=Math.max(...actual,...counter);const pad=Math.max((high-low)*.15,key==='pointing'?.03:1);low=Math.max(key==='temperature'?-100:0,low-pad);high+=pad;
  const left=44,right=w-12,top=14,bottom=h-27,t0=history[0].time,t1=Math.max(history.at(-1).time,t0+30);
  const x=t=>left+(t-t0)/(t1-t0)*(right-left),y=v=>bottom-(v-low)/(high-low)*(bottom-top);
  ctx.font='11px system-ui';ctx.textAlign='right';
  for(let i=0;i<4;i++){const v=low+(high-low)*i/3,p=y(v);ctx.strokeStyle='#27394d';ctx.lineWidth=.6;ctx.beginPath();ctx.moveTo(left,p);ctx.lineTo(right,p);ctx.stroke();ctx.fillStyle='#91a7c0';ctx.fillText(v.toFixed(key==='pointing'?2:high-low<5?1:0),left-8,p+4);}
  ctx.textAlign='center';for(let i=0;i<4;i++){const t=t0+(t1-t0)*i/3;ctx.fillStyle='#91a7c0';ctx.fillText((t/60).toFixed(1)+'분',x(t),h-6);}
  for(const f of state.faults.filter(f=>f.satellite===state.selected&&f.at>=t0&&f.at<=state.elapsed)){ctx.setLineDash([2,4]);ctx.strokeStyle='#a77647';ctx.beginPath();ctx.moveTo(x(f.at),top);ctx.lineTo(x(f.at),bottom);ctx.stroke();}ctx.setLineDash([]);
  for(const a of state.actions.filter(a=>a.at>=t0&&a.at<=state.elapsed&&state.faults.some(f=>f.id===a.fault_id&&f.satellite===state.selected))){ctx.strokeStyle='#6addb477';ctx.beginPath();ctx.moveTo(x(a.at),top);ctx.lineTo(x(a.at),bottom);ctx.stroke();ctx.textAlign='left';ctx.fillStyle='#6addb4';ctx.fillText('대응',Math.min(x(a.at)+4,right-28),top+10);}
  function line(v,color,dash=[]){ctx.strokeStyle=color;ctx.lineWidth=2;ctx.setLineDash(dash);ctx.beginPath();v.forEach((n,i)=>{if(i)ctx.lineTo(x(history[i].time),y(n));else ctx.moveTo(x(history[i].time),y(n));});ctx.stroke();ctx.setLineDash([]);if(v.length===1){ctx.fillStyle=color;ctx.beginPath();ctx.arc(x(history[0].time),y(v[0]),3,0,Math.PI*2);ctx.fill();}}
  line(counter,'#b3a18a',[5,4]);line(actual,'#59d8ed');
  const last=history.at(-1),active=state.actions.some(a=>a.at<=state.elapsed&&state.faults.some(f=>f.id===a.fault_id&&f.satellite===state.selected));
  $('comparison').textContent=active?`현재 ${specs[key][0]}: 대응 ${value(last).toFixed(specs[key][2])}${specs[key][1]} · 미대응 가정 ${value(last,true).toFixed(specs[key][2])}${specs[key][1]} — 동일 조건에서 계산한 합성 비교입니다.`:'대응을 실행하면 같은 조건의 미대응 결과와 비교합니다.';
}
$('orbitCanvas').addEventListener('pointerdown',e=>{drag={x:e.clientX,y:e.clientY,lon:camera.lon,lat:camera.lat,moved:false};$('orbitCanvas').setPointerCapture(e.pointerId);});
$('orbitCanvas').addEventListener('pointermove',e=>{if(!drag||view!=='globe')return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>4)drag.moved=true;camera.lon=((drag.lon-dx*.4+540)%360)-180;camera.lat=Math.max(-80,Math.min(80,drag.lat+dy*.3));drawOrbit();});
$('orbitCanvas').addEventListener('pointerup',e=>{if(drag&&!drag.moved){const r=$('orbitCanvas').getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;const hit=hitPoints.map(p=>({...p,d:Math.hypot(p.x-x,p.y-y)})).sort((a,b)=>a.d-b.d)[0];if(hit&&hit.d<14)selectSatellite(hit.id);}drag=null;});
$('orbitCanvas').addEventListener('pointercancel',()=>drag=null);
new ResizeObserver(()=>{drawOrbit();drawChart();}).observe($('orbitCanvas'));
new ResizeObserver(()=>drawChart()).observe($('chartCanvas'));
document.addEventListener('visibilitychange',()=>{if(document.hidden&&playing){pause();notice('화면을 벗어나 실험을 일시정지했습니다.');}});
window.addEventListener('beforeunload',e=>{if(data&&!locallySaved){e.preventDefault();e.returnValue='';}});
async function init(){try{const [r,map]=await Promise.all([fetch('/api/catalog'),fetch('/static/world.json')]);if(!r.ok)throw Error('엔진 연결 실패');catalog=await r.json();if(map.ok)world=(await map.json()).lines;
  let saved=null,storageError=false;
  try{
    const raw=localStorage.getItem(lab.CURRENT);if(raw)saved=lab.decode(raw);
  }catch(e){storageError=true;}
  try{
    const raw=localStorage.getItem(lab.PREVIOUS);if(raw)previousExperiment=lab.decode(raw);
  }catch(e){previousExperiment=null;}
  if(saved){
    if(await refresh(saved)){fillConfig();notice('자동 저장된 실험을 복원했습니다. 시작을 누르면 이어서 진행합니다.');}
    else{await refresh(defaults,{persist:false});notice('자동 저장된 실험을 복원하지 못했습니다. 기존 저장본을 유지한 채 기본 화면을 표시합니다.',true);}
  }else{await refresh(defaults,{persist:!storageError});if(storageError)notice('자동 저장본을 읽지 못했습니다. 실험 저장으로 JSON을 보관하세요.',true);}
  if(!locallySaved)$('saveStatus').textContent='자동 저장 확인 필요 · 실험 저장으로 JSON을 보관하세요.';
  }catch(e){notice('서버 연결에 실패했습니다. 새로고침해 다시 시도하세요.',true);$('connection').textContent='연결 실패';}}
init();
