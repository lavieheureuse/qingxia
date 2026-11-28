'use strict';

// 日志与错误脱敏：移除 Auth Key、Bearer Token、私钥与敏感查询参数，保留排查所需的 URL 与 100.x IP。

const REDACTED = '[REDACTED]';

function redactText(input) {
  if (input === null || input === undefined) return '';
  let text = String(input);
  // Tailscale Auth Key / Node Key 等常见格式（tskey-auth-..., tskey-api-..., tskey-client-...）
  text = text.replace(/\btskey-[A-Za-z0-9_-]{6,}/g, 'tskey-***');
  // CLI 参数 --auth-key=... / --auth-key ... / --authkey=...
  text = text.replace(/(--auth-?key)(=|\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1$2***');
  // Authorization 头与通用 Bearer 令牌
  text = text.replace(/(Authorization\s*:\s*Bearer\s+)\S+/gi, `$1${REDACTED}`);
  text = text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, `$1${REDACTED}`);
  // WireGuard / Tailscale 私钥十六进制前缀
  text = text.replace(/\b(privkey|mkey|nlpriv):[0-9a-fA-F]{8,}/g, '$1:***$&'.slice(0, 0) + '$1:***');
  // URL 查询参数中的敏感字段（不匹配正常 https://login.tailscale.com/a/xxxx 路径）
  text = text.replace(/([?&](?:authkey|auth_key|token|access_token|secret|key)=)[^&\s"'`]+/gi, `$1${REDACTED}`);
  return text;
}

function redactArgs(args) {
  if (!Array.isArray(args)) return [];
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const item = String(args[i]);
    if (/^--auth-?key=/i.test(item)) {
      const idx = item.indexOf('=');
      out.push(`${item.slice(0, idx + 1)}***`);
      continue;
    }
    if (/^--auth-?key$/i.test(item)) {
      out.push(item);
      if (i + 1 < args.length) {
        out.push('***');
        i += 1;
      }
      continue;
    }
    out.push(redactText(item));
  }
  return out;
}

function redactError(error) {
  if (!error) return '';
  const msg = error instanceof Error ? error.message : String(error);
  return redactText(msg);
}

module.exports = {
  REDACTED,
  redactText,
  redactArgs,
  redactError,
};
