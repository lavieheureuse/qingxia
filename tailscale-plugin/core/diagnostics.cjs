'use strict';

// 异常排查与环境诊断：冲突检测、缺失内核、非 TUN 警告、代理软件 TUN 网卡/FakeIP 冲突提示。

const PROXY_TUN_PATTERNS = [
  /clash/i,
  /mihomo/i,
  /meta/i,
  /sing-?box/i,
  /v2ray/i,
  /nekoray/i,
  /nekobox/i,
  /flclash/i,
  /verge/i,
  /shadowrocket/i,
  /wireguard/i,
];

function detectProxyTunAdapters(adapters) {
  if (!Array.isArray(adapters)) return [];
  const matches = [];
  for (const item of adapters) {
    const name = typeof item === 'string' ? item : String((item && (item.Name || item.InterfaceDescription)) || '');
    const desc = typeof item === 'object' && item ? String(item.InterfaceDescription || '') : '';
    const status = typeof item === 'object' && item ? String(item.Status || 'Up') : 'Up';
    if (!name && !desc) continue;
    if (/tailscale/i.test(name) || /tailscale/i.test(desc)) continue;
    if (status && status.toLowerCase() !== 'up') continue;
    const combined = `${name} ${desc}`;
    if (PROXY_TUN_PATTERNS.some((re) => re.test(combined))) {
      matches.push(name || desc);
    }
  }
  return Array.from(new Set(matches));
}

function analyzeDiagnostics({ status, conflicts, binaryInfo, logs, adapters, lastError } = {}) {
  const hints = [];

  if (conflicts && conflicts.officialServiceRunning) {
    hints.push({
      id: 'official-service-conflict',
      severity: 'error',
      title: '检测到系统原版 Tailscale 服务正在运行',
      detail: 'Windows 原版 Tailscale 服务（Tailscale）会占用同一块 Wintun 虚拟网卡与本地状态，本插件不会自动停止原版服务。',
      suggestion: '请先在系统服务或原版客户端中停止/退出官方 Tailscale，再使用本插件启动隧道。',
    });
  } else if (conflicts && Array.isArray(conflicts.externalProcesses) && conflicts.externalProcesses.length > 0) {
    const pids = conflicts.externalProcesses.map((p) => p.pid).join(', ');
    hints.push({
      id: 'external-tailscaled-conflict',
      severity: 'error',
      title: `检测到外部 tailscaled 进程（PID: ${pids}）`,
      detail: '为防止误杀非本插件启动的进程，插件已阻止启动并在确认冲突清除前保持停止。',
      suggestion: '请确认并手动关闭外部 tailscaled 进程后重试。',
    });
  }

  if (binaryInfo && !binaryInfo.ready) {
    hints.push({
      id: 'binary-missing',
      severity: 'warn',
      title: `缺少内核文件：${(binaryInfo.missing || []).join('、')}`,
      detail: 'Wintun 真实虚拟网卡模式必须同时具备 tailscaled.exe、tailscale.exe 与 wintun.dll。',
      suggestion: '请在下方“内核管理”中点击“一键下载官方最新内核”，或手动指定包含这 3 个文件的本地目录。',
    });
  }

  if (status && status.tunWarning) {
    hints.push({
      id: 'tun-disabled',
      severity: 'error',
      title: '当前未运行在 Wintun 虚拟网卡模式（TUN=false）',
      detail: '非虚拟网卡模式下无法为本机分配 100.x.y.z 虚拟网卡，外部设备将无法通过 100.x.y.z 直连本机。',
      suggestion: '请停止隧道并确认 wintun.dll 完整且管理员权限已授予，同时排查是否有其他虚拟网卡占用冲突。',
    });
  }

  const proxyTunNames = detectProxyTunAdapters(adapters);
  const logText = Array.isArray(logs) ? logs.join('\n') : String(logs || '');
  const healthText = status && Array.isArray(status.health) ? status.health.join('\n') : '';
  const combinedDiag = `${logText}\n${healthText}\n${lastError || ''}`;
  const mentionsWintun = /wintun|WintunOpenAdapter|100\.64\.|fake-?ip|netstack|another.*tun/i.test(combinedDiag);

  if (proxyTunNames.length > 0 || mentionsWintun) {
    hints.push({
      id: 'proxy-tun-conflict',
      severity: 'warn',
      title: proxyTunNames.length > 0
        ? `检测到其他代理/VPN 虚拟网卡：${proxyTunNames.join('、')}`
        : '日志或健康检查提示虚拟网卡 / 路由可能存在冲突',
      detail: '若 Clash / Mihomo / sing-box 等代理软件开启了 TUN 模式或 Fake-IP（同属 100.64.0.0/10 网段），可能劫持 100.x.y.z 流量导致直连失败或无法 P2P 打洞。',
      suggestion: '请在代理软件中将 100.64.0.0/10（CGNAT 网段）及 tailscaled.exe 加入直连/Bypass 规则。',
    });
  }

  if (status && status.phase === 'connected' && status.summary && status.summary.onlinePeers > 0 && status.summary.directPeers === 0 && status.summary.derpPeers > 0) {
    hints.push({
      id: 'derp-only',
      severity: 'info',
      title: '当前在线设备均处于 DERP 中继或待机状态',
      detail: 'Tailscale 默认按需建立 UDP P2P 直连；无实际流量时状态常显示为 DERP 中继。',
      suggestion: '可点击设备旁的“Ping 探测”主动触发 UDP 打洞，或检查公司网络/系统防火墙是否放行 UDP 流量。',
    });
  }

  return hints;
}

module.exports = {
  detectProxyTunAdapters,
  analyzeDiagnostics,
};
