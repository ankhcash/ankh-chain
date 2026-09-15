// Descriptors are only folded into the state root when this is on, and the
// suite asserts that behaviour — so set it here rather than relying on the
// runner's environment. A direct `node test/integration.test.js` then gives
// the same result as `npm test`.
process.env.ANKH_COMMIT_DESCRIPTORS = process.env.ANKH_COMMIT_DESCRIPTORS || '1';

const os=require('os'),fsp=require('fs'),p=require('path'),crypto=require('crypto');
const ROOT='../src';
const StateManager=require(ROOT+'/core/StateManager');
const Verifier=require(ROOT+'/verification/EnhancedBiometricVerifier');
const G=require(ROOT+'/core/GenesisConfig');

const dir=fsp.mkdtempSync(p.join(os.tmpdir(),'ankh-it-'));
let pass=0,fail=0;
const ok=(n,c)=>{c?(pass++,console.log('  PASS',n)):(fail++,console.log('  FAIL',n))};

// face-api descriptors are NOT L2-normalised. Measured over face-api's own
// bundled sample faces on the wasm backend — 22 descriptors from 6 images:
// L2 norm 1.3766-1.5054, mean 1.4571.
//
// This fixture used to emit unit vectors and call them "realistic". That is
// precisely why the descriptor norm gate could be set to 0.85-1.15 and still
// look correct here, while rejecting 100% of real faces in production. Fixtures
// that cannot fail a gate cannot police it.
const REAL_NORM_LO = 1.38, REAL_NORM_HI = 1.50;
function faceDescriptor(){
  const v=new Array(128);let n=0;
  for(let i=0;i<128;i++){v[i]=(Math.random()*2-1)*0.15;n+=v[i]*v[i]}
  n=Math.sqrt(n);
  const target=REAL_NORM_LO+Math.random()*(REAL_NORM_HI-REAL_NORM_LO);
  for(let i=0;i<128;i++)v[i]=v[i]/n*target;
  return v;
}
// Preserves the source magnitude so Euclidean distances stay on the scale
// SAME_PERSON_THRESHOLD (0.6, face-api's standard) is defined against.
function perturb(d,eps){
  const src=Math.sqrt(d.reduce((s,x)=>s+x*x,0));
  const v=d.slice();let n=0;
  for(let i=0;i<128;i++){v[i]+=(Math.random()*2-1)*eps;n+=v[i]*v[i]}
  n=Math.sqrt(n);
  for(let i=0;i<128;i++)v[i]=v[i]/n*src;
  return v;
}
function seq(base=Date.now()-20000){
  const types=['center','left','right','blink','smile','center','blink'];
  const off=[0,1600,4100,6300,8900,11200,13800];
  return types.map((t,i)=>({type:t,timestamp:base+off[i]+Math.floor(Math.random()*40),score:t==='blink'?0.9:0.88}));
}
const bio=(d,extra={})=>({facial:{sequence:seq(),descriptor:d,ageEstimate:30,ageConfidence:0.8,quality:0.8,landmarks:Array.from({length:68},(_,i)=>({x:i,y:i})),...extra}});

