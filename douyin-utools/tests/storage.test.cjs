'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../core/storage.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-store-test-'));
  const directory = path.join(root, 'nested', 'data');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, directory, store: createStore(directory) };
}
function history(overrides = {}) {
  return {
    id: 'video-1', title: '测试视频', author: '作者', path: path.join(os.tmpdir(), 'video.mp4'),
    bytes: 12345, createdAt: '2026-01-01T12:00:00.000Z', sourceUrl: 'https://www.douyin.com/video/123',
    ...overrides,
  };
}

test('new store has exact defaults without creating files merely to read', t => {
  const f = fixture(t);
  assert.deepEqual(f.store.getSettings(), { outputDir: '' });
  assert.deepEqual(f.store.listHistory(), []);
  assert.equal(fs.existsSync(f.directory), false);
});

test('settings persist across instances and only outputDir is stored', t => {
  const f = fixture(t);
  const outputDir = path.join(f.root, '中文 videos');
  assert.deepEqual(f.store.saveSettings({ outputDir, cookie: 'DO_NOT_PERSIST', headers: { cookie: 'secret' }, token: 'secret' }), { outputDir });
  const reopened = createStore(f.directory);
  assert.deepEqual(reopened.getSettings(), { outputDir });
  const contents = fs.readFileSync(path.join(f.directory, 'settings.json'), 'utf8');
  assert.deepEqual(JSON.parse(contents), { outputDir });
  assert.equal(contents.includes('DO_NOT_PERSIST'), false);
  assert.deepEqual(reopened.saveSettings({ unexpected: 'ignore' }), { outputDir });
  assert.deepEqual(reopened.saveSettings({ outputDir: '' }), { outputDir: '' });
  assert.deepEqual(fs.readdirSync(f.directory), ['settings.json']);
});

test('history uses flat agreed UI fields and drops all credential/unknown fields', t => {
  const f = fixture(t);
  const input = history({ cover: 'https://p3.douyinpic.com/image.jpg', cookie: 'DO_NOT_PERSIST',
    cookies: ['secret'], headers: { Authorization: 'secret' }, accessToken: 'secret', videoUrl: 'secret' });
  const entry = f.store.addHistory(input);
  assert.deepEqual(Object.keys(entry), ['id', 'title', 'author', 'path', 'bytes', 'createdAt', 'sourceUrl', 'cover']);
  assert.deepEqual(entry, history({ cover: input.cover }));
  assert.deepEqual(createStore(f.directory).listHistory(), [entry]);
  const contents = fs.readFileSync(path.join(f.directory, 'history.json'), 'utf8');
  assert.equal(contents.includes('DO_NOT_PERSIST'), false);
  assert.equal(contents.includes('Authorization'), false);
  assert.equal(contents.includes('accessToken'), false);
  assert.equal(contents.includes('videoUrl'), false);
});

test('addHistory fills id/time/default strings and listHistory is newest first', t => {
  const f = fixture(t);
  const entry = f.store.addHistory({ path: path.join(f.root, 'new.mp4') });
  assert.match(entry.id, /^[0-9a-f-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(entry.createdAt)));
  assert.equal(entry.title, '');
  assert.equal(entry.author, '');
  assert.equal(entry.bytes, 0);
  assert.equal(entry.sourceUrl, '');
  f.store.addHistory(history({ id: 'old', createdAt: '2020-01-01T00:00:00Z' }));
  f.store.addHistory(history({ id: 'middle', createdAt: '2021-01-01T00:00:00Z' }));
  assert.deepEqual(f.store.listHistory().map(item => item.id), [entry.id, 'middle', 'old']);
});

test('same id updates the record without duplicates and returned values are isolated', t => {
  const f = fixture(t);
  const entry = f.store.addHistory(history());
  entry.title = 'mutated caller';
  assert.equal(f.store.listHistory()[0].title, '测试视频');
  const listed = f.store.listHistory(); listed[0].author = 'mutated list';
  assert.equal(f.store.listHistory()[0].author, '作者');
  f.store.addHistory(history({ title: '更新后' }));
  assert.equal(f.store.listHistory().length, 1);
  assert.equal(f.store.listHistory()[0].title, '更新后');
  const settings = f.store.getSettings(); settings.outputDir = 'mutated';
  assert.deepEqual(f.store.getSettings(), { outputDir: '' });
});

test('removeHistory and clearHistory only delete metadata, never downloaded files', t => {
  const f = fixture(t);
  const mediaPath = path.join(f.root, 'do-not-delete.mp4');
  fs.writeFileSync(mediaPath, 'video bytes');
  f.store.addHistory(history({ id: 'one', path: mediaPath }));
  f.store.addHistory(history({ id: 'two', path: mediaPath }));
  assert.deepEqual(f.store.removeHistory('one').map(item => item.id), ['two']);
  assert.deepEqual(f.store.removeHistory('missing').map(item => item.id), ['two']);
  assert.deepEqual(f.store.clearHistory(), []);
  assert.deepEqual(createStore(f.directory).listHistory(), []);
  assert.equal(fs.readFileSync(mediaPath, 'utf8'), 'video bytes');
});

