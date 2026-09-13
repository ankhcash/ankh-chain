const os=require('os'),fsp=require('fs'),p=require('path'),crypto=require('crypto');
const R='../src';
const StateManager=require(R+'/core/StateManager');
const SidechainManager=require(R+'/sidechain/SidechainManager');
const dir=fsp.mkdtempSync(p.join(os.tmpdir(),'sc-'));
let pass=0,fail=0; const ok=(n,c,x='')=>{c?(pass++,console.log('  PASS',n)):(fail++,console.log('  FAIL',n,x))};

(async()=>{
 const sm=new StateManager(dir); await sm.loadState().catch(()=>{});
 const sc=new SidechainManager(sm,{});
 const who='ankh_'+'a'.repeat(40);
 // a verified person with one month of allocation
 const h=crypto.randomBytes(32).toString('hex');
 sm.registerVerifiedUser(who,{hash:h,templateHash:h,descriptor:null},{estimatedAge:30,confidenceScore:0.8});
 sm.updateBalance(who, 5185n*10n**18n);
 const acct=sm.getAccount(who); acct.isVerified=true;

 const mk=(id)=>sc.proposeChain(who,{chainId:id,name:id+' chain',tier:'COMMUNITY',
   institutionType:'cooperative',authorities:[{address:who,name:'a',role:'validator'},
   {address:'ankh_'+'b'.repeat(40),name:'b',role:'validator'},{address:'ankh_'+'c'.repeat(40),name:'c',role:'validator'}]});

 console.log('=== COMMUNITY tier is self-serve ===');
 const r=await mk('village-one');
 ok('auto-approved without a vote', r.status==='APPROVED'||sc.sidechains.has('village-one'), 'status='+r.status);
 ok('chain is live', sc.sidechains.has('village-one'));

 console.log('\n=== unverified creator refused ===');
 const stranger='ankh_'+'f'.repeat(40);
 let threw=null; try{ await sc.proposeChain(stranger,{chainId:'x',name:'x',tier:'COMMUNITY',authorities:[1,2,3]}) }catch(e){threw=e.message}
 ok('rejected', !!threw); console.log('    ',threw);

 console.log('\n=== per-creator cap stops chain spam ===');
 for(let i=2;i<=5;i++) await mk('village-'+i);
 const sixth=await mk('village-6');
 ok('6th proposal not auto-approved', sixth.status==='PENDING' && !!sixth.autoApprovalWithheld);
 console.log('    ',sixth.autoApprovalWithheld);
 ok('first five are live', [1,2,3,4,5].every((i)=>sc.sidechains.has(i===1?'village-one':'village-'+i)));

 console.log('\n=== higher tiers still require a vote ===');
 sm.updateBalance(who, 200000n*10n**18n);
 const inst=await sc.proposeChain(who,{chainId:'big-org',name:'Big',tier:'INSTITUTIONAL',
   authorities:[{address:who},{address:'b'},{address:'c'}]});
 ok('INSTITUTIONAL stays PENDING', inst.status==='PENDING');

 console.log(`\n${pass} passed, ${fail} failed`);
 fsp.rmSync(dir,{recursive:true,force:true});
 process.exit(fail?1:0);
})().catch(e=>{console.error('SUITE ERROR:',e.message);process.exit(1)});
