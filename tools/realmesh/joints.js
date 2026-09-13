// propose joint positions from the normalised mesh: per height band, k-means the x of vertices into clusters
const fs=require('fs');const S=require('./models/skin.js');
const [,, rig, capeZarg]=process.argv;const spec=JSON.parse(fs.readFileSync(`${__dirname}/models/rigs/${rig}.json`));
const dir=`${__dirname}/models/${spec.model}`;const g=JSON.parse(fs.readFileSync(dir+'/scene.gltf'));const bin=fs.readFileSync(dir+'/scene.bin').buffer.slice(0);
const a=g.accessors[0],bv=g.bufferViews[a.bufferView];const P=new Float32Array(bin,bv.byteOffset,a.count*3);const N=S.normalise(P,spec.yaw);
const V=[];for(let i=0;i<a.count;i++)V.push([N[i*3],N[i*3+1],N[i*3+2]]);
const capeZ=capeZarg!=null?+capeZarg:spec.capeZ;
function kmeans(xs,k){let cs=[];const s=[...xs].sort((a,b)=>a-b);for(let i=0;i<k;i++)cs.push(s[Math.floor((i+0.5)*s.length/k)]);for(let it=0;it<30;it++){const sum=Array(k).fill(0),n=Array(k).fill(0);for(const x of xs){let b=0;for(let i=1;i<k;i++)if(Math.abs(x-cs[i])<Math.abs(x-cs[b]))b=i;sum[b]+=x;n[b]++;}cs=cs.map((c,i)=>n[i]?sum[i]/n[i]:c);}return cs.sort((a,b)=>a-b);}
function band(y0,y1,filter=v=>true){return V.filter(v=>v[1]>=y0&&v[1]<y1&&v[2]>capeZ&&filter(v));}
const mean=(A,k)=>A.reduce((s,v)=>s+v[k],0)/(A.length||1);
const out={};
// head / neck / torso centre
const headB=band(0.86,1.0);out.top=[mean(headB,0),1.0,mean(headB,2)];
const neckB=band(0.82,0.88);out.neck=[mean(neckB,0),0.85,mean(neckB,2)];
for(const [nm,y] of [['sh',0.80],['el',0.62],['wr',0.47],['tip',0.41]]){const B=band(y-0.02,y+0.02);const xs=B.map(v=>v[0]);const cs=kmeans(xs,3);const near=c=>B.filter(v=>Math.abs(v[0]-c)<0.05);out[nm]={R:[cs[0],y,mean(near(cs[0]),2)],T:[cs[1],y,mean(near(cs[1]),2)],L:[cs[2],y,mean(near(cs[2]),2)]};}
const waistB=band(0.54,0.58,v=>Math.abs(v[0]-out.el.T[0])<0.12);out.waist=[mean(waistB,0),0.56,mean(waistB,2)];
const hipB=band(0.48,0.52,v=>Math.abs(v[0]-out.el.T[0])<0.14);const hx=kmeans(hipB.map(v=>v[0]),2);out.hip={R:[hx[0],0.50,mean(hipB,2)],L:[hx[1],0.50,mean(hipB,2)]};
for(const [nm,y] of [['knee',0.27],['ankle',0.06]]){const B=band(y-0.02,y+0.02,v=>Math.abs(v[0]-out.el.T[0])<0.16&&!(v[0]<out.el.T[0]-0.13));const cs=kmeans(B.map(v=>v[0]),2);const near=c=>B.filter(v=>Math.abs(v[0]-c)<0.05);out[nm]={R:[cs[0],y,mean(near(cs[0]),2)],L:[cs[1],y,mean(near(cs[1]),2)]};}
const r3=v=>v.map(x=>+x.toFixed(3));
const J={root:r3([out.waist[0],0.50,out.waist[2]]),waist:r3(out.waist),neck:r3(out.neck),top:r3(out.top),
 hipL:r3(out.hip.L),kneeL:r3(out.knee.L),ankleL:r3(out.ankle.L),hipR:r3(out.hip.R),kneeR:r3(out.knee.R),ankleR:r3(out.ankle.R),
 shoulderL:r3([out.sh.T[0]+(out.sh.L[0]-out.sh.T[0])*0.55,0.80,out.sh.L[2]]),elbowL:r3(out.el.L),wristL:r3(out.wr.L),tipL:r3(out.tip.L),
 shoulderR:r3([out.sh.T[0]+(out.sh.R[0]-out.sh.T[0])*0.55,0.80,out.sh.R[2]]),elbowR:r3(out.el.R),wristR:r3(out.wr.R),tipR:r3(out.tip.R)};
console.log(JSON.stringify(J));
console.log('torso centre x at shoulder/elbow/wrist:',out.sh.T[0].toFixed(3),out.el.T[0].toFixed(3),out.wr.T[0].toFixed(3));
