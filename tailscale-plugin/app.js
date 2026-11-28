'use strict';

// 渲染进程交互逻辑：仅通过 window.tailscalePlugin 与 preload 通信，不直接使用 Node 或网络请求。
(() => {
  const api = window.tailscalePlugin;
  const $ = (selector) => document.querySelector(selector);

  let currentState = null;
  let pendingState = null;
  let peerFilter = 'all';
  let toastTimer = null;

  const PHASE_TEXT = {
    stopped: '未运行',
    starting: '启动中',
    needs_login: '等待登录授权',
    connected: '已连接',
    error: '运行异常',
  };

  function escapeHtml(value) {
    const span = document.createElement('span');
    span.textContent = value === null || value === undefined ? '' : String(value);
    return span.innerHTML;
  }

  function showToast(text, kind = 'info') {
    const box = $('#toast-bar');
    if (!text) {
      box.hidden = true;
      return;
    }
    box.textContent = text;
    box.className = kind === 'error' ? 'notice notice-error' : (kind === 'warn' ? 'notice notice-warn' : 'notice');
    box.hidden = false;
    clearTimeout(toastTimer);
    if (kind === 'info') {
      toastTimer = setTimeout(() => {
        box.hidden = true;
      }, 3600);
    }
  }

  function renderDiagnostics(hints) {
    const list = $('#diagnostics-list');
    if (!Array.isArray(hints) || hints.length === 0) {
      list.hidden = true;
      list.innerHTML = '';
      return;
    }
    list.hidden = false;
    list.innerHTML = hints.map((item) => `
      <article class="diag-item is-${escapeHtml(item.severity || 'info')}">
        <strong>${escapeHtml(item.title)}</strong>
        <p>${escapeHtml(item.detail)}</p>
        ${item.suggestion ? `<small>建议：${escapeHtml(item.suggestion)}</small>` : ''}
      </article>
    `).join('');
  }

  function renderPeers(state) {
    const allPeers = Array.isArray(state.peers) ? state.peers : [];
    const filtered = peerFilter === 'online' ? allPeers.filter((p) => p.online) : allPeers;
    const summary = state.summary || { totalPeers: 0, onlinePeers: 0, directPeers: 0, derpPeers: 0 };

    $('#peers-summary').textContent = allPeers.length > 0
      ? `共 ${summary.totalPeers} 台设备 · 在线 ${summary.onlinePeers} 台 · Direct 直连 ${summary.directPeers} 台 · DERP 中继 ${summary.derpPeers} 台`
      : '启动并登录后可查看账号下所有设备节点。';

    const tbody = $('#peers-tbody');
    const empty = $('#peers-empty');
    if (filtered.length === 0) {
      tbody.innerHTML = '';
      empty.hidden = false;
      empty.textContent = state.daemonRunning ? '当前筛选条件下没有设备。' : '隧道未启动，启动后将自动同步设备列表。';
      return;
    }

    empty.hidden = true;
    tbody.innerHTML = filtered.map((peer) => {
      const chipClass = peer.connectionType === 'direct'
        ? 'chip-ok'
        : (peer.connectionType === 'offline' ? 'chip-muted' : 'chip-warn');
      const addrHint = peer.curAddr ? ` (${peer.curAddr})` : '';
      const ipDisplay = peer.ipv4 || (peer.ips && peer.ips[0]) || '—';
      const canCopy = ipDisplay !== '—';
      return `
        <tr>
          <td>
            <div class="peer-name">${escapeHtml(peer.hostName)}</div>
            <div class="peer-meta">${escapeHtml([peer.os, peer.dnsName].filter(Boolean).join(' · ') || '—')}</div>
          </td>
          <td>
            ${canCopy
              ? `<button class="ip-copy-btn" type="button" data-copy-ip="${escapeHtml(ipDisplay)}" title="复制设备 Tailscale IP">${escapeHtml(ipDisplay)}</button>`
              : '<span class="peer-meta">—</span>'}
          </td>
          <td>
            <span class="chip ${chipClass}">${escapeHtml(peer.connectionLabel)}</span>
            ${addrHint ? `<div class="peer-meta mono">${escapeHtml(addrHint)}</div>` : ''}
          </td>
          <td>
            <button class="button button-secondary button-sm" type="button" data-ping-ip="${escapeHtml(ipDisplay)}" ${!canCopy || !peer.online || !state.daemonRunning ? 'disabled' : ''}>
              <svg class="icon" aria-hidden="true"><use href="#i-pulse"/></svg>
              <span>Ping 探测</span>
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  function renderKernel(state) {
    const info = state.binaryInfo || { ready: false, missing: [], dir: '', version: null };
    $('#kernel-chip').textContent = info.ready ? `内核 v${info.version || '未知'}` : '内核未就绪';
    $('#kernel-chip').className = info.ready ? 'chip chip-ok' : 'chip chip-warn';
    $('#kernel-flag').hidden = info.ready;
    $('#kernel-summary').textContent = info.ready
      ? `已就绪（v${info.version || '未知'}）· ${info.dir}`
      : `缺少：${(info.missing || []).join('、')}`;
    $('#kernel-dir').textContent = info.dir || '—';
    $('#kernel-ver').textContent = info.version ? `v${info.version}` : '未检测到';
    $('#kernel-missing').textContent = info.missing && info.missing.length ? info.missing.join('、') : '无（3 个核心文件完整）';

    const prog = state.downloadProgress;
    const progWrap = $('#download-progress-wrap');
    if (prog && prog.phase && prog.phase !== 'done') {
      progWrap.hidden = false;
      const pct = typeof prog.percent === 'number' && prog.percent >= 0 ? prog.percent : 25;
      $('#download-progress-fill').style.width = `${pct}%`;
      const labels = {
        manifest: '正在获取官方最新版本号…',
        download: prog.totalBytes > 0
          ? `正在下载官方 MSI（${Math.round(prog.receivedBytes / 1024 / 1024 * 10) / 10} / ${Math.round(prog.totalBytes / 1024 / 1024 * 10) / 10} MB）…`
          : '正在下载官方 MSI 安装包…',
        verify: '正在校验 SHA-256 签名…',
        extract: '正在无服务解包 tailscaled.exe / tailscale.exe / wintun.dll…',
      };
      $('#download-progress-text').textContent = labels[prog.phase] || '处理中…';
    } else {
      progWrap.hidden = true;
    }
  }

  function renderSettings(state) {
    const cfg = state.config || {};
    $('#auto-connect').checked = Boolean(cfg.autoConnect);
    $('#save-auth-key').checked = Boolean(cfg.saveAuthKey);
    $('#clear-auth-key-btn').hidden = !cfg.hasSavedAuthKey;
    if (document.activeElement !== $('#hostname-input')) $('#hostname-input').value = cfg.hostname || '';
    if (document.activeElement !== $('#udp-port-input')) $('#udp-port-input').value = cfg.udpPort ? String(cfg.udpPort) : '0';
    if (document.activeElement !== $('#login-server-input')) $('#login-server-input').value = cfg.loginServer || '';
    $('#accept-dns').checked = cfg.acceptDns !== false;
    $('#no-logs').checked = cfg.noLogsNoSupport !== false;

    const parts = [];
    if (cfg.hasSavedAuthKey) parts.push('已 DPAPI 保存 Auth Key');
    if (cfg.hostname) parts.push(`节点名 ${cfg.hostname}`);
    if (cfg.loginServer) parts.push(cfg.loginServer);
    $('#settings-summary').textContent = parts.length ? parts.join(' · ') : '默认参数 · 交互式浏览器授权';
  }

  function renderLogs(logsData) {
    const lines = [];
    if (logsData && Array.isArray(logsData.plugin) && logsData.plugin.length) {
      lines.push('--- 插件事件 ---', ...logsData.plugin);
    }
    if (logsData && Array.isArray(logsData.stderr) && logsData.stderr.length) {
      lines.push('--- tailscaled stderr ---', ...logsData.stderr);
    }
    if (logsData && Array.isArray(logsData.stdout) && logsData.stdout.length) {
      lines.push('--- tailscaled stdout ---', ...logsData.stdout);
    }
    const box = $('#logs-output');
    box.textContent = lines.length ? lines.join('\n') : '暂无运行日志';
    box.scrollTop = box.scrollHeight;
  }

  function render(state) {
    currentState = state;
    const busy = Boolean(state.busy || state.exiting);
    const phase = state.phase || 'stopped';
    const label = PHASE_TEXT[phase] || '未知状态';

    $('#phase-badge').className = `phase-badge is-${phase}`;
    $('#phase-badge-text').textContent = label;
    $('#status-indicator').className = `status-indicator is-${phase}`;
    $('#status-heading').textContent = state.busy ? (state.busyMessage || label) : label;

    const subtitleMap = {
      stopped: state.binaryInfo && state.binaryInfo.ready
        ? '点击“启动连接”将通过管理员授权拉起独立 Wintun 虚拟网卡。'
        : '请先在“内核管理”下载官方内核或指定本地目录。',
      starting: '正在拉起 tailscaled 守护进程并等待虚拟网卡就绪…',
      needs_login: state.needsMachineAuth
        ? '此节点正在等待 Tailnet 管理员批准，请检查控制台。'
        : '请在浏览器完成 Tailscale 账号授权登录。',
      connected: `已接入 Tailnet${state.tailnetName ? `（${state.tailnetName}）` : ''}，可通过 100.x.y.z 直连互通。`,
      error: state.lastError || '运行过程中发生异常，请查看下方诊断提示与运行日志。',
    };
    $('#status-subtitle').textContent = subtitleMap[phase] || '';

    const tunChip = $('#tun-chip');
    if (state.daemonRunning) {
      tunChip.textContent = state.tun ? 'Wintun 虚拟网卡已启用' : 'TUN 未就绪';
      tunChip.className = state.tun ? 'chip chip-ok' : 'chip chip-bad';
    } else {
      tunChip.textContent = 'Wintun 虚拟网卡';
      tunChip.className = 'chip chip-muted';
    }

    const pidChip = $('#pid-chip');
    if (state.daemonRunning && state.pid) {
      pidChip.hidden = false;
      pidChip.textContent = `PID ${state.pid}`;
    } else {
      pidChip.hidden = true;
    }

    const toggleBtn = $('#toggle-btn');
    $('#toggle-label').textContent = state.daemonRunning ? '停止隧道' : '启动连接';
    $('#toggle-icon').setAttribute('href', state.daemonRunning ? '#i-stop' : '#i-play');
    toggleBtn.className = state.daemonRunning ? 'button button-danger' : 'button button-primary';
    toggleBtn.disabled = busy || !state.platformSupported || (!state.daemonRunning && (!state.binaryInfo || !state.binaryInfo.ready));

    $('#refresh-btn').disabled = busy;
    $('#logout-btn').disabled = busy || !state.binaryInfo || !state.binaryInfo.ready;
    $('#auto-connect').disabled = busy;
    $('#download-kernel-btn').disabled = busy || state.daemonRunning;
    $('#pick-kernel-btn').disabled = busy || state.daemonRunning;
    $('#save-settings-btn').disabled = busy;

    const selfIp = (state.self && state.self.ipv4) || '';
    $('#self-ip').textContent = selfIp || '—';
    $('#copy-self-ip').hidden = !selfIp;
    $('#self-name').textContent = (state.self && state.self.hostName) || '—';
    $('#self-dns').textContent = (state.self && state.self.dnsName) || (state.daemonRunning ? '等待分配域名' : '尚未接入 Tailnet');
    $('#tun-mode-text').textContent = state.daemonRunning
      ? (state.tun ? `真实虚拟网卡 (${state.tunName})` : '异常：非虚拟网卡模式')
      : '未启动';

    const errBox = $('#status-error');
    if (state.lastError) {
      errBox.hidden = false;
      $('#status-error-text').textContent = state.lastError;
    } else {
      errBox.hidden = true;
    }

    const authCard = $('#auth-card');
    if (state.authUrl && phase === 'needs_login') {
      authCard.hidden = false;
      $('#auth-url-text').textContent = state.authUrl;
    } else {
      authCard.hidden = true;
    }

    const hostWarn = $('#host-warning');
    if (!state.platformSupported) {
      hostWarn.hidden = false;
      hostWarn.textContent = '当前不是 Windows 系统，本插件的 Wintun 虚拟网卡与 UAC 进程管理仅支持 Windows。';
    } else if (!state.supportsExit) {
      hostWarn.hidden = false;
      hostWarn.textContent = '当前轻匣版本不支持退出自动清理回调；关闭插件或退出轻匣前请先手动点击“停止隧道”。';
    } else {
      hostWarn.hidden = true;
    }

    if (state.lastPing) {
      const p = state.lastPing;
      const banner = $('#ping-result');
      banner.hidden = false;
      banner.textContent = p.ok
        ? `最近 Ping ${p.target}：${p.mode === 'direct' ? 'Direct 直连' : 'DERP 中继'}（${p.via}），延迟 ${p.latencyMs} ms`
        : `最近 Ping ${p.target}：${p.raw || '未收到回复'}`;
    }

    renderDiagnostics(state.diagnostics);
    renderPeers(state);
    renderKernel(state);
    renderSettings(state);
  }

  function confirmLogout() {
    return new Promise((resolve) => {
      const dialog = $('#confirm-dialog');
      $('#confirm-title').textContent = '确认注销 Tailscale 账号';
      $('#confirm-message').textContent = '注销后将清除本插件独立状态目录中的当前节点登录凭据，并停止隧道。确认继续吗？';
      dialog.returnValue = '';
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
      dialog.showModal();
    });
  }

  async function refreshLogsView() {
    if (!api) return;
    try {
      renderLogs(api.getLogs());
    } catch (_) {
      /* 忽略 */
    }
  }

  document.addEventListener('click', async (event) => {
    const btn = event.target.closest('button');
    if (!btn) return;
    try {
      if (btn.id === 'toggle-btn') {
        if (currentState && currentState.daemonRunning) {
          await api.stopTunnel();
          showToast('已停止 Tailscale 隧道并清理虚拟网卡状态。');
        } else {
          const rawKey = $('#auth-key-input').value.trim();
          await api.startTunnel({ authKey: rawKey });
          showToast('已拉起 Tailscale 服务，请确认设备连接状态。');
        }
        await refreshLogsView();
      } else if (btn.id === 'refresh-btn') {
        await api.refreshStatus();
        await refreshLogsView();
      } else if (btn.id === 'logout-btn') {
        if (!(await confirmLogout())) return;
        await api.logout();
        showToast('已注销节点账号并停止隧道。');
        await refreshLogsView();
      } else if (btn.id === 'copy-self-ip') {
        const ip = currentState && currentState.self && currentState.self.ipv4;
        if (ip && api.copyText(ip)) showToast(`已复制本机 IP：${ip}`);
      } else if (btn.id === 'open-auth-btn') {
        await api.openAuthUrl();
        showToast('已在系统浏览器打开授权页面，请完成登录。');
      } else if (btn.id === 'copy-auth-btn') {
        const url = currentState && currentState.authUrl;
        if (url && api.copyText(url)) showToast('已复制授权链接。');
      } else if (btn.id === 'filter-all') {
        peerFilter = 'all';
        $('#filter-all').classList.add('active');
        $('#filter-online').classList.remove('active');
        if (currentState) renderPeers(currentState);
      } else if (btn.id === 'filter-online') {
        peerFilter = 'online';
        $('#filter-online').classList.add('active');
        $('#filter-all').classList.remove('active');
        if (currentState) renderPeers(currentState);
      } else if (btn.dataset.copyIp) {
        if (api.copyText(btn.dataset.copyIp)) showToast(`已复制设备 IP：${btn.dataset.copyIp}`);
      } else if (btn.dataset.pingIp) {
        showToast(`正在探测 ${btn.dataset.pingIp} 链路…`);
        await api.pingPeer(btn.dataset.pingIp);
        await refreshLogsView();
      } else if (btn.id === 'download-kernel-btn') {
        await api.downloadKernel();
        showToast('官方 Tailscale 内核下载并校验安装完成。');
        await refreshLogsView();
      } else if (btn.id === 'pick-kernel-btn') {
        const res = await api.pickLocalKernelDir();
        if (res) showToast('已切换本地内核目录。');
      } else if (btn.id === 'open-data-btn') {
        await api.openDataDir();
      } else if (btn.id === 'clear-auth-key-btn') {
        await api.clearSavedAuthKey();
        $('#auth-key-input').value = '';
        showToast('已清除保存的 Auth Key。');
      } else if (btn.id === 'copy-logs-btn') {
        const text = $('#logs-output').textContent;
        if (text && api.copyText(text)) showToast('已复制运行日志。');
      } else if (btn.id === 'clear-logs-btn') {
        api.clearLogs();
        await refreshLogsView();
        showToast('日志已清空。');
      }
    } catch (error) {
      showToast(error && error.message ? error.message : String(error), 'error');
      await refreshLogsView();
    }
  });

  $('#auto-connect').addEventListener('change', async (event) => {
    try {
      await api.saveConfig({ autoConnect: event.target.checked });
      showToast(event.target.checked ? '已开启“插件启动时自动连接”。' : '已关闭自动连接。');
    } catch (error) {
      event.target.checked = !event.target.checked;
      showToast(error.message || String(error), 'error');
    }
  });

  $('#settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const saveKey = $('#save-auth-key').checked;
      const authKey = $('#auth-key-input').value.trim();
      const portRaw = $('#udp-port-input').value.trim();
      await api.saveConfig({
        hostname: $('#hostname-input').value.trim(),
        udpPort: portRaw === '' ? 0 : Number(portRaw),
        loginServer: $('#login-server-input').value.trim(),
        acceptDns: $('#accept-dns').checked,
        noLogsNoSupport: $('#no-logs').checked,
        saveAuthKey: saveKey,
        authKey: saveKey && authKey ? authKey : undefined,
      });
      if (saveKey && authKey) $('#auth-key-input').value = '';
      showToast('连接参数已保存（下次启动或连接时生效）。');
    } catch (error) {
      showToast(error.message || String(error), 'error');
    }
  });

  $('#logs-panel').addEventListener('toggle', () => {
    if ($('#logs-panel').open) refreshLogsView();
  });

  function syncVisibility() {
    if (!api || typeof api.setWindowVisible !== 'function') return;
    try {
      api.setWindowVisible(!document.hidden);
    } catch (_) {
      /* 忽略 */
    }
  }

  document.addEventListener('visibilitychange', () => {
    syncVisibility();
    if (!document.hidden && pendingState) {
      const next = pendingState;
      pendingState = null;
      render(next);
    }
  });

  (async () => {
    if (!api) {
      showToast('未检测到轻匣插件运行环境，请在轻匣中打开本插件。', 'error');
      return;
    }
    api.onState((next) => {
      if (document.hidden) {
        pendingState = next;
        return;
      }
      pendingState = null;
      render(next);
    });
    api.onLog(() => {
      if (!document.hidden && $('#logs-panel').open) refreshLogsView();
    });
    try {
      const initial = await api.bootstrap();
      render(initial);
      syncVisibility();
      await refreshLogsView();
      if (initial.binaryInfo && !initial.binaryInfo.ready) {
        $('#kernel-panel').open = true;
      }
    } catch (error) {
      showToast(error && error.message ? error.message : String(error), 'error');
    }
  })();
})();
