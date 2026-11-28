'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateProcessRecord, verifyProcessIdentity, isOwnOrphanCommandLine, createDaemonManager } = require('../core/daemon.cjs');
const { isUacCancelledMessage, sanitizePowerShellError } = require('../core/win-ps.cjs');
const { analyzeDiagnostics, detectProxyTunAdapters } = require('../core/diagnostics.cjs');

test('verifyProcessIdentity enforces PID, processName=tailscaled, and exact StartTime/CIM ticks', () => {
  const rec = {
    pid: 4321,
    processName: 'tailscaled',
    startTicks: '638900000000000000',
    cimTicks: '638900000000000001',
  };
  assert.equal(validateProcessRecord(rec), true);
  assert.equal(verifyProcessIdentity(rec, { exists: true, processName: 'tailscaled', startTicks: '638900000000000000' }), true);
  assert.equal(verifyProcessIdentity(rec, { exists: true, processName: 'tailscaled.exe', startTicks: '', cimTicks: '638900000000000001' }), true);
  assert.equal(verifyProcessIdentity(rec, { exists: true, processName: 'notepad', startTicks: '638900000000000000' }), false);
  assert.equal(verifyProcessIdentity(rec, { exists: true, processName: 'tailscaled', startTicks: '999999999999999999' }), false);
  assert.equal(verifyProcessIdentity(rec, { exists: false }), false);
});

