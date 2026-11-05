'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { capturePage, videoFromSnapshot } = require('../core/browser.cjs');
const parser = require('../core/parse.cjs');

const ID = '7702774431202267850';
const OTHER_ID = '7652553551402503466';
const PAGE = `https://www.douyin.com/video/${ID}`;
const MEDIA = 'https://v3-web.douyinvod.com/schema.mp4?signature=unchanged%2B%2F&expires=123';
const OTHER_MEDIA = 'https://v6-web.douyinvod.com/alternate.mp4?signature=kept';
const item = video => ({ aweme_id: ID, desc: 'schema fixture', authorInfo: { nickname: 'public author' },
  video: { duration: 32734, width: 1080, height: 1920, ...video } });
function script(textContent, id = '', type = '') { return { id, type, textContent }; }
function fixture({ record, component = false, scripts = [], href = PAGE } = {}) {
  const native = { src: '', currentSrc: `blob:https://www.douyin.com/${ID}`, poster: '',
    videoWidth: 1080, videoHeight: 1920, duration: 32.734,
    getBoundingClientRect: () => ({ width: 400, height: 500, left: 0, top: 0, right: 400, bottom: 500 }),
    querySelectorAll: () => [], parentElement: null };
  if (record && component) native.parentElement = { '__reactFiber$fixture': { memoizedProps: { awemeInfo: record } }, parentElement: null };
  const state = record && !component ? { __INITIAL_STATE__: { publicDetail: record, unrelated: 'DO_NOT_EXPORT_ACCOUNT_STATE' } } : {};
  const context = vm.createContext({ URL, location: new URL(href), innerWidth: 1060, innerHeight: 760, window: state,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    document: { scripts, readyState: 'complete', visibilityState: 'hidden', title: 'fixture', body: { innerText: '' },
      querySelector: () => null, querySelectorAll: () => component ? [native] : [] } });
  return {
    ready: () => vm.runInContext(`(${capturePage})('ready', '${ID}')`, context),
    capture: () => JSON.parse(JSON.stringify(vm.runInContext(`(${capturePage})('final', '${ID}')`, context)))
  };
}
function parsed(f) { return videoFromSnapshot(f.capture(), ID, parser); }
function assertVideo(video) {
  assert.ok(video, 'readiness must survive public-field projection and the final parser');
  assert.equal(video.id, ID);
  assert.equal(video.duration, 32.734);
  assert.equal(video.width, 1080);
  assert.equal(video.height, 1920);
  assert.ok(video.urls.includes(MEDIA), 'signed original media URL is preserved');
}

const schemas = [
  ['main_url address', { play_addr: { main_url: MEDIA } }],
  ['mainUrl address', { play_addr: { mainUrl: MEDIA } }],
  ['url_list src records', { play_addr: { url_list: [{ src: MEDIA }] } }],
  ['urlList url records', { playAddr: { urlList: [{ url: MEDIA }] } }],
  ['urls mainUrl records', { play_addr: { urls: [{ mainUrl: MEDIA }] } }],
  ['direct main_url records', { playAddr: [{ main_url: MEDIA }] }]
];
for (const list of ['bit_rate', 'bitRateList']) for (const field of [
  'play_addr', 'playAddr', 'play_addr_h264', 'play_addr_265', 'playAddrH264', 'playAddrH265', 'download_addr', 'downloadAddr'
]) schemas.push([`${list}.${field}`, { [list]: [{ bit_rate: 800000, width: 1080, height: 1920, [field]: { url_list: [{ src: MEDIA }] } }] }]);
for (const [name, video] of schemas) test(`ready/final contract preserves ${name} in bounded public projections`, () => {
  for (const component of [false, true]) {
    const f = fixture({ record: item(video), component });
    assert.equal(f.ready(), true, `${component ? 'component' : 'hydration'} readiness`);
    assertVideo(parsed(f));
    assert.doesNotMatch(JSON.stringify(f.capture()), /DO_NOT_EXPORT_ACCOUNT_STATE/);
  }
});

test('every explicitly supported bitrate address is parsed, not just the first present field', () => {
  const record = item({ bit_rate: [{ bit_rate: 900000, play_addr: { url_list: ['https://example.org/not-official.mp4'] },
    play_addr_h264: { main_url: MEDIA }, download_addr: { url_list: [OTHER_MEDIA] } }] });
  const video = parser.parseVideoData(record, { id: ID, sourceUrl: PAGE });
  assertVideo(video);
  assert.deepEqual(video.urls, [MEDIA, OTHER_MEDIA]);
});

for (const id of ['', '__INITIAL_STATE__']) test(`explicit INITIAL_STATE assignment is data, not JS (${id || 'no script id'})`, () => {
  const record = item({ play_addr: { url_list: [MEDIA] } });
  const assignment = `window.__INITIAL_STATE__ = ${JSON.stringify({ detail: record })};`;
  const f = fixture({ scripts: [script(assignment, id)] });
  assert.equal(f.ready(), true);
  assertVideo(parsed(f));
  assertVideo(parser.parseVideoData(`<script>${assignment}</script>`, { id: ID, sourceUrl: PAGE }));
});

test('assignment parsing never executes expressions or functions', () => {
  delete globalThis.__schemaExecution;
  const raw = `<script>window.__INITIAL_STATE__ = (globalThis.__schemaExecution = true, ${JSON.stringify(item({ play_addr: MEDIA }))});</script>`;
  assert.equal(parser.parseVideoData(raw, { id: ID }), null);
  assert.equal(globalThis.__schemaExecution, undefined);
});

test('new address fields keep exact-ID, public/type and official-media gates', () => {
  for (const component of [false, true]) {
    const mismatch = fixture({ record: { ...item({ play_addr: { mainUrl: MEDIA } }), aweme_id: OTHER_ID }, component });
    assert.equal(parsed(mismatch), null);
    const unsafe = fixture({ record: item({ play_addr: { main_url: 'https://example.org/video.mp4' } }), component });
    assert.equal(unsafe.ready(), false);
    assert.equal(parsed(unsafe), null);
    for (const [flag, code] of [[{ isPrivate: true }, 'NOT_PUBLIC'], [{ status: { is_private: 1 } }, 'NOT_PUBLIC'],
      [{ aweme_type: 68 }, 'NOT_VIDEO'], [{ aweme_type: 101 }, 'NOT_VIDEO']]) {
      const f = fixture({ record: { ...item({ play_addr: { mainUrl: MEDIA } }), ...flag }, component });
      assert.throws(() => parsed(f), error => error.code === code);
    }
  }
});

test('address arrays and bitrate records use only own data without invoking getters', () => {
  let reads = 0;
  const urls = [];
  Object.defineProperty(urls, '0', { enumerable: true, get() { reads++; throw Error('address index getter ran'); } });
  urls[1] = { src: MEDIA };
  const list = [];
  Object.defineProperty(list, '0', { enumerable: true, get() { reads++; throw Error('bitrate index getter ran'); } });
  list[1] = { bit_rate: 1, download_addr: { url_list: urls } };
  const record = item({ bit_rate: list });
  assertVideo(parser.parseVideoData(record, { id: ID }));
  for (const component of [false, true]) {
    const f = fixture({ record, component });
    assert.equal(f.ready(), true);
    assertVideo(parsed(f));
  }
  assert.equal(reads, 0);
});
