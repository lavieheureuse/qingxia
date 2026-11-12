'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createDriver } = require('./transient-driver.cjs');
const { capturePage, videoFromSnapshot } = require('./browser.cjs');

const failure = (code, message) => Object.assign(new Error(message), { code });
const terminal = new Set(['NOT_PUBLIC','NOT_VIDEO','VIDEO_MISMATCH','UNSAFE_REDIRECT','INVALID_PROFILE','PROFILE_UNAVAILABLE']);
function profileInput(input) {
  if (typeof input !== 'string' || input.length > 20000) throw failure('INVALID_PROFILE','请输入用户主页分享链接。');
  const links = input.match(/https?:\/\/[^\s<>"'`]+/gi) || [];
  if (links.length !== 1) throw failure('INVALID_PROFILE','请提供一个抖音用户主页分享链接。');
  try {
    const url = new URL(links[0].replace(/[，。！？、；：）》】」』“”‘’.,!;:)\]}]+$/u, ''));
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw 0;
    if (url.hostname === 'v.douyin.com' && /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return url.origin + url.pathname;
    if (['www.douyin.com','douyin.com','www.iesdouyin.com','iesdouyin.com','m.iesdouyin.com'].includes(url.hostname)) {
      const match = /^\/(?:share\/)?user\/([A-Za-z0-9_-]{5,200})\/?$/.exec(url.pathname);
      if (match) return `https://www.douyin.com/user/${match[1]}`;
    }
  } catch (_) { /* Invalid or untrusted profile URL. */ }
  throw failure('INVALID_PROFILE','请提供有效的抖音用户主页分享链接。');
}
function findEngine({ platform = process.platform, environment = process.env, io = fs } = {}) {
  const candidates = [];
  if (platform === 'win32') {
    for (const base of [environment.ProgramFiles, environment['ProgramFiles(x86)'], environment.LOCALAPPDATA]) {
      if (typeof base !== 'string' || !path.isAbsolute(base)) continue;
      candidates.push(path.join(base,'Google','Chrome','Application','chrome.exe'), path.join(base,'Microsoft','Edge','Application','msedge.exe'));
    }
  } else if (platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else if (platform === 'linux') {
    candidates.push('/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/microsoft-edge');
  }
  for (const candidate of [...new Set(candidates)]) { try { if (io.statSync(candidate).isFile()) return candidate; } catch {} }
  return null;
}
function publicError(error, signal) {
  if (signal && signal.aborted) return failure('CANCELLED','任务已停止，临时引擎已关闭。');
  if (error && terminal.has(error.code)) return error;
  const code = error && error.code;
  if (code === 'CLEANUP') return failure('ENGINE_CLEANUP_FAILED','未能确认临时引擎已经退出，已阻止再次启动。请退出插件并检查该插件的独立浏览器进程。');
  if (code === 'PROFILE_BUSY' || code === 'BUSY') return failure('BUSY','请先关闭本插件打开的登录窗口，或等待当前解析完全结束。');
  if (code === 'ENGINE_NOT_FOUND') return failure(code,'未找到 Chrome 或 Edge。请先安装其中一个浏览器，再重新进入插件；不会使用你的默认浏览器资料。');
  if (code === 'ENGINE_NOT_READY') return failure(code,'临时引擎未读到该作品的公开播放地址。可先打开抖音登录一次，关闭登录窗口后再试。');
  return failure('ENGINE_FAILED','临时引擎未完成读取，已执行退出清理。请重试；若仍失败，请反馈此提示。');
}
function pause(ms, signal) {
  return new Promise((resolve,reject) => {
    if (signal && signal.aborted) { reject(failure('CANCELLED','任务已停止。')); return; }
    const finish = () => { if(signal)signal.removeEventListener('abort',abort); resolve(); };
    const timer = setTimeout(finish,ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort',abort); reject(failure('CANCELLED','任务已停止。')); };
    if(signal)signal.addEventListener('abort',abort,{once:true});
  });
}
function createTransientResolver({ dataDirectory, parser, engineFinder = findEngine, driverFactory = createDriver, io = fs, now = Date.now, wait = pause, versions = process.versions } = {}) {
  if(typeof dataDirectory!=='string'||!path.isAbsolute(dataDirectory)||!parser)throw failure('ENGINE_CONFIG','临时引擎配置无效。');
  const profileRoot=path.join(dataDirectory,'transient-browser');
  const profile=path.join(profileRoot,'session');
  const driver=driverFactory({profileRoot});
  let current=null, disposed=false, lastTarget='https://www.douyin.com/';
  function available() { return Number(String(versions && versions.node || '0').split('.')[0])>=16; }
  function check(signal) { if(signal && signal.aborted)throw failure('CANCELLED','任务已停止。');if(disposed)throw failure('CLOSED','临时引擎已关闭。'); }
  function acquire(kind) { check();if(current)throw failure('BUSY','请先关闭登录窗口，或等待当前解析完全结束。');const token={kind,browser:null};current=token;return token; }
  async function launch(token, headless, signal) {
    check(signal);
    const executablePath=engineFinder();
    if(!executablePath)throw failure('ENGINE_NOT_FOUND','没有找到浏览器。');
    try { io.mkdirSync(dataDirectory,{recursive:true});if(!io.lstatSync(dataDirectory).isDirectory()||io.lstatSync(dataDirectory).isSymbolicLink())throw new Error('invalid'); }
    catch { throw failure('PROFILE','独立会话目录不可用。'); }
    check(signal);
    token.browser=await driver.launch({executablePath,userDataDir:profile,headless,startupTimeoutMs:12000,commandTimeoutMs:7000,totalTimeoutMs:headless?45000:600000,closeTimeoutMs:2000,killTimeoutMs:3000});
    check(signal);
    return token.browser;
  }
  async function finish(token) {
    // Leave the resolver blocked when exit is unconfirmed. Never reuse a live profile.
    if(token.browser)await token.browser.close();
    if(current===token)current=null;
  }
  async function resolve(input, {signal,onState}={}) {
    const parsed=parser.parseShareInput(input);
    const token=acquire('resolve');
    lastTarget=parsed.id?`https://www.douyin.com/video/${parsed.id}`:parsed.url;
    const abort=()=>{if(token.browser)void token.browser.close().catch(()=>{});};
    if(signal)signal.addEventListener('abort',abort,{once:true});
    try {
      check(signal);
      if(onState)onState({phase:'resolving',message:'正在按需启动独立引擎；本次读取结束后会完全退出…'});
      const browser=await launch(token,true,signal);
      const page=await browser.createTarget();
      check(signal);
      await page.navigate(lastTarget);
      const deadline=now()+18000;
      // The Node parser is the readiness predicate. A raw hydration marker or
      // weaker browser-side probe can never finish the task prematurely.
      const expression=`(${capturePage.toString()})('final',${JSON.stringify(parsed.id || '')})`;
      let transientErrors=0;
      while(now()<deadline) {
        check(signal);
        let snapshot;
        try { const result=await page.evaluate(expression); snapshot=result && result.value; transientErrors=0; }
        catch(error) {
          if(error && ['EVALUATION','PROTOCOL'].includes(error.code) && transientErrors++<3) { await wait(200,signal);continue; }
          throw error;
        }
        check(signal);
        if(snapshot && snapshot.href!=='about:blank') {
          const video=videoFromSnapshot(snapshot,parsed.id,parser);
          if(video) {check(signal);return video;}
        }
        await wait(250,signal);
      }
      throw failure('ENGINE_NOT_READY','页面没有提供可确认的目标公开播放数据。');
    } catch(error) { throw publicError(error,signal); }
    finally {
      if(signal)signal.removeEventListener('abort',abort);
      try { await finish(token); } catch { throw publicError({code:'CLEANUP'}); }
    }
  }
  async function profileVideos(input, start, end, {signal}={}) {
    const target=profileInput(input);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > 1000 || end-start+1 > 100) throw failure('INVALID_PROFILE','请输入有效范围：序号为 1 至 1000，单次最多 100 条。');
    const token=acquire('profile');
    const abort=()=>{if(token.browser)void token.browser.close().catch(()=>{});};
    if(signal)signal.addEventListener('abort',abort,{once:true});
    try {
      const browser=await launch(token,true,signal), page=await browser.createTarget();
      let canonical=target;
      if(target.startsWith('https://v.douyin.com/')) {
        await page.navigate(target);
        const deadline=now()+12000;
        while(now()<deadline) {
          check(signal);
          try {
            const result=await page.evaluate('location.href');
            const url=new URL(result.value);
            if(url.hostname !== 'v.douyin.com' && url.href !== 'about:blank') { canonical=profileInput(url.origin+url.pathname); break; }
          } catch(error) { if(error && error.code==='INVALID_PROFILE') throw error; }
          await wait(250,signal);
        }
        if(canonical===target) throw failure('PROFILE_UNAVAILABLE','无法识别主页链接，请稍后重试。');
      }
      const userId=canonical.split('/').pop(), ids=[], requests=new Set(), pending=new Set();
      page.on('Network.responseReceived', event=>{
        try {
          const u=new URL(event.response.url);
          if(u.protocol==='https:' && u.hostname==='www.douyin.com' && u.pathname==='/aweme/v1/web/aweme/post/' && u.searchParams.get('sec_user_id')===userId && event.response.status===200) requests.add(event.requestId);
        } catch (_) { /* Ignore unrelated responses. */ }
      });
      page.on('Network.loadingFinished', event=>{
        if(!requests.delete(event.requestId))return;
        const work=(async()=>{try {
          const response=await page.send('Network.getResponseBody',{requestId:event.requestId});
          if(response.base64Encoded || typeof response.body!=='string' || response.body.length>4*1024*1024)return;
          const data=JSON.parse(response.body);
          if(!Array.isArray(data.aweme_list))return;
          for(const item of data.aweme_list) {
            if(item && item.author && item.author.sec_uid===userId && /^\d{5,25}$/.test(String(item.aweme_id)) && !ids.includes(String(item.aweme_id))) ids.push(String(item.aweme_id));
          }
        } catch (_) { /* Missing or malformed page data is not a verified list. */ }})();
        pending.add(work); work.finally(()=>pending.delete(work));
      });
      await page.navigate(canonical);
      const deadline=now()+25000;
      let stable=0,last=0;
      while(now()<deadline && ids.length<end) {
        check(signal); await wait(1000,signal); check(signal);
        if(pending.size)await Promise.all([...pending]);
        if(ids.length===last)stable++; else {stable=0;last=ids.length;}
        if(stable>=8)break;
        try { await page.evaluate(`(()=>{if(location.origin!==${JSON.stringify('https://www.douyin.com')}||location.pathname!==${JSON.stringify('/user/'+userId)})return;window.scrollTo(0,document.documentElement.scrollHeight);for(const e of document.querySelectorAll('main,[role=main]'))e.scrollTop=e.scrollHeight;})()`); } catch (_) { /* Navigation may still be in progress. */ }
      }
      check(signal);
      if(!ids.length)throw failure('PROFILE_UNAVAILABLE','未能获取该用户的作品列表。请确认主页公开，必要时打开抖音登录并关闭窗口后重试。');
      return ids.slice(start-1,end).map(id=>`https://www.douyin.com/video/${id}`);
    } catch(error) { throw publicError(error,signal); }
    finally { if(signal)signal.removeEventListener('abort',abort); try { await finish(token); } catch { throw publicError({code:'CLEANUP'}); } }
  }
  async function openLogin() {
    const token=acquire('login');
    try {
      const browser=await launch(token,false);
      const page=await browser.createTarget();
      await page.navigate(lastTarget);
      // Explicit login is the only headed operation. Closing its window ends the
      // owned process. The bounded observer unlocks the profile after confirmed exit.
      token.done=(async()=>{try{await Promise.race([browser.waitForExit(),page.waitForClose()]);}finally{await finish(token);}})();
      token.done.catch(()=>{});
      return {opened:true,closeBeforeParse:true};
    } catch(error) {
      try { await finish(token); } catch { throw publicError({code:'CLEANUP'}); }
      throw publicError(error);
    }
  }
  function setTarget(input) {const parsed=parser.parseShareInput(input);lastTarget=parsed.id?`https://www.douyin.com/video/${parsed.id}`:parsed.url;}
  function dispose() {
    disposed=true;
    // The driver registry exists before launch's first await, including when
    // current.browser has not been returned yet. Never depend on async unload.
    const complete=driver.disposeSync();
    if(current && current.browser)void current.browser.close().catch(()=>{});
    return complete;
  }
  return Object.freeze({available,resolve,profileVideos,openLogin,setTarget,dispose});
}
module.exports={createTransientResolver,findEngine,profileInput};
