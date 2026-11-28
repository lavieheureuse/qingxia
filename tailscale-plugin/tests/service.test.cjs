'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createService } = require('../core/service.cjs');
const { DEFAULT_CONFIG } = require('../core/config.cjs');

function makeHarness({ stopDaemonError = null, running = false } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-svc-'));
  const busyCalls = [];
  let isRunning = running;
  let stopCalled = 0;
  let openedUrl = '';

  const host = {
    setPluginBusy: (val) => busyCalls.push(Boolean(val)),
    copyText: () => {},
    onPluginExit: () => {},
  };

  let savedCfg = { ...DEFAULT_CONFIG };
  const store = {
    load: async () => ({ config: { ...savedCfg }, authKey: '' }),
    save: async (patch) => {
      savedCfg = { ...savedCfg, ...patch };
      return { ...savedCfg };
    },
  };

  const binary = {
    inspectBinaryDir: async (dir) => ({
      ready: true,
      dir,
      tailscaledPath: path.join(dir, 'tailscaled.exe'),
      tailscalePath: path.join(dir, 'tailscale.exe'),
      wintunPath: path.join(dir, 'wintun.dll'),
      missing: [],
      version: '1.104.7',
    }),
  };

  const daemon = {
    getProcessState: async () => ({
      running: isRunning,
      record: isRunning ? { pid: 5566, processName: 'tailscaled', startTicks: '100' } : null,
    }),
    checkConflicts: async () => ({
      hasConflict: false,
      officialServiceRunning: false,
      officialServiceStatus: '',
      externalProcesses: [],
      adapters: [],
    }),
    startDaemon: async () => {
      isRunning = true;
      return { pid: 5566, processName: 'tailscaled', startTicks: '100' };
    },
    stopDaemon: async () => {
      stopCalled += 1;
      if (stopDaemonError) throw stopDaemonError;
      isRunning = false;
      return { stopped: true, wasRunning: true };
    },
    runCli: async (_exe, args) => {
      if (args[0] === 'status') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            BackendState: 'NeedsLogin',
            TUN: true,
            AuthURL: 'https://login.tailscale.com/a/test123',
          }),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    startInteractiveUp: ({ onAuthUrl }) => {
      onAuthUrl('https://login.tailscale.com/a/test123');
      return {
        promise: Promise.resolve({ cancelled: false }),
        cancel: () => {},
      };
    },
    readDaemonLogs: () => ({ stdout: [], stderr: [] }),
    clearDaemonLogs: () => {},
  };

  const ps = {
    openExternalHttpsUrl: async (url) => {
      openedUrl = url;
    },
  };

  const service = createService({
    dataDir: tmpDir,
    host,
    platform: 'win32',
    arch: 'x64',
    store,
    binary,
    daemon,
    ps,
  });

  return {
    tmpDir,
    service,
    busyCalls,
    getStopCalled: () => stopCalled,
    getOpenedUrl: () => openedUrl,
    cleanup: () => {
      service.dispose();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test('service toggles setPluginBusy around startTunnel and captures safe authUrl', async () => {
  const h = makeHarness();
  try {
    await h.service.bootstrap();
    const state = await h.service.startTunnel({});
    assert.equal(state.phase, 'needs_login');
    assert.equal(state.authUrl, 'https://login.tailscale.com/a/test123');
    assert.deepEqual(h.busyCalls, [true, false]);

    const opened = await h.service.openAuthUrl();
    assert.equal(opened, 'https://login.tailscale.com/a/test123');
    assert.equal(h.getOpenedUrl(), 'https://login.tailscale.com/a/test123');
  } finally {
    h.cleanup();
  }
});

test('service shutdown stops daemon on exit and propagates error if cleanup fails, and recovers on onPluginExitCancelled', async () => {
  const hOk = makeHarness({ running: true });
  try {
    await hOk.service.bootstrap();
    const res = await hOk.service.shutdown();
    assert.equal(res.stopped, true);
    assert.equal(hOk.getStopCalled(), 1);
    assert.equal(hOk.service.getState().exiting, true);

    hOk.service.resumeAfterCancelledExit();
    assert.equal(hOk.service.getState().exiting, false);
    assert.equal(hOk.service.getState().daemonRunning, false);
  } finally {
    hOk.cleanup();
  }

  const hFail = makeHarness({ running: true, stopDaemonError: new Error('UAC 被用户取消') });
  try {
    await hFail.service.bootstrap();
    await assert.rejects(() => hFail.service.shutdown(), /停止 Tailscale 失败.*UAC 被用户取消/);
    assert.equal(hFail.service.getState().exiting, false);
    assert.deepEqual(hFail.busyCalls, [true, false]);
  } finally {
    hFail.cleanup();
  }
});
