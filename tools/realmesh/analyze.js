// slice a decimated model (rotated to face +Z, height-normalised) and print per-band extents for joint placement
const fs=require('fs'),path=require('path');
const dir=process.argv[2];
const g=JSON.parse(fs.readFileSync(path.join(dir,'scene.gltf')));const bin=fs.readFileSync(path.join(dir,'scene.bin')).buffer.slice(0);
const a=g.accessors[0],bv=g.bufferViews[a.bufferView];const P=new Float32Array(bin,bv.byteOffset,a.count*3);
let mn=[1e9,1e9,1e9],mx=[-1e9,-1e9,-1e9];for(let i=0;i<a.count;i++)for(let k=0;k<3;k++){mn[k]=Math.min(mn[k],P[i*3+k]);mx[k]=Math.max(mx[k],P[i*3+k]);}
const H=mx[1]-mn[1];
// rotate -90deg about Y: (x,z)->( -z? ) compute: x' = x cos - ... use theta=-pi/2: x' = x*0 + z*(-1) = -z ; z' = -x*(-1)+z*0 = x
const V=[];for(let i=0;i<a.count;i++){const x=P[i*3],y=P[i*3+1],z=P[i*3+2];V.push([(-z)/H,(y-mn[1])/H,(x)/H]);}
// recentre x/z on the ankle band centre? centre on the mean of the head band
const bands=24;const rows=[];
for(let b=0;b<bands;b++){const y0=b/bands,y1=(b+1)/bands;const S=V.filter(v=>v[1]>=y0&&v[1]<y1);if(!S.length){rows.push(null);continue;}
 const xs=S.map(v=>v[0]),zs=S.map(v=>v[2]);const L=S.filter(v=>v[0]>0),R=S.filter(v=>v[0]<=0);
 const mean=A=>A.reduce((s,v)=>s+v,0)/(A.length||1);
 rows.push({y:(y0+y1)/2,n:S.length,xmin:Math.min(...xs),xmax:Math.max(...xs),zmin:Math.min(...zs),zmax:Math.max(...zs),lx:mean(L.map(v=>v[0])),rx:mean(R.map(v=>v[0])),lz:mean(L.map(v=>v[2])),rz:mean(R.map(v=>v[2]))});}
for(const r of rows) if(r) console.log(r.y.toFixed(3),'n',r.n,'x',r.xmin.toFixed(3),r.xmax.toFixed(3),'z',r.zmin.toFixed(3),r.zmax.toFixed(3),'Lx',r.lx.toFixed(3),'Rx',r.rx.toFixed(3),'Lz',r.lz.toFixed(3),'Rz',r.rz.toFixed(3));
// x-histogram for y<0.42 (legs + sword)
const hist={};for(const v of V) if(v[1]<0.42){const k=(Math.round(v[0]*40)/40).toFixed(3);hist[k]=(hist[k]||0)+1;}
console.log('x-hist y<0.42:',Object.entries(hist).sort((a,b)=>a[0]-b[0]).map(([k,n])=>k+':'+n).join(' '));
console.log('H',H.toFixed(3),'centre x',((mn[0]+mx[0])/2/H).toFixed(3));
