'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {setImmediate:nextTurn}=require('node:timers/promises');
const parser=require('../core/parse.cjs');
const {createTransientResolver,findEngine}=require('../core/transient.cjs');
const ID='7702774431202267850';
const OTHER='7702774431202267851';
const media='https://v.example.douyinvod.com/test.mp4';
function snapshot(id=ID) {return {kind:'shiying-page',href:`https://www.douyin.com/video/${id}`,html:'',media:[],publicVideo:{aweme_id:id,aweme_type:0,desc:'public fixture',video:{play_addr:{url_list:[media]},duration:32734,width:1080,height:1920}}};}
function fixture(options={}) {
  const records={launches:[],close:0,terminated:0,driverDisposals:0,evaluations:0,navigations:[]};
  let clock=0,exit;
  const ended=new Promise(resolve=>{exit=resolve;});
  const resolver=createTransientResolver({dataDirectory:path.resolve(__dirname,'virtual-owned-data'),parser,
    versions:options.versions,
    engineFinder:()=> options.noEngine?null:path.resolve(__dirname,'installed-browser.exe'),
    io:{mkdirSync(){},lstatSync(){return {isDirectory:()=>true,isSymbolicLink:()=>false};}},
    now:()=>clock,wait:async(ms,signal)=>{clock+=1000;if(options.wait)return options.wait(ms,signal);},
    driverFactory:({profileRoot})=>{
      let disposed=false;const owned=new Set();
      return {
        disposeSync(){records.driverDisposals++;disposed=true;for(const browser of [...owned])browser.terminateSync();return !options.incompleteSync;},
        async launch(config){
          if(disposed)throw Object.assign(new Error('closed'),{code:'CLOSED'});
          records.launches.push({...config,profileRoot});let closed;
          const browser={
            close(){if(!closed){records.close++;closed=(options.close?options.close():Promise.resolve()).then(()=>{owned.delete(browser);});}return closed;},
            terminateSync(){records.terminated++;if(!options.incompleteSync)owned.delete(browser);},waitForExit(){return ended;},
            async createTarget(){return {navigate:async url=>{records.navigations.push(url);},evaluate:async()=>{
              records.evaluations++;if(options.evaluate)return options.evaluate(records.evaluations);
              return {value:options.snapshots?options.snapshots[Math.min(records.evaluations-1,options.snapshots.length-1)]:snapshot()};
            }};}
          };
          owned.add(browser);
          if(options.launch)await options.launch();
          if(disposed){await browser.close();throw Object.assign(new Error('closed'),{code:'CLOSED'});}
          return browser;
        }
      };
    }});
  return {resolver,records,exit};
}
test('fresh transient resolution validates exact official media and closes before returning',async()=>{
  const {resolver,records}=fixture();const result=await resolver.resolve(`https://www.douyin.com/video/${ID}`);
  assert.equal(result.id,ID);assert.ok(result.urls.every(parser.isMediaUrl));assert.equal(records.close,1);
  assert.equal(records.launches[0].headless,true);assert.equal(records.launches[0].totalTimeoutMs,45000);
  assert.equal(path.dirname(records.launches[0].userDataDir),records.launches[0].profileRoot);
});
test('weak hydration/empty capture cannot stop before exact parsed media exists',async()=>{
  const empty={...snapshot(),publicVideo:null,diagnostics:{hydration:true,stop:'ready'}};
  const {resolver,records}=fixture({snapshots:[empty,empty,snapshot()]});
  assert.equal((await resolver.resolve(`https://www.douyin.com/video/${ID}`)).id,ID);assert.equal(records.evaluations,3);assert.equal(records.close,1);
});
test('completion remains pending until confirmed browser teardown settles',async()=>{
  let release;const close=new Promise(resolve=>{release=resolve;});const {resolver,records}=fixture({close:()=>close});let done=false;
  const result=resolver.resolve(`https://www.douyin.com/video/${ID}`).then(x=>{done=true;return x;});
  await nextTurn();assert.equal(records.close,1);assert.equal(done,false);release();await result;assert.equal(done,true);
});
test('repeated operations launch independently and do not reuse cached video output',async()=>{
  const {resolver,records}=fixture({snapshots:[snapshot(ID),snapshot(OTHER)]});
  assert.equal((await resolver.resolve(`https://www.douyin.com/video/${ID}`)).id,ID);
  assert.equal((await resolver.resolve(`https://www.douyin.com/video/${OTHER}`)).id,OTHER);
  assert.equal(records.launches.length,2);assert.equal(records.close,2);
});
test('mismatched recommendation fails terminally and still exits',async()=>{
  const {resolver,records}=fixture({snapshots:[snapshot(OTHER)]});await assert.rejects(resolver.resolve(`https://www.douyin.com/video/${ID}`),{code:'VIDEO_MISMATCH'});assert.equal(records.close,1);
});
test('unsafe redirect is not accepted or retried',async()=>{
  const {resolver,records}=fixture({snapshots:[{...snapshot(),href:'https://evil.example/video/'+ID}]});
  await assert.rejects(resolver.resolve(`https://www.douyin.com/video/${ID}`),{code:'UNSAFE_REDIRECT'});assert.equal(records.evaluations,1);assert.equal(records.close,1);
});
test('private target gates survive temporary engine integration',async()=>{
  const restricted=snapshot();restricted.publicVideo.isPrivate=true;const {resolver,records}=fixture({snapshots:[restricted]});
  await assert.rejects(resolver.resolve(`https://www.douyin.com/video/${ID}`),{code:'NOT_PUBLIC'});assert.equal(records.close,1);
});
test('bounded unusable page ends with safe error and confirmed exit',async()=>{
  const {resolver,records}=fixture({snapshots:[{...snapshot(),publicVideo:null}]});
  await assert.rejects(resolver.resolve(`https://www.douyin.com/video/${ID}`),{code:'ENGINE_NOT_READY'});assert.ok(records.evaluations<=19);assert.equal(records.close,1);
});
test('pre-aborted work never starts an engine',async()=>{
  const {resolver,records}=fixture();const controller=new AbortController();controller.abort();
  await assert.rejects(resolver.resolve(`https://www.douyin.com/video/${ID}`,{signal:controller.signal}),{code:'CANCELLED'});assert.equal(records.launches.length,0);
});
test('abort during evaluation closes engine and ignores late matching data',async()=>{
  let release;const evaluated=new Promise(resolve=>{release=resolve;});const {resolver,records}=fixture({evaluate:()=>evaluated});const controller=new AbortController();
  const task=resolver.resolve(`https://www.douyin.com/video/${ID}`,{signal:controller.signal});await nextTurn();controller.abort();release({value:snapshot()});
  await assert.rejects(task,{code:'CANCELLED'});assert.equal(records.close,1);
});
test('unconfirmed teardown rejects success and blocks another operation',async()=>{
  const secret='signed-cookie-native-secret';const {resolver,records}=fixture({close:()=>Promise.reject(new Error(secret))});
  await assert.rejects(resolver.resolve(`https://www.douyin.com/video/${ID}`),error=>error.code==='ENGINE_CLEANUP_FAILED'&&!error.message.includes(secret));
  await assert.rejects(resolver.resolve(`https://www.douyin.com/video/${ID}`),{code:'BUSY'});assert.equal(records.launches.length,1);
});
test('explicit login is headed, blocks parsing only while window lives, then permits fresh headless operation',async()=>{
  const {resolver,records,exit}=fixture();const opened=await resolver.openLogin();assert.equal(opened.closeBeforeParse,true);assert.equal(records.launches[0].headless,false);
  await assert.rejects(resolver.resolve(`https://www.douyin.com/video/${ID}`),{code:'BUSY'});exit();await nextTurn();
  assert.equal((await resolver.resolve(`https://www.douyin.com/video/${ID}`)).id,ID);assert.equal(records.launches[1].headless,true);assert.equal(records.close,2);
});
test('missing engine has explicit installation instruction, no raw errors',async()=>{
  const {resolver,records}=fixture({noEngine:true});await assert.rejects(resolver.resolve(`https://www.douyin.com/video/${ID}`),{code:'ENGINE_NOT_FOUND'});assert.equal(records.launches.length,0);
});
test('normal plugin disposal requests only the owned driver registry synchronous termination',async()=>{
  const {resolver,records}=fixture();await resolver.openLogin();assert.equal(resolver.dispose(),true);
  assert.equal(records.driverDisposals,1);assert.equal(records.terminated,1);assert.equal(records.close,1);
});
test('disposal is terminal even before a browser is requested',async()=>{
  const {resolver,records}=fixture();assert.equal(resolver.dispose(),true);assert.equal(records.driverDisposals,1);
  await assert.rejects(resolver.resolve(`https://www.douyin.com/video/${ID}`),{code:'CLOSED'});
  await assert.rejects(resolver.openLogin(),{code:'CLOSED'});assert.equal(records.launches.length,0);assert.equal(records.terminated,0);
});
test('disposal reaches driver startup while token.browser is still null, even with concurrent abort',async()=>{
  let release;const held=new Promise(resolve=>{release=resolve;});
  const {resolver,records}=fixture({launch:()=>held});const controller=new AbortController();
  const task=resolver.resolve(`https://www.douyin.com/video/${ID}`,{signal:controller.signal});
  assert.equal(records.launches.length,1);assert.equal(resolver.dispose(),true);controller.abort();
  assert.equal(records.driverDisposals,1);assert.equal(records.terminated,1);assert.equal(records.close,0);
  release();await assert.rejects(task,{code:'CANCELLED'});assert.equal(records.close,1);assert.equal(records.navigations.length,0);
  await assert.rejects(resolver.openLogin(),{code:'CLOSED'});
});
test('login exit, disposal and asynchronous finish share one idempotent close',async()=>{
  const {resolver,records,exit}=fixture();await resolver.openLogin();exit();assert.equal(resolver.dispose(),true);
  await nextTurn();assert.equal(records.driverDisposals,1);assert.equal(records.terminated,1);assert.equal(records.close,1);
  await assert.rejects(resolver.openLogin(),{code:'CLOSED'});
});
test('unconfirmed synchronous disposal reports false instead of promising profile reuse',async()=>{
  const {resolver,records,exit}=fixture({incompleteSync:true,close:()=>Promise.reject(new Error('private-native-detail'))});
  await resolver.openLogin();assert.equal(resolver.dispose(),false);exit();await nextTurn();
  assert.equal(records.driverDisposals,1);assert.equal(records.terminated,1);assert.equal(records.close,1);
  await assert.rejects(resolver.openLogin(),{code:'CLOSED'});
});
test('late evaluation cannot succeed after terminal disposal',async()=>{
  let release;const held=new Promise(resolve=>{release=resolve;});const {resolver,records}=fixture({evaluate:()=>held});
  const task=resolver.resolve(`https://www.douyin.com/video/${ID}`);await nextTurn();assert.equal(resolver.dispose(),true);
  release({value:snapshot()});await assert.rejects(task,{code:'ENGINE_FAILED'});assert.equal(records.close,1);assert.equal(records.terminated,1);
});
test('invalid share is rejected before launch or filesystem writes',async()=>{
  const {resolver,records}=fixture();await assert.rejects(resolver.resolve('https://evil.example/'+ID));assert.equal(records.launches.length,0);
});
test('engine discovery checks only known installed executable locations',()=>{
  const checked=[];const executable=path.join(path.resolve('ProgramFiles'),'Google','Chrome','Application','chrome.exe');
  const engine=findEngine({platform:'win32',environment:{ProgramFiles:path.resolve('ProgramFiles')},io:{statSync(candidate){checked.push(candidate);return {isFile:()=>candidate===executable};}}});
  assert.equal(engine,executable);assert.equal(checked.length,1);assert.ok(!checked.some(p=>p.includes('User Data')));
});
test('host runtime gate accepts the embedded Node 16 of uTools 7.8',async()=>{
  // uTools 7.8.0 ships Electron 22.3.27 / Node 16.17.1; 0.2.0 must not demand Node 18.
  const {resolver}=fixture({versions:{node:'16.17.1'}});
  assert.equal(resolver.available(),true);
  assert.equal((await resolver.resolve(`https://www.douyin.com/video/${ID}`)).id,ID);
});
test('runtime gate still refuses runtimes older than Node 16',()=>{
  assert.equal(fixture({versions:{node:'15.14.0'}}).resolver.available(),false);
  assert.equal(fixture({versions:{node:'14.21.3'}}).resolver.available(),false);
  assert.equal(fixture({versions:{node:'18.19.1'}}).resolver.available(),true);
  assert.equal(fixture({versions:{node:'24.4.1'}}).resolver.available(),true);
});
