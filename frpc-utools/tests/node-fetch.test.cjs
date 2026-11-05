'use strict';

// 针对 core/node-fetch.cjs 的测试：真实本地 http 服务，覆盖 GET/POST/状态码/重定向/取消。
// 这层存在的意义：uTools preload 的全局 fetch 受页面 CSP 限制，真机会 Failed to fetch；
// 因此所有宿主网络请求必须走 Node http/https。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { nodeFetch } = require('../core/node-fetch.cjs');

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('GET 返回 JSON 与状态码', async () => {
  const server = await startServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer t1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  try {
    const response = await nodeFetch(`${server.base}/health`, { headers: { Authorization: 'Bearer t1' } });
    assert.equal(response.ok, true);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, path: '/health' });
  } finally { await server.close(); }
});

test('POST 发送 JSON body 并读取回包', async () => {
  const server = await startServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      assert.equal(req.method, 'POST');
      assert.equal(req.headers['content-type'], 'application/json');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: JSON.parse(raw) }));
    });
  });
  try {
    const response = await nodeFetch(`${server.base}/frp/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pcId: 'pc-home', version: 3 })
    });
    assert.equal(response.ok, true);
    assert.deepEqual((await response.json()).received, { pcId: 'pc-home', version: 3 });
  } finally { await server.close(); }
});

test('非 2xx 不抛错，交给调用方判断（401/404 语义在 service 层）', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '未授权' }));
  });
  try {
    const response = await nodeFetch(`${server.base}/frp/config?pcId=pc-home`);
    assert.equal(response.ok, false);
    assert.equal(response.status, 401);
    assert.match(await response.text(), /未授权/);
  } finally { await server.close(); }
});

test('跟随重定向并保留同源 Authorization', async () => {
  const server = await startServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { Location: '/final' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ auth: req.headers.authorization || null }));
  });
  try {
    const response = await nodeFetch(`${server.base}/start`, { headers: { Authorization: 'Bearer keep' } });
    assert.equal(response.ok, true);
    assert.deepEqual(await response.json(), { auth: 'Bearer keep' });
  } finally { await server.close(); }
});

test('AbortSignal 取消请求得到 AbortError', async () => {
  const server = await startServer((req, res) => {
    // 故意不响应，等待客户端取消
    res.on('close', () => {});
  });
  const controller = new AbortController();
  try {
    const pending = nodeFetch(`${server.base}/slow`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, (error) => error && error.name === 'AbortError');
  } finally { await server.close(); }
});

test('连接被拒绝时给出可读错误', async () => {
  await assert.rejects(nodeFetch('http://127.0.0.1:1/nope', { timeoutMs: 2000 }), (error) => {
    assert.ok(error instanceof Error);
    assert.match(String(error.message), /ECONNREFUSED|connect|拒绝/);
    return true;
  });
});

test('超时会中断长连接', async () => {
  const server = await startServer((req, res) => { res.on('close', () => {}); });
  try {
    await assert.rejects(nodeFetch(`${server.base}/hang`, { timeoutMs: 150 }), /超时|aborted|AbortError/i);
  } finally { await server.close(); }
});

test('response.body 可流式读取（frpc 下载依赖此路径）', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '8' });
    res.write(Buffer.from('abcd'));
    setTimeout(() => res.end(Buffer.from('efgh')), 10);
  });
  try {
    const response = await nodeFetch(`${server.base}/file`);
    assert.equal(response.headers.get('content-length'), '8');
    const chunks = [];
    for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'abcdefgh');
  } finally { await server.close(); }
});