test('multiple store instances re-read state instead of overwriting a stale cache', t => {
  const f = fixture(t);
  const second = createStore(f.directory);
  f.store.addHistory(history({ id: 'first' }));
  second.addHistory(history({ id: 'second' }));
  assert.equal(f.store.listHistory().length, 2);
  second.saveSettings({ outputDir: f.root });
  assert.deepEqual(f.store.getSettings(), { outputDir: f.root });
});

test('all persistence is atomic; failed rename preserves old data and removes tmp files', t => {
  const f = fixture(t);
  f.store.saveSettings({ outputDir: 'old' });
  const original = fs.renameSync;
  fs.renameSync = () => { const error = new Error('synthetic disk failure'); error.code = 'EACCES'; throw error; };
  try {
    assert.throws(() => f.store.saveSettings({ outputDir: 'new' }), { code: 'STORE_WRITE_ERROR' });
  } finally { fs.renameSync = original; }
  assert.deepEqual(f.store.getSettings(), { outputDir: 'old' });
  assert.deepEqual(fs.readdirSync(f.directory), ['settings.json']);
});

test('malformed JSON has a clear error and is never silently overwritten', t => {
  const f = fixture(t);
  fs.mkdirSync(f.directory, { recursive: true });
  const filename = path.join(f.directory, 'history.json');
  const damaged = '{"history": [broken';
  fs.writeFileSync(filename, damaged);
  assert.throws(() => f.store.listHistory(), { code: 'STORE_CORRUPT' });
  assert.throws(() => f.store.addHistory(history()), { code: 'STORE_CORRUPT' });
  assert.equal(fs.readFileSync(filename, 'utf8'), damaged);
  // Explicit user clear may intentionally reset a broken history file.
  assert.deepEqual(f.store.clearHistory(), []);
});

test('wrong JSON schemas and invalid saved history records are detected', t => {
  const f = fixture(t);
  fs.mkdirSync(f.directory, { recursive: true });
  for (const value of [[], 'wrong', { outputDir: 42 }]) {
    fs.writeFileSync(path.join(f.directory, 'settings.json'), JSON.stringify(value));
    assert.throws(() => f.store.getSettings(), { code: 'STORE_CORRUPT' });
  }
  for (const value of [{}, [null], [{ id: 'bad' }]]) {
    fs.writeFileSync(path.join(f.directory, 'history.json'), JSON.stringify(value));
    assert.throws(() => f.store.listHistory(), { code: 'STORE_CORRUPT' });
  }
});

test('unknown properties from pre-existing JSON are not returned or re-persisted', t => {
  const f = fixture(t);
  fs.mkdirSync(f.directory, { recursive: true });
  fs.writeFileSync(path.join(f.directory, 'settings.json'), JSON.stringify({ outputDir: 'old', cookie: 'secret' }));
  fs.writeFileSync(path.join(f.directory, 'history.json'), JSON.stringify([history({ cookie: 'secret' })]));
  assert.deepEqual(f.store.getSettings(), { outputDir: 'old' });
  assert.equal(f.store.listHistory()[0].cookie, undefined);
  f.store.saveSettings({});
  f.store.addHistory(history({ id: 'two' }));
  for (const filename of ['settings.json', 'history.json']) assert.equal(fs.readFileSync(path.join(f.directory, filename), 'utf8').includes('cookie'), false);
});

test('input validation rejects invalid settings and history without writing files', t => {
  const f = fixture(t);
  for (const value of [null, [], 'string', { outputDir: 1 }]) assert.throws(() => f.store.saveSettings(value), { code: 'INVALID_SETTINGS' });
  for (const patch of [
    { path: '' }, { id: '' }, { bytes: -1 }, { bytes: 1.5 }, { bytes: Infinity },
    { title: {} }, { author: [] }, { createdAt: 'invalid-date' },
    { sourceUrl: 'file:///secret' }, { sourceUrl: 'https://user:password@example.com/' },
    { cover: 'javascript:alert(1)' },
  ]) assert.throws(() => f.store.addHistory(history(patch)), { code: 'INVALID_HISTORY' });
  assert.throws(() => f.store.removeHistory(''), { code: 'INVALID_HISTORY' });
  assert.throws(() => createStore(''), { code: 'INVALID_ARGUMENT' });
  assert.equal(fs.existsSync(f.directory), false);
});

test('unwritable data path produces an explicit storage error', t => {
  const f = fixture(t);
  const notDirectory = path.join(f.root, 'file');
  fs.writeFileSync(notDirectory, 'not a directory');
  const blocked = createStore(notDirectory);
  assert.throws(() => blocked.saveSettings({ outputDir: f.root }), { code: 'STORE_WRITE_ERROR' });
  assert.throws(() => blocked.getSettings(), { code: 'STORE_READ_ERROR' });
});
