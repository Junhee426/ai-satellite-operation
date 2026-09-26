'use strict';
(function(root){
  const CURRENT='orbit-lab.current.v1', PREVIOUS='orbit-lab.previous.v1';
  function decode(raw){
    const file=JSON.parse(raw);
    if(file?.format!=='orbit-lab-v1'||!file.simulation||typeof file.simulation!=='object'||Array.isArray(file.simulation))throw Error('ORBIT LAB v1 실험 파일을 선택하세요.');
    return file.simulation;
  }
  function encode(state){return JSON.stringify({format:'orbit-lab-v1',simulation:state});}
  function normalize(input,defaults){
    // Called only after API validation; mirror its numeric coercion for imported files.
    const state={...defaults,...input};
    return {...state,elapsed:Number(state.elapsed),seed:Number(state.seed),selected:Number(state.selected),
      config:Object.fromEntries(Object.entries({...defaults.config,...input.config}).map(([key,value])=>[key,Number(value)])),
      faults:(input.faults??[]).map(f=>({...f,satellite:Number(f.satellite),at:Number(f.at),severity:Number(f.severity??1)})),
      actions:(input.actions??[]).map(a=>({...a,at:Number(a.at)}))};
  }
  function fleet(satellites,{mode='all',query='',sort='id'}={}){
    const needle=query.trim().toLowerCase(),priority={critical:2,warning:1,normal:0};
    return satellites.filter(s=>(mode!=='anomaly'||s.status!=='normal')&&(mode!=='visible'||s.visible)&&
      (!needle||s.name.toLowerCase().includes(needle)||String(s.id+1).padStart(3,'0').includes(needle)))
      .sort((a,b)=>sort==='risk'?(priority[b.status]-priority[a.status]||b.risk-a.risk||a.id-b.id):a.id-b.id);
  }
  const api={CURRENT,PREVIOUS,decode,encode,normalize,fleet};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.OrbitLabState=api;
})(globalThis);
