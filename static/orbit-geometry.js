'use strict';
(function(root){
  const RAD=Math.PI/180;
  function vector(lat,lon,radius=1){
    const a=lat*RAD,b=lon*RAD;
    return [radius*Math.cos(a)*Math.cos(b),radius*Math.cos(a)*Math.sin(b),radius*Math.sin(a)];
  }
  // Earth-fixed coordinates, normalized by the engine's Earth radius.
  function orbitPoint(config,model,plane,phase,elapsed){
    const node=2*Math.PI*plane/config.planes-model.rotation_rate*elapsed;
    const inc=config.inclination*RAD,r=1+config.altitude/model.earth_radius_km;
    const c=Math.cos(phase),s=Math.sin(phase),cn=Math.cos(node),sn=Math.sin(node);
    return [r*(cn*c-sn*s*Math.cos(inc)),r*(sn*c+cn*s*Math.cos(inc)),r*s*Math.sin(inc)];
  }
  function position(config,model,id,elapsed){
    const plane=Math.floor(id/config.per_plane),slot=id%config.per_plane;
    const phase=2*Math.PI*(slot/config.per_plane+config.phasing*plane/(config.planes*config.per_plane)+elapsed/model.period_seconds);
    return orbitPoint(config,model,plane,phase,elapsed);
  }
  function frame(camera){
    const a=camera.lat*RAD,b=camera.lon*RAD;
    return {east:[-Math.sin(b),Math.cos(b),0],north:[-Math.sin(a)*Math.cos(b),-Math.sin(a)*Math.sin(b),Math.cos(a)],up:vector(camera.lat,camera.lon)};
  }
  function project(point,basis){
    const dot=v=>point.reduce((sum,n,i)=>sum+n*v[i],0);
    const x=dot(basis.east),y=dot(basis.north),z=dot(basis.up);
    // A far-side satellite can still be visible above the Earth's limb.
    return {x,y,z,visible:z>=0||x*x+y*y>1+1e-10};
  }
  function latLon(point){
    const r=Math.hypot(...point);
    return {lat:Math.asin(Math.max(-1,Math.min(1,point[2]/r)))/RAD,lon:Math.atan2(point[1],point[0])/RAD};
  }
  const api={vector,orbitPoint,position,frame,project,latLon};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.OrbitGeometry=api;
})(globalThis);
