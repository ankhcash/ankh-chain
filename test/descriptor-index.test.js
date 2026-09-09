const DI=require('../src/core/DescriptorIndex');
const crypto=require('crypto');
function fd(){const v=new Float32Array(128);let n=0;for(let i=0;i<128;i++){v[i]=(Math.random()*2-1)*0.15;n+=v[i]*v[i]}n=Math.sqrt(n);for(let i=0;i<128;i++)v[i]/=n;return v}
function perturb(d,e){const v=Float32Array.from(d);let n=0;for(let i=0;i<128;i++){v[i]+=(Math.random()*2-1)*e;n+=v[i]*v[i]}n=Math.sqrt(n);for(let i=0;i<128;i++)v[i]/=n;return v}
function brute(vecs,q,T){let b=null;for(const[h,v]of vecs){let s=0;for(let i=0;i<128;i++){const d=q[i]-v[i];s+=d*d}const dist=Math.sqrt(s);if(dist<T&&(!b||dist<b.distance))b={hash:h,distance:dist}}return b}
let pass=0,fail=0; const ok=(n,c)=>{c?(pass++,console.log('  PASS',n)):(fail++,console.log('  FAIL',n))};

console.log('=== EXACTNESS vs brute force (200k index, 500 queries) ===');
const idx=new DI(); const vecs=[];
for(let i=0;i<200000;i++){const h=crypto.randomBytes(32).toString('hex');const v=fd();vecs.push([h,v]);idx.add(h,v)}
let mism=0, dupFound=0, dupTotal=0;
for(let q=0;q<500;q++){
  // half are near-duplicates at varying distance, half unrelated
  const query = q%2===0 ? perturb(vecs[q][1], 0.02+Math.random()*0.35) : fd();
  const got=idx.search(query,0.6);
  const bf=brute(vecs,query,0.6);
  if(bf){dupTotal++; if(got&&got.hash===bf.hash)dupFound++}
  if((got?got.hash:null)!==(bf?bf.hash:null))mism++;
}
ok(`0 mismatches vs brute force (got ${mism})`, mism===0);
ok(`every brute-force duplicate found (${dupFound}/${dupTotal})`, dupFound===dupTotal);

console.log('\n=== NO FALSE NEGATIVES at the threshold boundary ===');
let missed=0;
for(let t=0;t<300;t++){
  const base=vecs[t][1];
  // land right around the 0.6 boundary where quantisation error matters most
  let v=perturb(base,0.30); const idxr=new DI();
  const exact=Math.sqrt(base.reduce((a,x,i)=>a+(x-v[i])**2,0));
  const got=idx.search(v,0.6);
  if(exact<0.6 && (!got||got.hash!==vecs[t][0])) missed++;
}
ok(`no boundary duplicate missed (${missed} missed)`, missed===0);

console.log('\n=== MEMORY / SPEED ===');
const st=idx.getStats();
console.log(`  ${st.entries.toLocaleString()} entries, ${st.memoryMB} MB = ${st.bytesPerEntry} B/entry`);
console.log(`  quantisation error bound: ${st.quantErrorBound}`);
const Q=200,qs=[];for(let i=0;i<Q;i++)qs.push(fd());
let t=process.hrtime.bigint(); for(const q of qs) idx.search(q,0.6);
const ms=Number(process.hrtime.bigint()-t)/1e6/Q;
console.log(`  ${ms.toFixed(1)} ms/query at 200k  (was 42 ms) -> ${(ms/42*100).toFixed(0)}% of old cost`);
console.log(`  projected 21M single node: ${(ms*21e6/200000/1000).toFixed(1)}s`);
console.log(`  projected 21M across 20 nodes: ${(ms*21e6/200000/20*1000/1000).toFixed(0)}ms each`);
console.log(`  memory at 21M: int8-only ${(21e6*128/1e9).toFixed(1)} GB | with exact ${(21e6*640/1e9).toFixed(1)} GB`);

console.log('\n=== int8-only mode fails SAFE (no exact vectors) ===');
const lean=new DI({exactVectors:false});
for(const [h,v] of vecs.slice(0,20000)) lean.add(h,v);
let leanMiss=0;
for(let q=0;q<200;q++){const query=perturb(vecs[q][1],0.05);const g=lean.search(query,0.6);if(!g||g.hash!==vecs[q][0])leanMiss++}
ok(`int8-only still finds duplicates (${leanMiss} missed)`, leanMiss===0);
console.log(`  int8-only memory: ${lean.getStats().bytesPerEntry} B/entry`);

console.log('\n=== range sharding (network split) ===');
const parts=4; let found=null;
const target=perturb(vecs[77][1],0.05);
for(let p=0;p<parts;p++){const {from,to}=idx.rangeFor(p,parts);const r=idx.scanRange(target,0.6,from,to);if(r&&(!found||r.distance<found.distance))found=r}
ok('sharded scan finds the same match as full scan', found && found.hash===vecs[77][0]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
