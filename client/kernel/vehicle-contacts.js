import {Vector3,Matrix4,Euler,Quaternion} from 'three';
// § Functional convex horizontal hull contacts; exact translation sweep, vertical
// interval gate. Not a PhysX/Rapier replacement; conservative authoring boxes.
export const CONTACT_DEFAULTS=Object.freeze({skin:1e-4,iterations:6,epsilon:1e-9});
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1];
const sub=(a,b)=>[a[0]-b[0],a[1]-b[1]];
const cross=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);
function hull(points){
 const p=points.sort((a,b)=>a[0]-b[0]||a[1]-b[1]).filter((a,i,v)=>!i||a[0]!==v[i-1][0]||a[1]!==v[i-1][1]);
 const lo=[],hi=[];for(const a of p){while(lo.length>1&&cross(lo.at(-2),lo.at(-1),a)<=0)lo.pop();lo.push(a);}for(const a of [...p].reverse()){while(hi.length>1&&cross(hi.at(-2),hi.at(-1),a)<=0)hi.pop();hi.push(a);}return lo.slice(0,-1).concat(hi.slice(0,-1));
}
const dense3=v=>Array.isArray(v)&&v.length===3&&[0,1,2].every(i=>Number.isFinite(v[i]));
export function boxFootprint(box,matrix){
 const size=box?.size,pos=box?.position??[0,0,0],rot=box?.rotation??[0,0,0];
 if(!dense3(size)||!size.every(v=>v>0)||!dense3(pos)||!dense3(rot)||!matrix?.elements?.every(Number.isFinite))throw Error('invalid vehicle contact box');
 const local=new Matrix4().compose(new Vector3(...pos),new Quaternion().setFromEuler(new Euler(...rot,'XYZ')),new Vector3(1,1,1));local.premultiply(matrix);
 const pts=[],ys=[];for(const x of [-.5,.5])for(const y of [-.5,.5])for(const z of [-.5,.5]){const v=new Vector3(x*size[0],y*size[1],z*size[2]).applyMatrix4(local);pts.push([v.x,v.z]);ys.push(v.y);}
 const poly=hull(pts);if(poly.length<3)throw Error('degenerate vehicle contact box');
 return {poly,minY:Math.min(...ys),maxY:Math.max(...ys),step:!!box.step};
}
function axes(poly){return poly.map((p,i)=>{const d=sub(poly[(i+1)%poly.length],p),n=Math.hypot(...d);return[-d[1]/n,d[0]/n];});}
function span(poly,n){const d=poly.map(p=>dot(p,n));return[Math.min(...d),Math.max(...d)];}
export function sweepFootprints(a,b,delta,{epsilon=CONTACT_DEFAULTS.epsilon}={}){
 let enter=-Infinity,leave=Infinity,normal=null,depth=Infinity,push=null,overlap=true;
 for(const n of [...axes(a.poly),...axes(b.poly)]){
  const [amin,amax]=span(a.poly,n),[bmin,bmax]=span(b.poly,n),v=dot(delta,n);
  const left=amax-bmin,right=bmax-amin;
  if(left<-epsilon||right<-epsilon)overlap=false;
  const d=Math.min(left,right);if(d<depth){depth=d;push=left<right?[-n[0],-n[1]]:n;}
  if(Math.abs(v)<epsilon){if(left<-epsilon||right<-epsilon)return null;continue;}
  const t1=(bmin-amax)/v,t2=(bmax-amin)/v,tin=Math.min(t1,t2),tout=Math.max(t1,t2);
  if(tin>enter){enter=tin;normal=v>0?[-n[0],-n[1]]:n;}leave=Math.min(leave,tout);
  if(enter>leave+epsilon)return null;
 }
 if(overlap&&depth>epsilon)return{t:0,normal:push,depth};
 if(enter< -epsilon||enter>1+epsilon||leave<0||!normal||dot(delta,normal)>=-epsilon)return null;
 return{t:Math.max(0,enter),normal,depth:0};
}
function closest(p,a,b){const d=sub(b,a),l=dot(d,d),t=l?Math.max(0,Math.min(1,dot(sub(p,a),d)/l)):0;return[a[0]+d[0]*t,a[1]+d[1]*t];}
export function contactPoint(a,b){
 let best=Infinity,points=[];for(const [p,q]of [[a.poly,b.poly],[b.poly,a.poly]])for(const v of p)for(let j=0;j<q.length;j++){
  const c=closest(v,q[j],q[(j+1)%q.length]),d=(v[0]-c[0])**2+(v[1]-c[1])**2;
  if(d<best-1e-8){best=d;points=[];}if(Math.abs(d-best)<1e-8)points.push([(v[0]+c[0])/2,(v[1]+c[1])/2]);
 }
 return[points.reduce((s,p)=>s+p[0],0)/points.length,(Math.max(a.minY,b.minY)+Math.min(a.maxY,b.maxY))/2,points.reduce((s,p)=>s+p[1],0)/points.length];
}
function shifted(a,d){return{...a,poly:a.poly.map(p=>[p[0]+d[0],p[1]+d[1]])};}
export function moveVehicleFootprints(shapes,obstacles,delta,velocity,{skin=CONTACT_DEFAULTS.skin,iterations=CONTACT_DEFAULTS.iterations,stepHeight=0,feet=-Infinity}={}){
 if(![...delta,...velocity,skin].every(Number.isFinite)||skin<0||!Number.isInteger(iterations)||iterations<1)throw Error('invalid vehicle contact motion');
 let move=[...delta],offset=[0,0],speed=[...velocity];const contacts=[];
 for(let pass=0;pass<iterations;pass++){
  let best=null;
  for(const own of shapes)for(const obstacle of obstacles){
   if(own.maxY<=obstacle.minY||own.minY>=obstacle.maxY||(obstacle.step&&obstacle.maxY<=feet+stepHeight))continue;
   const a=shifted(own,offset),hit=sweepFootprints(a,obstacle,move);if(!hit)continue;
   if(!best||hit.t<best.t||(hit.t===best.t&&hit.depth>best.depth))best={...hit,a,b:obstacle};
  }
  if(!best){offset[0]+=move[0];offset[1]+=move[1];break;}
  const n=best.normal,travel=[move[0]*best.t,move[1]*best.t];offset[0]+=travel[0];offset[1]+=travel[1];
  const point=contactPoint(shifted(best.a,travel),best.b),closing=Math.max(0,-dot(speed,n));
  if(closing>0)contacts.push({id:best.b.id,point,normal:[n[0],0,n[1]],speed:closing});
  offset[0]+=n[0]*(best.depth+skin);offset[1]+=n[1]*(best.depth+skin);
  move=move.map(v=>v*(1-best.t));const into=dot(move,n);if(into<0)move=move.map((v,i)=>v-n[i]*into);
  const incoming=dot(speed,n);if(incoming<0)speed=speed.map((v,i)=>v-n[i]*incoming);
 }
 return{offset,velocity:speed,contacts};
}
