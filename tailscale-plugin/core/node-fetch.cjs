'use strict';

// 极小 Node 原生 fetch 兼容层：供 preload / core 发起 HTTPS 请求，绕开渲染进程 CSP 限制。
const http = require('node:http');
const https = require('node:https');

const MAX_REDIRECTS = 5;

function abortError() {
  const error = new Error('请求已取消');
  error.name = 'AbortError';
  return error;
}

function buildResponse(response, requestUrl) {
  let textCache = null;
  return {
    ok: response.statusCode >= 200 && response.statusCode < 300,
    status: response.statusCode,
    statusText: response.statusMessage || '',
    url: requestUrl,
    body: response,
    headers: {
      get(name) {
        const value = response.headers[String(name).toLowerCase()];
        return Array.isArray(value) ? value.join(', ') : (value === undefined ? null : String(value));
      },
      has(name) {
        return response.headers[String(name).toLowerCase()] !== undefined;
      },
    },
    async text() {
      if (textCache !== null) return textCache;
      textCache = await new Promise((resolve, reject) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        response.on('error', reject);
      });
      return textCache;
    },
    async json() {
      return JSON.parse(await this.text());
    },
  };
}

function requestOnce(target, options, redirectsLeft) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(target);
    } catch (_) {
      return reject(new Error(`无效的地址：${target}`));
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return reject(new Error(`不支持的协议：${url.protocol}`));
    }
    const signal = options.signal;
    if (signal && signal.aborted) return reject(abortError());

    const headers = Object.assign({}, options.headers || {});
    if (!headers['accept-encoding'] && !headers['Accept-Encoding']) {
      headers['accept-encoding'] = 'identity';
    }
    const method = String(options.method || 'GET').toUpperCase();
    const body = options.body === undefined || options.body === null
      ? null
      : (Buffer.isBuffer(options.body) ? options.body : Buffer.from(String(options.body), 'utf8'));
    if (body) headers['content-length'] = String(body.length);

    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      timeout: options.timeoutMs || 30000,
    }, (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;
      if (options.redirect !== 'manual' && status >= 300 && status < 400 && location && redirectsLeft > 0) {
        response.resume();
        let nextUrl;
        try {
          nextUrl = new URL(location, url).toString();
        } catch (_) {
          return resolve(buildResponse(response, target));
        }
        const nextHeaders = Object.assign({}, headers);
        delete nextHeaders['content-length'];
        if (new URL(nextUrl).origin !== url.origin) {
          delete nextHeaders.authorization;
          delete nextHeaders.Authorization;
        }
        const nextBody = status === 303 || method === 'GET' || method === 'HEAD' ? null : body;
        return resolve(requestOnce(
          nextUrl,
          Object.assign({}, options, { method: nextBody === null ? 'GET' : method, headers: nextHeaders, body: nextBody }),
          redirectsLeft - 1,
        ));
      }
      resolve(buildResponse(response, target));
    });

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      request.destroy(abortError());
    };
    if (signal) {
      if (signal.aborted) return request.destroy(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      request.on('close', () => signal.removeEventListener('abort', onAbort));
    }
    request.on('timeout', () => {
      request.destroy(new Error(`请求超时（${Math.round((options.timeoutMs || 30000) / 1000)} 秒）`));
    });
    request.on('error', (error) => {
      reject(aborted ? abortError() : error);
    });
    if (body) request.write(body);
    request.end();
  });
}

/**
 * 发起一次基于 Node 原生 http/https 的请求。
 * @param {string} target
 * @param {{method?:string, headers?:object, body?:string|Buffer, signal?:AbortSignal, redirect?:'follow'|'manual', timeoutMs?:number}} [options]
 */
function nodeFetch(target, options = {}) {
  return requestOnce(target, options, MAX_REDIRECTS);
}

module.exports = { nodeFetch };