test('stopDaemon refuses to kill when elevated script detects PID reuse / identity mismatch (exit code 3)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-proc-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'run'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'run', 'process.json'), JSON.stringify({
      pid: 7788,
      processName: 'tailscaled',
      startTicks: '638900000000000000',
      cimTicks: '638900000000000000',
      tun: 'Tailscale',
    }));

    const daemon = createDaemonManager({
      dataDir: tmpDir,
      ps: {
        psQuote: (s) => `'${s}'`,
        runPowerShell: async () => JSON.stringify({
          exists: true,
          pid: 7788,
          processName: 'tailscaled',
          startTicks: '638900000000000000',
          cimTicks: '638900000000000000',
        }),
        runElevatedPowerShell: async () => 3,
      },
    });

    await assert.rejects(() => daemon.stopDaemon({}), /防止误杀/);
    assert.equal(fs.existsSync(path.join(tmpDir, 'run', 'process.json')), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('startDaemon blocks when official Tailscale service or external tailscaled.exe is running', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-conf-'));
  try {
    let elevatedCalled = false;
    const daemon = createDaemonManager({
      dataDir: tmpDir,
      ps: {
        psQuote: (s) => `'${s}'`,
        runPowerShell: async () => JSON.stringify({
          serviceStatus: 'Running',
          processes: [{ pid: 1001, commandLine: 'tailscaled.exe' }],
          adapters: [],
        }),
        runElevatedPowerShell: async () => {
          elevatedCalled = true;
          return 0;
        },
      },
    });

    await assert.rejects(
      () => daemon.startDaemon({
        binaryInfo: { ready: true, dir: tmpDir, tailscaledPath: path.join(tmpDir, 'tailscaled.exe') },
        config: { udpPort: 0, noLogsNoSupport: true },
      }),
      /原版 Tailscale 服务正在运行/,
    );
    assert.equal(elevatedCalled, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('isUacCancelledMessage and diagnostics detect UAC cancellation and proxy TUN adapters', () => {
  assert.equal(isUacCancelledMessage('The operation was canceled by the user. (1223)'), true);
  assert.equal(isUacCancelledMessage('操作已被用户取消'), true);
  assert.equal(isUacCancelledMessage('Access is denied'), false);

  const tunHits = detectProxyTunAdapters([
    { Name: 'Tailscale', InterfaceDescription: 'Wintun Userspace Tunnel', Status: 'Up' },
    { Name: 'Mihomo', InterfaceDescription: 'Meta Tunnel', Status: 'Up' },
    { Name: 'Clash', InterfaceDescription: 'Clash Tunnel', Status: 'Down' },
  ]);
  assert.deepEqual(tunHits, ['Mihomo']);

  const hints = analyzeDiagnostics({
    status: { phase: 'connected', tun: false, tunWarning: true, health: [], summary: { onlinePeers: 1, directPeers: 0, derpPeers: 1 } },
    conflicts: { officialServiceRunning: false, externalProcesses: [] },
    binaryInfo: { ready: true, missing: [] },
    adapters: [{ Name: 'Mihomo', InterfaceDescription: 'Meta Tunnel', Status: 'Up' }],
    logs: [],
  });
  assert.equal(hints.some((h) => h.id === 'tun-disabled'), true);
  assert.equal(hints.some((h) => h.id === 'proxy-tun-conflict'), true);
  assert.equal(hints.some((h) => h.id === 'derp-only'), true);
});

test('sanitizePowerShellError strips base64 EncodedCommand and formats timeouts clearly', () => {
  const raw = 'Command failed: C:\\windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -EncodedCommand JABQAHIAbwBnAHIAZQBzAHMA';
  const cleaned = sanitizePowerShellError(raw, { killed: true, signal: 'SIGTERM' });
  assert.equal(cleaned.includes('JABQ'), false);
  assert.match(cleaned, /管理员操作超时/);

  const nonTimeout = sanitizePowerShellError(`${raw}\nactual problem`);
  assert.equal(nonTimeout.includes('JABQ'), false);
  assert.match(nonTimeout, /actual problem/);
});

test('isOwnOrphanCommandLine matches only plugin pipe+statedir and startDaemon adopts single orphan cleanly', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-adopt-'));
  try {
    const stateDir = path.join(tmpDir, 'state');
    const ownCmd = `"C:\\bin\\tailscaled.exe" --statedir=${stateDir} --socket=\\\\.\\pipe\\ProtectedPrefix\\Administrators\\QingxiaTailscale\\tailscaled --tun=Tailscale`;
    const officialCmd = `"C:\\Program Files\\Tailscale\\tailscaled.exe" --statedir=C:\\ProgramData\\Tailscale`;

    assert.equal(isOwnOrphanCommandLine(ownCmd, { stateDir }), true);
    assert.equal(isOwnOrphanCommandLine(officialCmd, { stateDir }), false);

    let elevatedCalled = false;
    const daemon = createDaemonManager({
      dataDir: tmpDir,
      ps: {
        psQuote: (s) => `'${s}'`,
        runPowerShell: async (script) => {
          if (script.includes('Get-Service')) {
            return JSON.stringify({
              serviceStatus: 'Stopped',
              processes: [{ pid: 9911, commandLine: ownCmd }],
              adapters: [],
            });
          }
          return JSON.stringify({
            exists: true,
            pid: 9911,
            processName: 'tailscaled',
            startTicks: '638900000000000000',
            cimTicks: '638900000000000000',
          });
        },
        runElevatedPowerShell: async () => {
          elevatedCalled = true;
          return 0;
        },
      },
    });

    const rec = await daemon.startDaemon({
      binaryInfo: { ready: true, dir: tmpDir, tailscaledPath: path.join(tmpDir, 'tailscaled.exe') },
      config: { udpPort: 0, noLogsNoSupport: true },
    });
    assert.equal(elevatedCalled, false);
    assert.equal(rec.pid, 9911);
    assert.equal(fs.existsSync(path.join(tmpDir, 'run', 'process.json')), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('startInteractiveUp passes --unattended so tailscaled stays connected after CLI exits', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-up-'));
  try {
    let capturedArgs = null;
    const daemon = createDaemonManager({
      dataDir: tmpDir,
      ps: { psQuote: (s) => `'${s}'` },
      spawnImpl: (_exe, args) => {
        capturedArgs = args;
        return {
          killed: false,
          stdout: { on: () => {} },
          stderr: { on: () => {} },
          on: (evt, cb) => {
            if (evt === 'close') setImmediate(() => cb(0));
          },
          kill: () => {},
        };
      },
    });
    const task = daemon.startInteractiveUp({
      tailscalePath: 'tailscale.exe',
      config: { acceptDns: true },
      authKey: 'tskey-auth-test123',
    });
    await task.promise;
    assert.equal(capturedArgs.includes('up'), true);
    assert.equal(capturedArgs.includes('--unattended'), true);
    assert.equal(capturedArgs.includes('--auth-key=tskey-auth-test123'), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sanitizePowerShellError strips NUL bytes and maps CLR HRESULT 80004005', () => {
  const utf16Garbled = '\u0000C\u0000L\u0000R\u0000 \u0000H\u0000R\u0000E\u0000S\u0000U\u0000L\u0000T\u0000 \u000080004005';
  const msg = sanitizePowerShellError(utf16Garbled);
  assert.equal(msg.includes('\u0000'), false);
  assert.match(msg, /HRESULT 80004005/);
});

test('getProcessState({ lightweight: true }) avoids PowerShell when PID is alive and falls back when dead', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-lw-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'run'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'run', 'process.json'), JSON.stringify({
      pid: 4242,
      processName: 'tailscaled',
      startTicks: '638900000000000000',
      cimTicks: '638900000000000000',
      tun: 'Tailscale',
    }));

    let psCalls = 0;
    let alive = true;
    const daemon = createDaemonManager({
      dataDir: tmpDir,
      isPidAliveImpl: () => alive,
      ps: {
        psQuote: (s) => `'${s}'`,
        runPowerShell: async () => {
          psCalls += 1;
          return JSON.stringify({ exists: false });
        },
      },
    });

    const first = await daemon.getProcessState({ lightweight: true });
    assert.equal(first.running, true);
    assert.equal(first.record.pid, 4242);
    assert.equal(psCalls, 0);

    alive = false;
    const second = await daemon.getProcessState({ lightweight: true });
    assert.equal(second.running, false);
    assert.equal(psCalls, 1);
    assert.equal(fs.existsSync(path.join(tmpDir, 'run', 'process.json')), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
