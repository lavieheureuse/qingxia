'use strict';

// 守护进程生命周期管理：严格进程身份核验（PID + 进程名 + StartTime.Ticks / CIM CreationDate）、Win32 提权启动、冲突检测与无提权 CLI 通信。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { DEFAULT_SOCKET, DEFAULT_TUN, readJsonSafe, writeJsonAtomicSync } = require('./config.cjs');
const { redactText, redactArgs } = require('./redact.cjs');

const execFileAsync = promisify(execFile);

function validateProcessRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (!Number.isInteger(record.pid) || record.pid <= 0) return false;
  if (typeof record.processName !== 'string' || record.processName.toLowerCase() !== 'tailscaled') return false;
  if (typeof record.startTicks !== 'string' || !/^\d+$/.test(record.startTicks)) return false;
  if (record.cimTicks !== undefined && (typeof record.cimTicks !== 'string' || !/^\d+$/.test(record.cimTicks))) return false;
  return true;
}

function verifyProcessIdentity(record, snapshot) {
  if (!validateProcessRecord(record) || !snapshot || !snapshot.exists) return false;
  const name = String(snapshot.processName || '').replace(/\.exe$/i, '').toLowerCase();
  if (name !== 'tailscaled') return false;
  if (snapshot.startTicks && /^\d+$/.test(String(snapshot.startTicks))) {
    return String(snapshot.startTicks) === record.startTicks;
  }
  if (snapshot.cimTicks && record.cimTicks && /^\d+$/.test(String(record.cimTicks))) {
    return String(snapshot.cimTicks) === record.cimTicks;
  }
  return false;
}

function isOwnOrphanCommandLine(commandLine, { socket = DEFAULT_SOCKET, stateDir = '' } = {}) {
  if (typeof commandLine !== 'string' || !commandLine || !stateDir) return false;
  const normCmd = commandLine.toLowerCase();
  const hasSocket = normCmd.includes(`--socket=${String(socket).toLowerCase()}`);
  const hasState = normCmd.includes(`--statedir=${String(stateDir).toLowerCase()}`);
  return hasSocket && hasState;
}

function readTailLines(filePath, maxLines = 120) {
  try {
    const stat = fs.statSync(filePath);
    const maxBytes = 64 * 1024;
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, 'r');
    try {
      const len = stat.size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      const lines = buf.toString('utf8').split(/\r?\n/).filter(Boolean);
      return lines.slice(-maxLines).map((line) => redactText(line));
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return [];
  }
}