(async()=>{
 const sm=new StateManager(dir); await sm.loadState().catch(()=>{});
 const v=new Verifier(sm,null);

 console.log('\n[1] Genuine verification succeeds');
 const d1=faceDescriptor();
 const r1=await v.verify('ankh_'+'1'.repeat(40), bio(d1), '1.2.3.4');
 ok('accepted', r1.success);
 if(!r1.success) console.log('    reason:',r1.reason);
 // simulate chain registration
 if(r1.success){ sm.registerVerifiedUser('ankh_'+'1'.repeat(40),{hash:r1.biometricHash,templateHash:r1.biometricHash,descriptor:d1},{estimatedAge:30,confidenceScore:0.8}); }

 console.log('\n[2] FORGED descriptor rejected (the Sybil hole)');
 const junk=Array.from({length:128},()=>Math.random()*2-1); // not unit-norm
 const r2=await v.verify('ankh_'+'2'.repeat(40), bio(junk), '5.6.7.8');
 ok('rejected', !r2.success);
 ok('cited as not-face-api', /not a valid face embedding|L2 norm/.test(r2.reason||''));
 console.log('    reason:',r2.reason);

 console.log('\n[3] Same face, different address -> duplicate');
 const r3=await v.verify('ankh_'+'3'.repeat(40), bio(perturb(d1,0.02)), '9.9.9.9');
 ok('rejected as duplicate', !r3.success && /[Dd]uplicate/.test(r3.reason||''));
 console.log('    reason:',(r3.reason||'').slice(0,110));

 console.log('\n[4] Different face accepted');
 const d4=faceDescriptor();
 const r4=await v.verify('ankh_'+'4'.repeat(40), bio(d4), '4.4.4.4');
 ok('accepted', r4.success);
 if(!r4.success)console.log('    reason:',r4.reason);
 if(r4.success) sm.registerVerifiedUser('ankh_'+'4'.repeat(40),{hash:r4.biometricHash,templateHash:r4.biometricHash,descriptor:d4},{estimatedAge:30,confidenceScore:0.8});

 console.log('\n[5] Cooldown blocks re-verification of a verified address');
 const r5=await v.verify('ankh_'+'1'.repeat(40), bio(faceDescriptor()), '1.2.3.4');
 ok('rejected by cooldown', !r5.success && /cooldown|re-verification/i.test(r5.reason||''));
 console.log('    reason:',r5.reason);

 console.log('\n[6] Constant / degenerate descriptor rejected');
 const flat=new Array(128).fill(1/Math.sqrt(128)); // norm 1 but degenerate
 const r6=await v.verify('ankh_'+'6'.repeat(40), bio(flat), '6.6.6.6');
 ok('rejected', !r6.success);
 console.log('    reason:',r6.reason);

 console.log('\n[7] Rate limit still enforced per IP');
 let limited=false;
 for(let i=0;i<8;i++){const dd=faceDescriptor();const addr='ankh_'+String(i).repeat(40);
   const r=await v.verify(addr, bio(dd), '7.7.7.7');
   if(r.success) sm.registerVerifiedUser(addr,{hash:r.biometricHash,templateHash:r.biometricHash,descriptor:dd},{estimatedAge:30,confidenceScore:0.8});
   if(/Rate limit/.test(r.reason||'')) limited=true}
 ok('rate limited', limited);

 console.log('\n[8] saveState is race-free under concurrency');
 sm.stats.totalVerifiedUsers=42;
 const errs=[];
 process.on('unhandledRejection',e=>errs.push(e));
 await Promise.all(Array.from({length:25},()=>sm.saveState().catch(e=>errs.push(e))));
 ok('no rename/ENOENT errors', errs.length===0);
 if(errs.length)console.log('    errors:',errs.slice(0,2).map(e=>e.message));
 const leftover=fsp.readdirSync(dir).filter(f=>f.endsWith('.tmp'));
 ok('no leftover .tmp files', leftover.length===0);

 console.log('\n[9] Dirty tracking: unchanged state writes nothing');
 const w1=await sm._writeStateOnce();
 ok('0 files rewritten when clean', w1.filesWritten===0, );
 console.log('    filesWritten:',w1.filesWritten,'biometricShards:',w1.biometricShards);
 sm.stats.totalVerifiedUsers=43;
 const w2=await sm._writeStateOnce();
 ok('writes after a change', w2.filesWritten>0);
 console.log('    filesWritten:',w2.filesWritten);

 console.log('\n[10] Descriptors survive restart uncapped + state root commits to them');
 const rootA=sm.calculateStateRoot();
 const n=sm.biometricDescriptors.size;
 await sm.saveState();
 const sm2=new StateManager(dir); await sm2.loadState();
 ok('descriptor count preserved', sm2.biometricDescriptors.size===n);
 console.log('    descriptors:',n,'->',sm2.biometricDescriptors.size);
 ok('state root reproduces after reload', sm2.calculateStateRoot()===rootA);
 // changing a descriptor must change the root
 const before=sm2.calculateStateRoot();
 sm2.storeDescriptor('deadbeef'.repeat(8), faceDescriptor());
 ok('state root changes when a descriptor is added', sm2.calculateStateRoot()!==before);

 console.log(`\n${pass} passed, ${fail} failed`);
 fsp.rmSync(dir,{recursive:true,force:true});
 process.exit(fail?1:0);
})();
