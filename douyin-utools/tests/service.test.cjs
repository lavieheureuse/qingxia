'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createService } = require('../core/service.cjs');
const { createStore } = require('../core/storage.cjs');
const ID = '7703904854934113574';
const SHORT_URL = 'https://v.douyin.com/AbCd123/';
const SHORT_SHARE = `分享视频 ${SHORT_URL} 复制链接打开抖音`;
const VIDEO = { id: ID, title: '<script>影片 / 标题</script>', author: '作者', cover: '', duration: 8, width: 720, height: 1280,
  quality: '1280p', sourceUrl: `https://www.douyin.com/video/${ID}`, watermark: null, urls: ['https://v3-web.douyinvod.com/media.mp4?token=not-for-renderer'] };
function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shiying-service-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const diskStore = createStore(path.join(directory, 'data'));
  const store = options.failHistory ? { ...diskStore, addHistory() { throw new Error('disk full'); } } : diskStore;
  const calls = [];
  const parser = { parseShareInput: text => { if (!text.includes(ID)) throw Object.assign(new Error('invalid'), { code: 'INVALID_URL' }); return { url: VIDEO.sourceUrl, id: ID }; },
    isMediaUrl: url => typeof url === 'string' && url.startsWith('https://v3-web.douyinvod.com/'), isCoverUrl: () => false,
    fetchVideo: async () => ({ ...VIDEO, urls: VIDEO.urls.slice() }), ...options.parser };
  const host = { showOpenDialog: () => [directory], shellOpenPath: async file => { calls.push(['open', file]); return ''; }, shellShowItemInFolder: file => { calls.push(['reveal', file]); }, ...options.host };
  const downloader = options.downloader || { downloadMedia: async params => {
    calls.push(['download', params]);
    params.onProgress({ received: 32, total: 64, speed: 320, percent: 50 });
    const target = path.join(directory, 'result.mp4'); fs.writeFileSync(target, Buffer.alloc(64));
    return { path: target, bytes: 64, mime: 'video/mp4' };
  } };
  const browser = { available: () => false, ...options.browser };
  const service = createService({ store, downloader, parser, browser, host: options.noHost ? null : host, clipboard: { readText: () => VIDEO.sourceUrl }, defaultDirectory: directory });
  return { service, store, calls, directory };
}
test('bootstrap supplies local settings and actual capabilities', async t => {
  const { service, directory } = setup(t);
  assert.deepEqual(await service.bootstrap(), { settings: { outputDir: directory }, history: [], capabilities: { host: true, browser: false }, version: '0.2.0' });
  assert.equal(await service.readClipboard(), VIDEO.sourceUrl);
});
test('resolve/download records a real file, only private code sees signed URLs', async t => {
  const { service, store, calls } = setup(t);
  const events = []; service.onState(e => events.push(e));
  const video = await service.resolve(VIDEO.sourceUrl);
  assert.equal(video.title, VIDEO.title);
  assert.equal('urls' in video, false);
  const result = await service.download(video.id);
  assert.equal(fs.statSync(result.path).size, 64);
  assert.deepEqual(events.map(e => e.phase), ['resolving', 'ready', 'downloading', 'downloading', 'complete']);
  assert.equal(JSON.stringify(events).includes('not-for-renderer'), false);
  assert.equal(calls[0][1].urls[0], VIDEO.urls[0]);
  assert.equal(store.listHistory()[0].path, result.path);
  assert.equal('urls' in store.listHistory()[0], false);
  await service.openFile(result.path); await service.revealFile(result.path);
  assert.deepEqual(calls.slice(1).map(c => c[0]), ['open', 'reveal']);
  await service.clearHistory();
  assert.equal(store.listHistory().length, 0);
  assert.equal(fs.existsSync(result.path), true, 'clearing records must not delete files');
});
test('failed downloads expose only public error code/message, never native causes or signed URLs', async t => {
  const nativeCause = Object.assign(new TypeError('bad request ' + VIDEO.urls[0]), { url: VIDEO.urls[0] });
  const { service, store } = setup(t, { downloader: { downloadMedia: async () => { throw Object.assign(new Error('下载运行环境异常（ERR_INVALID_ARG_TYPE）'), { code: 'HOST_RUNTIME_ERROR', cause: nativeCause, urls: VIDEO.urls }); } } });
  const events = []; service.onState(event => events.push(event));
  await service.resolve(VIDEO.sourceUrl);
  await assert.rejects(service.download(ID), error => {
    assert.equal(error.code, 'HOST_RUNTIME_ERROR');
    assert.match(error.message, /ERR_INVALID_ARG_TYPE/);
    assert.equal(error.cause, undefined);
    assert.equal(error.urls, undefined);
    assert.equal(JSON.stringify(error).includes('not-for-renderer'), false);
    return true;
  });
  assert.equal(events.at(-1).phase, 'error');
  assert.equal(JSON.stringify(events).includes('not-for-renderer'), false);
  assert.equal(store.listHistory().length, 0);
});
test('frontend cannot send arbitrary URLs, IDs, or local paths to the downloader/shell', async t => {
  const { service, calls, directory } = setup(t);
  await assert.rejects(service.download(ID), { code: 'RESOLVE_REQUIRED' });
  await service.resolve(VIDEO.sourceUrl);
  await assert.rejects(service.download('https://127.0.0.1/evil'), { code: 'RESOLVE_REQUIRED' });
  await assert.rejects(service.openFile(path.join(directory, 'secret.mp4')), { code: 'INVALID_FILE' });
  await assert.rejects(service.openFile('C:\\Windows\\System32\\cmd.exe'), { code: 'INVALID_FILE' });
  assert.equal(calls.length, 0);
});
test('wrong video id or invalid media is rejected even after a parser response', async t => {
  const wrong = setup(t, { parser: { fetchVideo: async () => ({ ...VIDEO, id: '7703904854934113575' }) } });
  await assert.rejects(wrong.service.resolve(VIDEO.sourceUrl), { code: 'VIDEO_MISMATCH' });
  const invalid = setup(t, { parser: { fetchVideo: async () => ({ ...VIDEO, urls: ['https://attacker.test/v.mp4'] }) } });
  await assert.rejects(invalid.service.resolve(VIDEO.sourceUrl), { code: 'NO_MEDIA' });
});
test('background browser success stays resolving and never opens login or downloads automatically', async t => {
  let fetches = 0, resolutions = 0, logins = 0;
  const { service, calls } = setup(t, {
    parser: { fetchVideo: async () => { fetches++; throw Object.assign(new Error('browser needed'), { code: 'BROWSER_REQUIRED' }); } },
    browser: { available: () => true, resolve: async (_, { onState }) => {
      resolutions++; onState({ phase: 'resolving', message: '正在后台读取抖音网页…' }); return VIDEO;
    }, openLogin: async () => { logins++; } }
  });
  const events = []; service.onState(e => events.push(e));
  const video = await service.resolve(VIDEO.sourceUrl);
  assert.equal(video.id, ID); assert.equal(video.urls, undefined);
  assert.equal(fetches, 1); assert.equal(resolutions, 1); assert.equal(logins, 0); assert.equal(calls.length, 0);
  assert.ok(events.some(e => /后台/.test(e.message)));
  assert.ok(events.every(e => e.phase !== 'waiting'));
  assert.equal(events.at(-1).phase, 'ready');
  assert.doesNotMatch(JSON.stringify(events), /not-for-renderer/);
});
test('short-share failure hands an exact discovered identity to the browser as a canonical URL', async t => {
  for (const id of [ID, '12345', '1234567890123456789012345', '0000012345']) {
    await t.test(id, async t => {
      const canonical = `https://www.douyin.com/video/${id}`;
      const fetched = [], browserInputs = [];
      let logins = 0, cookieExports = 0;
      const { service, calls } = setup(t, {
        parser: {
          parseShareInput: input => { assert.equal(input, SHORT_SHARE); return { url: SHORT_URL, id: null }; },
          fetchVideo: async input => {
            fetched.push(input);
            throw Object.assign(new Error('public page needs browser'), { code: 'BROWSER_REQUIRED', videoId: id });
          }
        },
        browser: {
          available: () => true,
          resolve: async input => { browserInputs.push(input); return { ...VIDEO, id }; },
          openLogin: async () => { logins++; },
          exportCookies: async () => { cookieExports++; throw new Error('cookies must remain in browser'); }
        }
      });
      const video = await service.resolve(SHORT_SHARE);
      assert.deepEqual(fetched, [SHORT_SHARE]);
      assert.deepEqual(browserInputs, [canonical]);
      assert.equal(video.id, id);
      assert.equal(video.sourceUrl, canonical);
      assert.equal(video.urls, undefined);
      assert.equal(logins, 0);
      assert.equal(cookieExports, 0);
      assert.equal(calls.length, 0, 'resolution must not download or open local files');
    });
  }
});
test('a discovered identity cannot replace an explicit input video ID', async t => {
  let resolutions = 0;
  const { service, calls } = setup(t, {
    parser: { fetchVideo: async () => {
      throw Object.assign(new Error('different video discovered'), { code: 'BROWSER_REQUIRED', videoId: '7703904854934113575' });
    } },
    browser: { available: () => true, resolve: async () => { resolutions++; return VIDEO; } }
  });
  await assert.rejects(service.resolve(VIDEO.sourceUrl), { code: 'VIDEO_MISMATCH' });
  assert.equal(resolutions, 0, 'a known conflicting ID must fail before browser fallback');
  await assert.rejects(service.download(ID), { code: 'RESOLVE_REQUIRED' });
  assert.equal(calls.length, 0);
});
test('malformed discovered IDs are ignored and never interpolated into browser URLs', async t => {
  const invalid = [
    ['URL injection', 'https://attacker.test/video/12345'],
    ['path injection', `${ID}/../../login`],
    ['query injection', `${ID}?redirect=https://attacker.test/`],
    ['leading space', ` ${ID}`],
    ['trailing newline', `${ID}\n`],
    ['too short', '1234'],
    ['too long', '12345678901234567890123456'],
    ['unsafe number', Number(ID)],
    ['coercible object', { toString: () => ID }]
  ];
  for (const [label, videoId] of invalid) {
    await t.test(label, async t => {
      const browserInputs = [];
      const { service, calls } = setup(t, {
        parser: {
          parseShareInput: input => { assert.equal(input, SHORT_SHARE); return { url: SHORT_URL, id: null }; },
          fetchVideo: async () => { throw Object.assign(new Error('browser needed'), { code: 'BROWSER_REQUIRED', videoId }); }
        },
        browser: { available: () => true, resolve: async input => { browserInputs.push(input); return VIDEO; } }
      });
      assert.equal((await service.resolve(SHORT_SHARE)).id, ID);
      // Invalid error metadata is not a trusted URL or identity; reuse the validated short URL.
      assert.deepEqual(browserInputs, [SHORT_URL]);
      assert.equal(calls.length, 0);
    });
  }
});
test('browser results must match the identity discovered while resolving a short share', async t => {
  const browserInputs = [];
  const { service, calls } = setup(t, {
    parser: {
      parseShareInput: () => ({ url: SHORT_URL, id: null }),
      fetchVideo: async () => { throw Object.assign(new Error('browser needed'), { code: 'BROWSER_REQUIRED', videoId: ID }); }
    },
    browser: { available: () => true, resolve: async input => {
      browserInputs.push(input); return { ...VIDEO, id: '7703904854934113575' };
    } }
  });
  await assert.rejects(service.resolve(SHORT_SHARE), { code: 'VIDEO_MISMATCH' });
  assert.deepEqual(browserInputs, [VIDEO.sourceUrl]);
  await assert.rejects(service.download('7703904854934113575'), { code: 'RESOLVE_REQUIRED' });
  assert.equal(calls.length, 0);
});
test('manual login retains the discovered canonical target after browser failure without re-parsing or downloading', async t => {
  let parses = 0, fetches = 0, resolutions = 0, logins = 0, cookieExports = 0;
  const targets = [];
  const { service, calls } = setup(t, {
    parser: {
      parseShareInput: input => { parses++; assert.equal(input, SHORT_SHARE); return { url: SHORT_URL, id: null }; },
      fetchVideo: async () => { fetches++; throw Object.assign(new Error('browser needed'), { code: 'BROWSER_REQUIRED', videoId: ID }); }
    },
    browser: {
      available: () => true,
      resolve: async input => {
        resolutions++; assert.equal(input, VIDEO.sourceUrl);
        throw Object.assign(new Error('manual verification required'), { code: 'LOGIN_REQUIRED' });
      },
      setTarget: url => { targets.push(url); },
      openLogin: async () => { logins++; return { opened: true }; },
      exportCookies: async () => { cookieExports++; throw new Error('cookies must remain in browser'); }
    }
  });
  await assert.rejects(service.resolve(SHORT_SHARE), { code: 'LOGIN_REQUIRED' });
  assert.equal(logins, 0, 'resolution must not automatically open the manual login window');
  targets.length = 0;
  assert.deepEqual(await service.openLogin(), { opened: true });
  assert.deepEqual(targets, [VIDEO.sourceUrl]);
  assert.equal(parses, 1, 'manual login must not parse the original share again');
  assert.equal(fetches, 1);
  assert.equal(resolutions, 1);
  assert.equal(logins, 1);
  assert.equal(cookieExports, 0);
  assert.equal(calls.length, 0);
});
test('HTTP-first short-share success establishes the canonical manual-login target without browser fallback', async t => {
  let parses = 0, fetches = 0, resolutions = 0, logins = 0;
  const targets = [];
  const { service, calls } = setup(t, {
    parser: {
      parseShareInput: input => { parses++; assert.equal(input, SHORT_SHARE); return { url: SHORT_URL, id: null }; },
      fetchVideo: async () => { fetches++; return VIDEO; }
    },
    browser: {
      available: () => true,
      resolve: async () => { resolutions++; throw new Error('HTTP-first success must not use browser fallback'); },
      setTarget: url => { targets.push(url); },
      openLogin: async () => { logins++; }
    }
  });
  assert.equal((await service.resolve(SHORT_SHARE)).id, ID);
  assert.equal(resolutions, 0);
  assert.equal(logins, 0);
  targets.length = 0;
  await service.openLogin();
  assert.deepEqual(targets, [VIDEO.sourceUrl]);
  assert.equal(parses, 1);
  assert.equal(fetches, 1);
  assert.equal(resolutions, 0);
  assert.equal(logins, 1);
  assert.equal(calls.length, 0);
});
test('terminal parser errors stay terminal even when they contain discovered identity metadata', async t => {
  for (const code of ['CANCELLED', 'INVALID_URL', 'INVALID_INPUT', 'NOT_VIDEO', 'NOT_PUBLIC', 'VIDEO_MISMATCH', 'UNSAFE_REDIRECT']) {
    await t.test(code, async t => {
      let resolutions = 0, logins = 0;
      const { service, calls } = setup(t, {
        parser: {
          parseShareInput: () => ({ url: SHORT_URL, id: null }),
          fetchVideo: async () => { throw Object.assign(new Error('terminal parser failure'), { code, videoId: ID }); }
        },
        browser: {
          available: () => true,
          resolve: async () => { resolutions++; return VIDEO; },
          openLogin: async () => { logins++; }
        }
      });
      await assert.rejects(service.resolve(SHORT_SHARE), { code });
      assert.equal(resolutions, 0);
      assert.equal(logins, 0);
      assert.equal(calls.length, 0);
    });
  }
});
test('public page limitation invokes browser resolution, invalid URL/album does not', async t => {
  let opened = 0;
  const { service } = setup(t, { parser: { fetchVideo: async () => { throw Object.assign(new Error('verify'), { code: 'BROWSER_REQUIRED' }); } },
    browser: { available: () => true, resolve: async (_, { onState }) => { opened++; onState({ phase: 'waiting', message: 'visible' }); return VIDEO; } } });
  assert.equal((await service.resolve(VIDEO.sourceUrl)).id, ID);
  assert.equal(opened, 1);
  await assert.rejects(service.resolve('https://attacker.test'), { code: 'INVALID_URL' });
  assert.equal(opened, 1);
  const album = setup(t, { parser: { fetchVideo: async () => { throw Object.assign(new Error('album'), { code: 'NOT_VIDEO' }); } }, browser: { available: () => true, resolve: async () => { throw new Error('must not open'); } } });
  await assert.rejects(album.service.resolve(VIDEO.sourceUrl), { code: 'NOT_VIDEO' });
});
test('cancellation releases the single task lock and returns a cancelled state', async t => {
  let started;
  const start = new Promise(resolve => { started = resolve; });
  const { service } = setup(t, { parser: { fetchVideo: (_, { signal }) => new Promise((_, reject) => {
    started(); signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  }) } });
  const work = service.resolve(VIDEO.sourceUrl); const rejected = assert.rejects(work, { code: 'CANCELLED' });
  await start;
  await assert.rejects(service.resolve(VIDEO.sourceUrl), { code: 'BUSY' });
  await assert.rejects(service.chooseDirectory(), { code: 'BUSY' });
  await assert.rejects(service.openLogin(), { code: 'BUSY' });
  assert.equal((await service.cancel()).phase, 'cancelled');
  await rejected;
});
test('cancel after a committed download retains complete instead of falsely stopped', async t => {
  const { service } = setup(t);
  await service.resolve(VIDEO.sourceUrl); await service.download(ID);
  const last = await service.cancel();
  assert.equal(last.phase, 'complete'); assert.equal(last.result.bytes, 64);
});
test('directory selector cancellation does not overwrite settings', async t => {
  const { service, directory } = setup(t, { host: { showOpenDialog: () => undefined } });
  assert.equal(await service.chooseDirectory(), null);
  assert.equal((await service.bootstrap()).settings.outputDir, directory);
});
test('store warning does not hide a successfully saved file', async t => {
  const { service } = setup(t, { failHistory: true });
  await service.resolve(VIDEO.sourceUrl);
  const result = await service.download(ID);
  assert.match(result.warning, /文件已保存/);
  assert.equal(fs.existsSync(result.path), true);
});
test('one faulty listener cannot interrupt a task, and unsubscribe works', async t => {
  const { service } = setup(t); let n = 0;
  service.onState(() => { throw new Error('view bug'); });
  const unsubscribe = service.onState(() => { n++; });
  unsubscribe(); await service.resolve(VIDEO.sourceUrl); assert.equal(n, 0);
});
test('operations require the actual host', async t => {
  const { service } = setup(t, { noHost: true });
  await assert.rejects(service.bootstrap(), { code: 'HOST_REQUIRED' });
  await assert.rejects(service.resolve(VIDEO.sourceUrl), { code: 'HOST_REQUIRED' });
});