function isPidAliveFast(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

function createDaemonManager({ dataDir, ps, execFileImpl = execFile, spawnImpl = spawn, isPidAliveImpl = isPidAliveFast, logger = () => {} }) {
  if (!dataDir) throw new Error('dataDir 不能为空');
  if (!ps) throw new Error('ps 工具模块不能为空');

  const runDir = path.join(dataDir, 'run');
  const stateDir = path.join(dataDir, 'state');
  const logsDir = path.join(dataDir, 'logs');
  const processFile = path.join(runDir, 'process.json');
  const stdoutLogFile = path.join(logsDir, 'tailscaled.stdout.log');
  const stderrLogFile = path.join(logsDir, 'tailscaled.stderr.log');
  const execPromise = execFileImpl === execFile ? execFileAsync : promisify(execFileImpl);

  function ensureDirs() {
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });
  }

  function readProcessRecord() {
    const rec = readJsonSafe(processFile, null);
    if (!rec) return null;
    if (!validateProcessRecord(rec)) {
      const err = new Error('进程状态记录已损坏，拒绝盲目操作其他进程');
      err.code = 'CORRUPT_PROCESS_RECORD';
      throw err;
    }
    return rec;
  }

  function clearProcessRecord() {
    try {
      fs.unlinkSync(processFile);
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error;
    }
  }

  async function inspectLivePid(pid) {
    const qPid = Number(pid);
    if (!Number.isInteger(qPid) || qPid <= 0) return { exists: false };
    const script = [
      `$ErrorActionPreference = 'Stop'`,
      `$p = Get-Process -Id ${qPid} -ErrorAction SilentlyContinue`,
      `if (-not $p) { '{"exists":false}'; exit 0 }`,
      `$startTicks = ''`,
      `try { $startTicks = $p.StartTime.ToUniversalTime().Ticks.ToString() } catch { $startTicks = '' }`,
      `$cimTicks = ''`,
      `$cim = Get-CimInstance Win32_Process -Filter "ProcessId=${qPid}" -ErrorAction SilentlyContinue`,
      `if ($cim -and $cim.CreationDate) { $cimTicks = $cim.CreationDate.ToUniversalTime().Ticks.ToString() }`,
      `@{ exists = $true; pid = $p.Id; processName = $p.ProcessName; startTicks = $startTicks; cimTicks = $cimTicks } | ConvertTo-Json -Compress`,
    ].join('; ');
    const out = await ps.runPowerShell(script, { timeout: 15000 });
    return out ? JSON.parse(out) : { exists: false };
  }

  async function getProcessState({ lightweight = false } = {}) {
    const saved = readProcessRecord();
    if (!saved) return { running: false, record: null };
    if (lightweight && isPidAliveImpl(saved.pid)) {
      return { running: true, record: saved };
    }
    const snap = await inspectLivePid(saved.pid);
    if (!snap.exists) {
      clearProcessRecord();
      return { running: false, record: null };
    }
    if (verifyProcessIdentity(saved, snap)) {
      return { running: true, record: saved };
    }
    if (!snap.startTicks && !snap.cimTicks) {
      throw new Error(`无法核验 PID ${saved.pid} 的启动时间，请检查系统权限`);
    }
    clearProcessRecord();
    return { running: false, record: null };
  }

  async function checkConflicts(ownPid = null) {
    const script = [
      `$ErrorActionPreference = 'Stop'`,
      `$svc = Get-Service -Name 'Tailscale' -ErrorAction SilentlyContinue`,
      `$svcStatus = if ($svc) { $svc.Status.ToString() } else { '' }`,
      `$procs = @(Get-CimInstance Win32_Process -Filter "Name='tailscaled.exe'" -ErrorAction SilentlyContinue | ForEach-Object { @{ pid = [int]$_.ProcessId; commandLine = [string]$_.CommandLine } })`,
      `$adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' } | ForEach-Object { @{ Name = $_.Name; InterfaceDescription = $_.InterfaceDescription; Status = $_.Status.ToString() } })`,
      `@{ serviceStatus = $svcStatus; processes = $procs; adapters = $adapters } | ConvertTo-Json -Depth 4 -Compress`,
    ].join('; ');
    const raw = await ps.runPowerShell(script, { timeout: 20000 });
    const parsed = raw ? JSON.parse(raw) : {};
    const processes = Array.isArray(parsed.processes) ? parsed.processes : [];
    const others = processes.filter((p) => Number.isInteger(p.pid) && p.pid !== ownPid);
    const ownOrphanProcesses = others.filter((p) => isOwnOrphanCommandLine(p.commandLine, { socket: DEFAULT_SOCKET, stateDir }));
    const externalProcesses = others.filter((p) => !isOwnOrphanCommandLine(p.commandLine, { socket: DEFAULT_SOCKET, stateDir }));
    const serviceStatus = String(parsed.serviceStatus || '');
    const officialServiceRunning = serviceStatus.toLowerCase() === 'running';
    return {
      hasConflict: officialServiceRunning || externalProcesses.length > 0,
      officialServiceRunning,
      officialServiceStatus: serviceStatus,
      externalProcesses,
      ownOrphanProcesses,
      adapters: Array.isArray(parsed.adapters) ? parsed.adapters : [],
    };
  }

  async function startDaemon({ binaryInfo, config }) {
    if (!binaryInfo || !binaryInfo.ready) {
      throw new Error('缺少 Tailscale 核心文件（tailscaled.exe / tailscale.exe / wintun.dll）');
    }
    ensureDirs();
    const current = await getProcessState();
    if (current.running) {
      return current.record;
    }

    const conflicts = await checkConflicts(null);
    if (conflicts.officialServiceRunning) {
      const err = new Error('检测到系统原版 Tailscale 服务正在运行，请先停止原版服务后再由本插件启动，避免虚拟网卡冲突。');
      err.code = 'CONFLICT_OFFICIAL_SERVICE';
      throw err;
    }
    if (conflicts.externalProcesses.length > 0) {
      const pids = conflicts.externalProcesses.map((p) => p.pid).join(', ');
      const err = new Error(`检测到外部 tailscaled 进程（PID: ${pids}），请先手动退出后再启动。`);
      err.code = 'CONFLICT_EXTERNAL_PROCESS';
      throw err;
    }

    const socket = DEFAULT_SOCKET;
    const tun = DEFAULT_TUN;

    // 仅当存在单个完全匹配本插件专属 pipe 与 statedir 的遗留 tailscaled 实例时安全接管，避免重复启动
    if (conflicts.ownOrphanProcesses && conflicts.ownOrphanProcesses.length === 1) {
      const orphan = conflicts.ownOrphanProcesses[0];
      const snap = await inspectLivePid(orphan.pid);
      if (snap.exists && String(snap.processName || '').replace(/\.exe$/i, '').toLowerCase() === 'tailscaled' && (snap.startTicks || snap.cimTicks)) {
        const adopted = {
          pid: orphan.pid,
          processName: 'tailscaled',
          startTicks: snap.startTicks || snap.cimTicks,
          cimTicks: snap.cimTicks || snap.startTicks || '',
          socket,
          statedir: stateDir,
          tun,
          exePath: binaryInfo.tailscaledPath,
          startedAt: new Date().toISOString(),
        };
        writeJsonAtomicSync(processFile, adopted);
        logger('info', `检测到本插件残留的隔离 tailscaled 实例（PID ${adopted.pid}），已自动恢复接管`);
        return adopted;
      }
    }

    const port = Number.isInteger(config && config.udpPort) ? config.udpPort : 0;
    const daemonArgs = [
      `--statedir=${stateDir}`,
      `--socket=${socket}`,
      `--tun=${tun}`,
      `--port=${port}`,
    ];
    if (!config || config.noLogsNoSupport !== false) {
      daemonArgs.push('--no-logs-no-support');
    }

    const handshakeFile = path.join(runDir, `launch-${crypto.randomUUID()}.json`);
    const cmdLine = [binaryInfo.tailscaledPath, ...daemonArgs]
      .map((part) => `"${String(part).replace(/"/g, '\\"')}"`)
      .join(' ');

    try {
      fs.writeFileSync(stdoutLogFile, '', 'utf8');
      fs.writeFileSync(stderrLogFile, '', 'utf8');
    } catch (_) {
      /* ignore log truncation errors */
    }

    // 注意：PowerShell 5.1 的 Start-Process -RedirectStandardOutput 会阻塞等待子进程退出；
    // 而普通 CreateProcessW(bInheritHandles=true) 会让子进程顺带继承 PowerShell 的标准输出管道，导致外层依然卡死超时。
    // 因此必须使用 STARTUPINFOEX + PROC_THREAD_ATTRIBUTE_HANDLE_LIST，显式只继承 hOut/hErr 两个日志文件句柄。
    const inner = [
      `$ErrorActionPreference = 'Stop'`,
      `$cs = @'`,
      `using System;`,
      `using System.Runtime.InteropServices;`,
      `public static class TsDetachedLauncher {`,
      `  [StructLayout(LayoutKind.Sequential)] public struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }`,
      `  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }`,
      `  [StructLayout(LayoutKind.Sequential)] public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }`,
      `  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }`,
      `  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, ref SECURITY_ATTRIBUTES lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);`,
      `  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);`,
      `  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr Attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);`,
      `  [DllImport("kernel32.dll", SetLastError = true)] static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);`,
      `  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFOEX lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);`,
      `  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr hObject);`,
      `  public static int Launch(string exe, string cmdLine, string workDir, string stdoutPath, string stderrPath) {`,
      `    var sa = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = true };`,
      `    IntPtr invalid = new IntPtr(-1);`,
      `    IntPtr hOut = CreateFileW(stdoutPath, 0x40000000u, 7u, ref sa, 2u, 0x80u, IntPtr.Zero);`,
      `    IntPtr hErr = CreateFileW(stderrPath, 0x40000000u, 7u, ref sa, 2u, 0x80u, IntPtr.Zero);`,
      `    if (hOut == invalid || hErr == invalid) { int e = Marshal.GetLastWin32Error(); if (hOut != invalid) CloseHandle(hOut); if (hErr != invalid) CloseHandle(hErr); throw new InvalidOperationException("打开日志文件失败: " + e); }`,
      `    IntPtr lpSize = IntPtr.Zero;`,
      `    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref lpSize);`,
      `    IntPtr attrList = Marshal.AllocHGlobal(lpSize);`,
      `    IntPtr[] handles = new IntPtr[] { hOut, hErr };`,
      `    GCHandle pin = GCHandle.Alloc(handles, GCHandleType.Pinned);`,
      `    bool attrInited = false;`,
      `    try {`,
      `      if (!InitializeProcThreadAttributeList(attrList, 1, 0, ref lpSize)) throw new InvalidOperationException("InitializeProcThreadAttributeList 失败: " + Marshal.GetLastWin32Error());`,
      `      attrInited = true;`,
      `      if (!UpdateProcThreadAttribute(attrList, 0, new IntPtr(0x00020002), pin.AddrOfPinnedObject(), new IntPtr(IntPtr.Size * handles.Length), IntPtr.Zero, IntPtr.Zero)) throw new InvalidOperationException("UpdateProcThreadAttribute 失败: " + Marshal.GetLastWin32Error());`,
      `      var siEx = new STARTUPINFOEX();`,
      `      siEx.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));`,
      `      siEx.StartupInfo.dwFlags = 0x101;`,
      `      siEx.StartupInfo.wShowWindow = 0;`,
      `      siEx.StartupInfo.hStdInput = IntPtr.Zero;`,
      `      siEx.StartupInfo.hStdOutput = hOut;`,
      `      siEx.StartupInfo.hStdError = hErr;`,
      `      siEx.lpAttributeList = attrList;`,
      `      PROCESS_INFORMATION pi;`,
      `      bool ok = CreateProcessW(exe, cmdLine, IntPtr.Zero, IntPtr.Zero, true, 0x08080000u, IntPtr.Zero, workDir, ref siEx, out pi);`,
      `      int err = ok ? 0 : Marshal.GetLastWin32Error();`,
      `      if (!ok) throw new InvalidOperationException("CreateProcessW 失败: " + err);`,
      `      CloseHandle(pi.hThread); CloseHandle(pi.hProcess);`,
      `      return pi.dwProcessId;`,
      `    } finally {`,
      `      if (pin.IsAllocated) pin.Free();`,
      `      if (attrInited) DeleteProcThreadAttributeList(attrList);`,
      `      Marshal.FreeHGlobal(attrList);`,
      `      CloseHandle(hOut); CloseHandle(hErr);`,
      `    }`,
      `  }`,
      `}`,
      `'@`,
      `Add-Type -TypeDefinition $cs -Language CSharp`,
      `$exe = ${ps.psQuote(binaryInfo.tailscaledPath)}`,
      `$binDir = ${ps.psQuote(binaryInfo.dir)}`,
      `$cmd = ${ps.psQuote(cmdLine)}`,
      `$stdout = ${ps.psQuote(stdoutLogFile)}`,
      `$stderr = ${ps.psQuote(stderrLogFile)}`,
      `$handshake = ${ps.psQuote(handshakeFile)}`,
      `$launchedPid = [TsDetachedLauncher]::Launch($exe, $cmd, $binDir, $stdout, $stderr)`,
      `Start-Sleep -Milliseconds 1500`,
      `$p = Get-Process -Id $launchedPid -ErrorAction SilentlyContinue`,
      `if (-not $p -or $p.HasExited) {`,
      `  $tail = if (Test-Path -LiteralPath $stderr) { (Get-Content -LiteralPath $stderr -Tail 6 -ErrorAction SilentlyContinue) -join ' | ' } else { '' }`,
      `  throw "tailscaled 启动后立即退出：$tail"`,
      `}`,
      `$startTicks = $p.StartTime.ToUniversalTime().Ticks.ToString()`,
      `$cim = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)" -ErrorAction SilentlyContinue`,
      `$cimTicks = if ($cim -and $cim.CreationDate) { $cim.CreationDate.ToUniversalTime().Ticks.ToString() } else { '' }`,
      `$payload = @{ pid = [int]$p.Id; processName = [string]$p.ProcessName; startTicks = $startTicks; cimTicks = $cimTicks; exePath = $exe } | ConvertTo-Json -Compress`,
      `[IO.File]::WriteAllText($handshake, $payload, [Text.UTF8Encoding]::new($false))`,
      `return 0`,
    ].join('\n');

    logger('info', `启动 tailscaled（Wintun 虚拟网卡模式：${tun}）`);
    try {
      const code = await ps.runElevatedPowerShell(inner, { timeout: 60000, tempDir: runDir });
      if (code !== 0) {
        throw new Error(`管理员启动脚本返回退出码 ${code}`);
      }
      const launchData = readJsonSafe(handshakeFile, null);
      if (!launchData || !validateProcessRecord(launchData)) {
        throw new Error('tailscaled 可能已启动，但未能读取到有效进程身份信息');
      }
      const record = {
        pid: launchData.pid,
        processName: 'tailscaled',
        startTicks: launchData.startTicks,
        cimTicks: launchData.cimTicks || '',
        socket,
        statedir: stateDir,
        tun,
        exePath: binaryInfo.tailscaledPath,
        startedAt: new Date().toISOString(),
      };
      writeJsonAtomicSync(processFile, record);
      logger('info', `tailscaled 已启动（PID ${record.pid}，独立管道 ${socket}）`);
      return record;
    } finally {
      try {
        fs.unlinkSync(handshakeFile);
      } catch (_) {
        /* ignore */
      }
    }
  }

  async function runCli(tailscalePath, args = [], options = {}) {
    if (!tailscalePath) throw new Error('未找到 tailscale.exe');
    const fullArgs = [`--socket=${DEFAULT_SOCKET}`, ...args];
    const timeout = Number.isInteger(options.timeout) ? options.timeout : 20000;
    try {
      const res = await execPromise(tailscalePath, fullArgs, {
        windowsHide: true,
        timeout,
        encoding: 'utf8',
      });
      return {
        exitCode: 0,
        stdout: String(res.stdout || ''),
        stderr: String(res.stderr || ''),
      };
    } catch (error) {
      const stdout = String((error && error.stdout) || '');
      const stderr = String((error && error.stderr) || '');
      if (options.allowNonZero) {
        return {
          exitCode: Number.isInteger(error && error.code) ? error.code : 1,
          stdout,
          stderr,
        };
      }
      const msg = redactText(stderr.trim() || stdout.trim() || (error && error.message) || 'CLI 执行失败');
      throw new Error(`tailscale ${redactArgs(args).join(' ')} 失败：${msg}`);
    }
  }

  function startInteractiveUp({ tailscalePath, config, authKey, onAuthUrl, onLog }) {
    // Windows 非服务模式必须传递 --unattended，否则 tailscale up 退出后 tailscaled 会判定客户端断开并停止隧道
    const args = [`--socket=${DEFAULT_SOCKET}`, 'up', '--unattended'];
    if (config && config.hostname) args.push(`--hostname=${config.hostname}`);
    if (config && config.loginServer) args.push(`--login-server=${config.loginServer}`);
    if (config && config.acceptDns === false) args.push('--accept-dns=false');
    if (authKey) args.push(`--auth-key=${authKey}`);
    args.push(authKey ? '--timeout=30s' : '--timeout=8s');

    logger('info', `执行 tailscale ${redactArgs(args.slice(1)).join(' ')}`);
    const child = spawnImpl(tailscalePath, args, { windowsHide: true });

    let stderrBuf = '';
    let stdoutBuf = '';
    let cancelled = false;
    let settled = false;

    const handleChunk = (chunk, isErr) => {
      const text = chunk.toString('utf8');
      if (isErr) stderrBuf += text;
      else stdoutBuf += text;
      const urlMatch = /https:\/\/[^\s"'`<>]+/i.exec(text);
      if (urlMatch && typeof onAuthUrl === 'function') {
        onAuthUrl(urlMatch[0].replace(/[),.;]+$/, ''));
      }
      const lines = text.split(/\r?\n/).map((l) => redactText(l.trim())).filter(Boolean);
      for (const line of lines) {
        if (typeof onLog === 'function') onLog(line);
      }
    };

    if (child.stdout) child.stdout.on('data', (c) => handleChunk(c, false));
    if (child.stderr) child.stderr.on('data', (c) => handleChunk(c, true));

    const promise = new Promise((resolve, reject) => {
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(new Error(`启动 tailscale up 失败：${redactText(error.message)}`));
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        if (cancelled) {
          resolve({ cancelled: true, stdout: stdoutBuf, stderr: stderrBuf });
          return;
        }
        if (code === 0) {
          resolve({ cancelled: false, stdout: stdoutBuf, stderr: stderrBuf });
          return;
        }
        const combined = redactText(`${stderrBuf}\n${stdoutBuf}`.trim());
        reject(new Error(combined || `tailscale up 退出（退出码 ${code}）`));
      });
    });

    return {
      promise,
      cancel() {
        cancelled = true;
        try {
          if (!child.killed) child.kill();
        } catch (_) {
          /* ignore */
        }
      },
    };
  }

  async function stopDaemon({ binaryInfo } = {}) {
    const current = await getProcessState();
    if (!current.running || !current.record) {
      return { stopped: true, wasRunning: false };
    }
    const saved = current.record;
    const tailscalePath = binaryInfo && binaryInfo.tailscalePath;
    if (tailscalePath && fs.existsSync(tailscalePath)) {
      try {
        await runCli(tailscalePath, ['down'], { timeout: 3500, allowNonZero: true });
      } catch (_) {
        /* best-effort down before terminating */
      }
    }

    const exeForCleanup = saved.exePath || (binaryInfo && binaryInfo.tailscaledPath) || '';
    const inner = [
      `$ErrorActionPreference = 'Stop'`,
      `$p = Get-Process -Id ${saved.pid} -ErrorAction SilentlyContinue`,
      `if (-not $p) { return 0 }`,
      `if ($p.ProcessName -ine 'tailscaled' -or $p.StartTime.ToUniversalTime().Ticks.ToString() -ne ${ps.psQuote(saved.startTicks)}) { return 3 }`,
      `Stop-Process -Id ${saved.pid} -Force -ErrorAction Stop`,
      `try { $p.WaitForExit(5000) | Out-Null } catch {}`,
      exeForCleanup
        ? `if (Test-Path -LiteralPath ${ps.psQuote(exeForCleanup)}) { try { & ${ps.psQuote(exeForCleanup)} --cleanup --tun=${ps.psQuote(saved.tun || DEFAULT_TUN)} | Out-Null } catch {} }`
        : '',
      `return 0`,
    ].filter(Boolean).join('\n');

    logger('info', `正在停止 tailscaled（PID ${saved.pid}）并清理虚拟网卡状态`);
    const exitCode = await ps.runElevatedPowerShell(inner, { timeout: 60000, tempDir: runDir });
    if (exitCode === 3) {
      throw new Error(`PID ${saved.pid} 已不是本插件启动的 tailscaled 实例，已拒绝结束以防止误杀`);
    }
    if (exitCode !== 0) {
      throw new Error(`停止 tailscaled 失败（退出码 ${exitCode}）`);
    }

    const after = await inspectLivePid(saved.pid);
    if (after.exists && verifyProcessIdentity(saved, after)) {
      throw new Error(`tailscaled 进程（PID ${saved.pid}）仍在运行，未能确认已停止`);
    }
    clearProcessRecord();
    logger('info', `tailscaled（PID ${saved.pid}）已停止，Wintun 状态已清理`);
    return { stopped: true, wasRunning: true };
  }

  function readDaemonLogs(maxLines = 120) {
    return {
      stdout: readTailLines(stdoutLogFile, maxLines),
      stderr: readTailLines(stderrLogFile, maxLines),
    };
  }

  function clearDaemonLogs() {
    for (const file of [stdoutLogFile, stderrLogFile]) {
      try {
        if (fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8');
      } catch (_) {
        /* ignore */
      }
    }
  }

  return {
    runDir,
    stateDir,
    logsDir,
    processFile,
    readProcessRecord,
    clearProcessRecord,
    getProcessState,
    checkConflicts,
    startDaemon,
    stopDaemon,
    runCli,
    startInteractiveUp,
    readDaemonLogs,
    clearDaemonLogs,
  };
}

module.exports = {
  validateProcessRecord,
  verifyProcessIdentity,
  isOwnOrphanCommandLine,
  isPidAliveFast,
  createDaemonManager,
};
