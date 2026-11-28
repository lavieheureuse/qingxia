'use strict';

// 解析 `tailscale status --json`、`tailscale ping` 输出以及 `tailscale up` 登录授权链接。
const { redactText } = require('./redact.cjs');

function pickIpv4(ips) {
  if (!Array.isArray(ips)) return '';
  const v4 = ips.find((ip) => typeof ip === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(ip.trim()));
  return v4 ? v4.trim() : (typeof ips[0] === 'string' ? ips[0].trim() : '');
}

function cleanDnsName(dnsName) {
  return typeof dnsName === 'string' ? dnsName.replace(/\.+$/, '') : '';
}

function extractAuthUrlFromText(text) {
  const match = /https:\/\/[^\s"'`<>]+/i.exec(String(text || ''));
  return match ? match[0].replace(/[),.;]+$/, '') : '';
}

function classifyPeerConnection(peer) {
  if (!peer || !peer.Online) {
    return { type: 'offline', label: '离线' };
  }
  if (typeof peer.CurAddr === 'string' && peer.CurAddr.trim()) {
    return { type: 'direct', label: 'Direct 直连' };
  }
  if (typeof peer.PeerRelay === 'string' && peer.PeerRelay.trim()) {
    return { type: 'peer_relay', label: 'Peer Relay' };
  }
  if (typeof peer.Relay === 'string' && peer.Relay.trim()) {
    return { type: 'derp', label: `DERP 中继 (${peer.Relay.trim().toUpperCase()})` };
  }
  return { type: 'idle', label: '在线待机' };
}

function normalizePeer(peer, idKey) {
  const ips = Array.isArray(peer && peer.TailscaleIPs) ? peer.TailscaleIPs.filter((x) => typeof x === 'string') : [];
  const conn = classifyPeerConnection(peer);
  return {
    id: (peer && peer.ID) || idKey || '',
    hostName: (peer && peer.HostName) || cleanDnsName(peer && peer.DNSName) || '未命名节点',
    dnsName: cleanDnsName(peer && peer.DNSName),
    os: (peer && peer.OS) || '',
    ipv4: pickIpv4(ips),
    ips,
    online: Boolean(peer && peer.Online),
    active: Boolean(peer && peer.Active),
    connectionType: conn.type,
    connectionLabel: conn.label,
    curAddr: (peer && peer.CurAddr) || '',
    relay: (peer && peer.Relay) || '',
    peerRelay: (peer && peer.PeerRelay) || '',
    rxBytes: Number(peer && peer.RxBytes) || 0,
    txBytes: Number(peer && peer.TxBytes) || 0,
    lastSeen: (peer && peer.LastSeen) || '',
    lastHandshake: (peer && peer.LastHandshake) || '',
  };
}

const PEER_SORT_ORDER = {
  direct: 0,
  peer_relay: 1,
  derp: 2,
  idle: 3,
  offline: 4,
};

function sortPeers(peers) {
  return [...peers].sort((a, b) => {
    const oa = PEER_SORT_ORDER[a.connectionType] ?? 9;
    const ob = PEER_SORT_ORDER[b.connectionType] ?? 9;
    if (oa !== ob) return oa - ob;
    return a.hostName.localeCompare(b.hostName, 'zh-CN');
  });
}

function mapPhase(backendState, hasError) {
  if (hasError) return 'error';
  switch (backendState) {
    case 'Running':
      return 'connected';
    case 'NeedsLogin':
    case 'NeedsMachineAuth':
      return 'needs_login';
    case 'Starting':
      return 'starting';
    case 'Stopped':
    case 'NoState':
    default:
      return 'stopped';
  }
}

