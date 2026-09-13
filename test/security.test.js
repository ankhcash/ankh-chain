const os=require('os'),fsp=require('fs'),p=require('path'),crypto=require('crypto');
const R='../src';
const AnkhBlockchain=require(R+'/core/AnkhBlockchain');
const StateManager=require(R+'/core/StateManager');
const Transaction=require(R+'/core/Transaction');
const Block=require(R+'/core/Block');
const ActionAuth=require(R+'/core/ActionAuth');
const EthereumBridge=require(R+'/bridge/EthereumBridge');
const {ec:EC}=require('elliptic'); const ec=new EC('secp256k1');

let pass=0,fail=0;
const ok=(n,c,extra='')=>{c?(pass++,console.log('  PASS',n)):(fail++,console.log('  FAIL',n,extra))};
const key=()=>{const k=ec.genKeyPair();const pub=k.getPublic('hex');
  return {k,pub,addr:ActionAuth.deriveAddress(pub)}};
const sign=(k,msg)=>{const h=crypto.createHash('sha256').update(msg).digest();const s=k.sign(h);
  return {publicKey:k.getPublic('hex'),r:s.r.toString(16).padStart(64,'0'),s:s.s.toString(16).padStart(64,'0')}};

(async()=>{
const dir=fsp.mkdtempSync(p.join(os.tmpdir(),'sec-'));
const bc=new AnkhBlockchain({dataDir:dir});
bc.stateManager=new StateManager(dir);
await bc.stateManager.loadState().catch(()=>{});
const node=key(); bc.nodeIdentity={address:node.addr,publicKey:node.pub,privateKey:node.k.getPrivate('hex')};
await bc.initialize();

console.log('\n=== CRITICAL #1: SYSTEM blocks bypass consensus ===');
const prev=bc.getLatestBlock();
// attacker forges a SYSTEM block minting themselves a balance
const evil=new Block({index:prev.index+1,timestamp:Date.now()+1,transactions:[],
  previousHash:prev.hash,validator:'system',consensusType:'SYSTEM',stateRoot:'0x0'});
let v=bc.validateBlock(evil,prev);
ok('unsigned SYSTEM block rejected', !v.valid, v.reason);
console.log('    reason:', v.reason);

// signed by a NON-registered key
const outsider=key();
const evil2=new Block({index:prev.index+1,timestamp:Date.now()+1,transactions:[],
  previousHash:prev.hash,validator:outsider.addr,consensusType:'SYSTEM',stateRoot:'0x0',
  extraData:{producerPublicKey:outsider.pub}});
evil2.sign(outsider.k.getPrivate('hex'));
bc.stateManager.registerNode(node.pub, node.addr);   // registry now non-empty
v=bc.validateBlock(evil2,prev);
ok('SYSTEM block from unregistered node rejected', !v.valid, v.reason);
console.log('    reason:', v.reason);

// tampered signature
const evil3=new Block({index:prev.index+1,timestamp:Date.now()+1,transactions:[],
  previousHash:prev.hash,validator:node.addr,consensusType:'SYSTEM',stateRoot:'0x0',
  extraData:{producerPublicKey:node.pub}});
evil3.sign(node.k.getPrivate('hex'));
// Flip the first nibble to a definitely-different value. Replacing it with a
// fixed character left the signature untouched whenever it already started
// with that character, so the tamper test passed validation ~1 run in 16.
const r0 = evil3.validatorSignature.r;
evil3.validatorSignature.r = (r0[0] === '0' ? '1' : '0') + r0.slice(1);
v=bc.validateBlock(evil3,prev);
ok('SYSTEM block with tampered signature rejected', !v.valid, v.reason);

// legitimate signed block from the registered node
const good=new Block({index:prev.index+1,timestamp:Date.now()+1,transactions:[],
  previousHash:prev.hash,validator:node.addr,consensusType:'SYSTEM',stateRoot:'0x0',
  extraData:{producerPublicKey:node.pub}});
good.sign(node.k.getPrivate('hex'));
v=bc.validateBlock(good,prev);
ok('legitimate signed SYSTEM block accepted', v.valid, v.reason);

console.log('\n=== CRITICAL #2: transfers carry no on-chain authorization ===');
const alice=key(), bob=key();
const unsignedTx=Transaction.createTransfer(alice.addr,bob.addr,1000n,0n,0);
const blkU=new Block({index:prev.index+1,timestamp:Date.now()+1,transactions:[unsignedTx],
  previousHash:prev.hash,validator:node.addr,consensusType:'SYSTEM',stateRoot:'0x0',
  extraData:{producerPublicKey:node.pub}});
blkU.sign(node.k.getPrivate('hex'));
v=bc.validateBlock(blkU,prev);
ok('transfer with no authorization rejected', !v.valid, v.reason);
console.log('    reason:', v.reason);

// forged: bob signs a transfer FROM alice
const ts=Date.now();
const msgFromAlice=ActionAuth.transferMessage({from:alice.addr,to:bob.addr,amount:'1000',timestamp:ts});
const bobSig=sign(bob.k,msgFromAlice);
const forged=Transaction.createTransfer(alice.addr,bob.addr,1000n,0n,0);
forged.data={...forged.data,auth:{...bobSig,timestamp:ts,amount:'1000'}};
const blkF=new Block({index:prev.index+1,timestamp:Date.now()+1,transactions:[forged],
  previousHash:prev.hash,validator:node.addr,consensusType:'SYSTEM',stateRoot:'0x0',
  extraData:{producerPublicKey:node.pub}});
blkF.sign(node.k.getPrivate('hex'));
v=bc.validateBlock(blkF,prev);
ok("transfer signed by someone other than the sender rejected", !v.valid, v.reason);
console.log('    reason:', v.reason);

// tampered amount: alice signs 1000, block claims 999999
const aliceSig=sign(alice.k,msgFromAlice);
const tampered=Transaction.createTransfer(alice.addr,bob.addr,999999n,0n,0);
tampered.data={...tampered.data,auth:{...aliceSig,timestamp:ts,amount:'999999'}};
const blkT=new Block({index:prev.index+1,timestamp:Date.now()+1,transactions:[tampered],
  previousHash:prev.hash,validator:node.addr,consensusType:'SYSTEM',stateRoot:'0x0',
  extraData:{producerPublicKey:node.pub}});
blkT.sign(node.k.getPrivate('hex'));
v=bc.validateBlock(blkT,prev);
ok('transfer with amount altered after signing rejected', !v.valid, v.reason);

// properly authorized transfer
const legit=Transaction.createTransfer(alice.addr,bob.addr,1000n,0n,0);
legit.data={...legit.data,auth:{...aliceSig,timestamp:ts,amount:'1000'}};
const blkL=new Block({index:prev.index+1,timestamp:Date.now()+1,transactions:[legit],
  previousHash:prev.hash,validator:node.addr,consensusType:'SYSTEM',stateRoot:'0x0',
  extraData:{producerPublicKey:node.pub}});
blkL.sign(node.k.getPrivate('hex'));
v=bc.validateBlock(blkL,prev);
ok('correctly authorized transfer accepted', v.valid, v.reason);

console.log('\n=== CRITICAL #3: bridge counts unverified signatures ===');
const br=new EthereumBridge(bc.stateManager,bc);
const val1=key(), val2=key();
br.addValidator(val1.addr); br.addValidator(val2.addr);
bc.stateManager.updateBalance(alice.addr, 10n**23n);
const dep=await br.initiateLock(alice.addr, 5n*10n**20n, '0x'+'ab'.repeat(20));
let threw=null;
try{ br.signLock(dep.lockId, val1.addr, {publicKey:val1.pub,r:'11',s:'22'}) }catch(e){threw=e.message}
ok('garbage signature rejected', !!threw, ''); console.log('    reason:', threw);
threw=null;
// val2 signs but claims to be val1
const lockMsg=EthereumBridge.lockMessage(br.pendingDeposits.get(dep.lockId));
try{ br.signLock(dep.lockId, val1.addr, sign(val2.k, lockMsg)) }catch(e){threw=e.message}
ok('validator signing as another validator rejected', !!threw); console.log('    reason:', threw);
threw=null;
// signature over a DIFFERENT lock
try{ br.signLock(dep.lockId, val1.addr, sign(val1.k, 'some other message')) }catch(e){threw=e.message}
ok('signature over a different message rejected', !!threw);
// genuine
let good3=false;
try{ br.signLock(dep.lockId, val1.addr, sign(val1.k, lockMsg)); good3=true }catch(e){good3=false; console.log('    unexpected:',e.message)}
ok('genuine validator signature accepted', good3);

console.log('\n=== CRITICAL #4: burn accepted without proof ===');
threw=null;
try{ await br.processBurnEvent('0xdead','0xfrom',100n,alice.addr) }catch(e){threw=e.message}
ok('burn refused with no verifier configured', !!threw); console.log('    reason:', (threw||'').slice(0,90));
br.setEthereumVerifier(async()=>({valid:false,reason:'tx not found on Ethereum'}));
threw=null;
try{ await br.processBurnEvent('0xdead2','0xfrom',100n,alice.addr) }catch(e){threw=e.message}
ok('burn refused when verifier says invalid', !!threw); console.log('    reason:', (threw||'').slice(0,90));
br.setEthereumVerifier(async()=>({valid:true}));
const w=await br.processBurnEvent('0xproven','0xfrom',100n,alice.addr);
ok('burn accepted once proven', !!w.withdrawalId);
threw=null;
try{ await br.processBurnEvent('0xproven','0xfrom',100n,alice.addr) }catch(e){threw=e.message}
ok('same burn cannot be redeemed twice', !!threw); console.log('    reason:', (threw||'').slice(0,70));

console.log('\n=== GOVERNANCE: unsigned proposals and votes ===');
{
  const ActionAuth=require(require('path').join(__dirname,'../src/') + 'core/ActionAuth');
  const crypto2=require('crypto');
  const mkKey=()=>{const k=ec.genKeyPair();const pub=k.getPublic('hex');return {k,pub,addr:ActionAuth.deriveAddress(pub)}};
  const signMsg=(k,msg)=>{const h=crypto2.createHash('sha256').update(msg).digest();const sg=k.sign(h);
    return {publicKey:k.getPublic('hex'),r:sg.r.toString(16).padStart(64,'0'),s:sg.s.toString(16).padStart(64,'0')}};
  const a=mkKey(), b=mkKey(), ts=Date.now();
  const msg=JSON.stringify({address:a.addr,action:'GOVERNANCE_VOTE',proposalId:'p1',vote:'FOR',timestamp:ts});
  ok('a vote signed by the voter verifies', ActionAuth.verify(a.addr,msg,signMsg(a.k,msg)).valid);
  ok('a vote signed by someone else is rejected', !ActionAuth.verify(a.addr,msg,signMsg(b.k,msg)).valid);
  const tampered=JSON.stringify({address:a.addr,action:'GOVERNANCE_VOTE',proposalId:'p1',vote:'AGAINST',timestamp:ts});
  ok('a vote altered after signing is rejected', !ActionAuth.verify(a.addr,tampered,signMsg(a.k,msg)).valid);
}

console.log('\n=== WRITE ENDPOINTS: creator/from must be proven ===');
{
  const ActionAuth=require(require('path').join(__dirname,'../src/') + 'core/ActionAuth');
  const crypto2=require('crypto');
  const mkKey=()=>{const k=ec.genKeyPair();const pub=k.getPublic('hex');return {k,pub,addr:ActionAuth.deriveAddress(pub)}};
  const signMsg=(k,msg)=>{const h=crypto2.createHash('sha256').update(msg).digest();const sg=k.sign(h);
    return {publicKey:k.getPublic('hex'),r:sg.r.toString(16).padStart(64,'0'),s:sg.s.toString(16).padStart(64,'0')}};
  const owner=mkKey(), attacker=mkKey(), ts=Date.now();

  // Sidechain creation stakes the creator's funds and (COMMUNITY tier) goes
  // live immediately, so an unproven creator would let anyone spend someone
  // else's stake and put a chain in their name.
  const scMsg=JSON.stringify({address:owner.addr,action:'SIDECHAIN_PROPOSE',chainId:'c1',name:'C',timestamp:ts});
  ok('sidechain: owner signature verifies', ActionAuth.verify(owner.addr,scMsg,signMsg(owner.k,scMsg)).valid);
  ok('sidechain: attacker cannot sign as owner', !ActionAuth.verify(owner.addr,scMsg,signMsg(attacker.k,scMsg)).valid);
  const scTamper=JSON.stringify({address:owner.addr,action:'SIDECHAIN_PROPOSE',chainId:'other',name:'C',timestamp:ts});
  ok('sidechain: chainId cannot be swapped after signing', !ActionAuth.verify(owner.addr,scTamper,signMsg(owner.k,scMsg)).valid);

  // Token creation likewise stakes funds and issues supply in the creator's name.
  const tkMsg=JSON.stringify({address:owner.addr,action:'TOKEN_CREATE',name:'T',symbol:'T',timestamp:ts});
  ok('token: owner signature verifies', ActionAuth.verify(owner.addr,tkMsg,signMsg(owner.k,tkMsg)).valid);
  ok('token: attacker cannot sign as owner', !ActionAuth.verify(owner.addr,tkMsg,signMsg(attacker.k,tkMsg)).valid);
}

console.log(`\n${pass} passed, ${fail} failed`);
fsp.rmSync(dir,{recursive:true,force:true});
process.exit(fail?1:0);
})().catch(e=>{console.error('SUITE ERROR:',e); process.exit(1)});
