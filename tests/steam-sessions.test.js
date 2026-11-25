'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {createSteamSessions} = require('../server/steam/clients');
const A='76561198000000001', B='76561198000000002', C='76561198000000003';
const sid=id=>({getSteamID64:()=>id});
const wait=()=>new Promise(resolve=>setImmediate(resolve));
class FakeClient extends EventEmitter {
  static instances=[];
  constructor(options){super();this.options=options;this.games=[];FakeClient.instances.push(this);}
  logOn({refreshToken}){this.steamID=sid(refreshToken);queueMicrotask(()=>this.emit('loggedOn'));}
  setPersona(){}
  gamesPlayed(games){this.games=games;}
  logOff(){this.steamID=null;}
}
class FakeAuth extends EventEmitter {
  static instances=[];
  constructor(){super();FakeAuth.instances.push(this);}
  async startWithQR(){return {qrChallengeUrl:'https://s.team/q/1/12345',validActions:[]};}
  async startWithCredentials({accountName}){this.steamID=sid(accountName);return {validActions:[]};}
  cancelLoginAttempt(){}
  approve(id){this.steamID=sid(id);this.refreshToken=id;this.emit('authenticated');}
}
function setup(t){
  FakeClient.instances=[];FakeAuth.instances=[];
  const saved=new Map();
  const manager=createSteamSessions({Client:FakeClient,AuthSession:FakeAuth,tokens:{async save(id,userId,token){saved.set(id,token);},async all(){return [];}}});
  t.after(()=>manager.close());return {manager,saved};
}
test('tres cuentas distintas no comparten cliente ni actividad; reconexión nativa',async t=>{
  const {manager,saved}=setup(t);
  for(const id of [A,B,C]){
    const auth=await manager.login(id,'owner',id,'password',async()=>{});
    FakeAuth.instances.at(-1).approve(id);
    await wait();await wait();
    assert.equal(manager.loginStatus(id,auth.loginId).status,'connected');
    manager.launch(id,730);
  }
  assert.equal(FakeClient.instances.length,3);
  assert.equal(manager.playingEntries().length,3);
  assert.equal(saved.size,3);
  assert.ok(FakeClient.instances.every(client=>client.options.autoRelogin));
  FakeClient.instances[0].emit('disconnected',0);
  assert.equal(manager.isConnected(A),false);
  assert.equal(manager.playingEntries().length,2);
  FakeClient.instances[0].emit('loggedOn');
  assert.equal(manager.playingEntries().length,3);
  manager.stop(B);
  assert.deepEqual(FakeClient.instances[0].games,[730]);
  assert.deepEqual(FakeClient.instances[1].games,[]);
  assert.deepEqual(FakeClient.instances[2].games,[730]);
});
test('QR autoriza solo la identidad seleccionada y no requiere contraseña',async t=>{
  const {manager,saved}=setup(t);
  const auth=await manager.login(A,'owner','','',async()=>{},'qr');
  assert.equal(auth.status,'waiting');
  assert.ok(auth.qr.length>=21);
  assert.equal(auth.codeAllowed,false);
  FakeAuth.instances.at(-1).approve(B);
  await wait();
  assert.equal(manager.loginStatus(A,auth.loginId).status,'error');
  assert.equal(saved.size,0);
  assert.equal(FakeClient.instances.length,0);
  const second=await manager.login(A,'owner','','',async()=>{},'qr');
  FakeAuth.instances.at(-1).approve(A);
  await wait();await wait();
  assert.equal(manager.loginStatus(A,second.loginId).status,'connected');
  assert.equal(saved.get(A),A);
});