function parseStatusJson(rawInput, context = {}) {
  let obj = rawInput;
  if (typeof rawInput === 'string') {
    const trimmed = rawInput.trim();
    const startIdx = trimmed.indexOf('{');
    if (startIdx < 0) {
      throw new Error('tailscale status --json 未返回有效 JSON');
    }
    obj = JSON.parse(trimmed.slice(startIdx));
  }
  if (!obj || typeof obj !== 'object') {
    throw new Error('tailscale status 数据结构无效');
  }

  const backendState = typeof obj.BackendState === 'string' ? obj.BackendState : 'NoState';
  const tun = Boolean(obj.TUN);
  const selfRaw = obj.Self && typeof obj.Self === 'object' ? obj.Self : {};
  const selfIps = Array.isArray(obj.TailscaleIPs) && obj.TailscaleIPs.length
    ? obj.TailscaleIPs
    : (Array.isArray(selfRaw.TailscaleIPs) ? selfRaw.TailscaleIPs : []);

  const peersMap = obj.Peer && typeof obj.Peer === 'object' ? obj.Peer : {};
  const peers = sortPeers(
    Object.entries(peersMap).map(([key, peer]) => normalizePeer(peer, key)),
  );

  const summary = {
    totalPeers: peers.length,
    onlinePeers: peers.filter((p) => p.online).length,
    directPeers: peers.filter((p) => p.connectionType === 'direct').length,
    derpPeers: peers.filter((p) => p.connectionType === 'derp').length,
  };

  const health = Array.isArray(obj.Health)
    ? obj.Health.map((line) => redactText(String(line))).filter(Boolean)
    : [];

  const tailnetName = (obj.CurrentTailnet && obj.CurrentTailnet.Name)
    || obj.MagicDNSSuffix
    || (obj.CurrentTailnet && obj.CurrentTailnet.MagicDNSSuffix)
    || '';

  return {
    phase: mapPhase(backendState, Boolean(context.error)),
    backendState,
    version: typeof obj.Version === 'string' ? obj.Version : '',
    tun,
    tunWarning: backendState === 'Running' && !tun,
    needsMachineAuth: backendState === 'NeedsMachineAuth',
    authUrl: (typeof obj.AuthURL === 'string' && obj.AuthURL) || context.fallbackAuthUrl || '',
    tailnetName,
    self: {
      hostName: selfRaw.HostName || cleanDnsName(selfRaw.DNSName) || '',
      dnsName: cleanDnsName(selfRaw.DNSName),
      ipv4: pickIpv4(selfIps),
      ips: selfIps.filter((x) => typeof x === 'string'),
      os: selfRaw.OS || '',
      online: Boolean(selfRaw.Online),
    },
    peers,
    summary,
    health,
  };
}

function parsePingOutput(rawOutput) {
  const text = redactText(String(rawOutput || '')).trim();
  if (!text) return { ok: false, mode: 'unknown', via: '', latencyMs: null, raw: '' };
  const pongMatch = /pong from\s+([^\s(]+)\s*\(([^)]+)\)\s+via\s+(.+?)\s+in\s+([\d.]+)\s*(ms|µs|us|s)\b/i.exec(text);
  if (!pongMatch) {
    return { ok: false, mode: 'unknown', via: '', latencyMs: null, raw: text };
  }
  const via = pongMatch[3].trim();
  const value = Number(pongMatch[4]);
  const unit = pongMatch[5].toLowerCase();
  let latencyMs = value;
  if (unit === 'µs' || unit === 'us') latencyMs = Math.round(value / 10) / 100;
  else if (unit === 's') latencyMs = Math.round(value * 1000);
  else latencyMs = Math.round(value * 10) / 10;

  const isDerp = /^DERP\(/i.test(via);
  return {
    ok: true,
    host: pongMatch[1],
    ip: pongMatch[2],
    mode: isDerp ? 'derp' : 'direct',
    via,
    latencyMs,
    raw: text,
  };
}

module.exports = {
  pickIpv4,
  cleanDnsName,
  extractAuthUrlFromText,
  classifyPeerConnection,
  parseStatusJson,
  parsePingOutput,
};
