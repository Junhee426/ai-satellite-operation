const {test}=require('node:test');
const assert=require('node:assert/strict');
const lab=require('../static/lab-state.js');
const defaults={config:{altitude:1280,planes:8,per_plane:16},elapsed:0,selected:0,seed:42,faults:[],actions:[]};
test('experiment files round-trip without losing event timing',()=>{
 const state={...defaults,elapsed:600,faults:[{id:'f',at:180,severity:1}],actions:[{fault_id:'f',at:600}]};
 assert.deepEqual(lab.decode(lab.encode(state)),state);
});
test('malformed and unrelated files are rejected',()=>{
 for(const raw of ['{','null','[]','{}','{"format":"other","simulation":{}}','{"format":"orbit-lab-v1","simulation":[]}'])assert.throws(()=>lab.decode(raw));
});
test('validated partial imports receive defaults without changing inputs',()=>{
 const input={config:{altitude:600},faults:[{id:'f',kind:'thermal',at:0,satellite:0}]};
 const before=JSON.stringify(input),state=lab.normalize(input,defaults);
 assert.equal(state.config.altitude,600);assert.equal(state.config.planes,8);assert.equal(state.seed,42);assert.equal(state.faults[0].severity,1);
 assert.equal(JSON.stringify(input),before);assert.equal(defaults.config.altitude,1280);
});
const sats=[{id:2,name:'K-LEO 003',status:'normal',risk:90,visible:true},{id:1,name:'K-LEO 002',status:'critical',risk:20,visible:false},{id:0,name:'K-LEO 001',status:'warning',risk:80,visible:true},{id:3,name:'K-LEO 004',status:'critical',risk:20,visible:true}];
test('risk sort prioritizes rule warnings even when the AI index is lower',()=>{
 assert.deepEqual(lab.fleet(sats,{sort:'risk'}).map(s=>s.id),[1,3,0,2]);assert.equal(sats[0].id,2);
});
test('search intersects with status and visibility filters',()=>{
 assert.deepEqual(lab.fleet(sats,{mode:'anomaly',query:'  k-leo 00 ',sort:'risk'}).map(s=>s.id),[1,3,0]);
 assert.deepEqual(lab.fleet(sats,{mode:'visible',query:'002'}),[]);
 assert.deepEqual(lab.fleet(sats,{query:'003'}).map(s=>s.id),[2]);
 assert.deepEqual(lab.fleet(sats).map(s=>s.id),[0,1,2,3]);
});

test('numeric strings accepted by the API behave as numbers after import',()=>{
 const state=lab.normalize({elapsed:'120',seed:'117',selected:'0',config:{altitude:'600'},faults:[{id:'f',satellite:'0',at:'30',severity:'0.8'}],actions:[{fault_id:'f',at:'90'}]},defaults);
 assert.equal(state.elapsed+300,420);assert.equal(state.seed,117);assert.equal(state.selected,0);
 assert.equal(state.config.altitude,600);assert.equal(state.faults[0].satellite,0);assert.equal(state.faults[0].at,30);assert.equal(state.faults[0].severity,.8);assert.equal(state.actions[0].at,90);
});
