'use strict';

// Windows PowerShell 执行、UAC 提权、DPAPI 加密保护与安全外链启动封装。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const POWERSHELL_EXE = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function encodePsCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

function isUacCancelledMessage(message) {
  const text = String(message || '').toLowerCase();
  return text.includes('1223')
    || text.includes('canceled by the user')
    || text.includes('cancelled by the user')
    || text.includes('用户已取消')
    || text.includes('操作已被用户取消');
}

function sanitizePowerShellError(raw, errorObj) {
  const cleanedRaw = String(raw || '')
    .replace(/\u0000/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ');
  const text = cleanedRaw.trim();
  if (isUacCancelledMessage(text)) {
    return '管理员授权已被取消，请在系统 UAC 弹窗中点击“是”以继续操作';
  }
  if (/CLR/i.test(text) && /80004005/i.test(text)) {
    return 'Windows PowerShell (.NET CLR) 初始化失败（HRESULT 80004005），系统资源紧张，请稍后重试或重启轻匣';
  }
  if ((errorObj && (errorObj.killed || errorObj.signal === 'SIGTERM')) || /timed?\s*out/i.test(text)) {
    return '管理员操作超时，请确认是否已通过系统 UAC 授权窗口后重试';
  }
  let cleaned = text
    .replace(/Command failed:\s*[^\r\n]*powershell\.exe[^\r\n]*/gi, '')
    .replace(/-EncodedCommand\s+[A-Za-z0-9+/=]+/gi, '-EncodedCommand <...>')
    .replace(/\r?\n+/g, ' ')
    .trim();
  if (!cleaned) cleaned = 'PowerShell 执行失败';
  return cleaned.slice(0, 320);
}

async function runPowerShell(script, options = {}) {
  const timeout = Number.isInteger(options.timeout) ? options.timeout : 60000;
  const wrapped = `$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); try { ${script} } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
  try {
    const res = await execFileAsync(
      POWERSHELL_EXE,
      ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', encodePsCommand(wrapped)],
      { windowsHide: true, timeout, encoding: 'utf8' },
    );
    return String(res.stdout || '').trim();
  } catch (error) {
    const rawDetail = String((error && error.stderr) || (error && error.message) || error).trim();
    const cleanMsg = sanitizePowerShellError(rawDetail, error);
    const wrappedErr = new Error(cleanMsg);
    if (isUacCancelledMessage(rawDetail)) wrappedErr.code = 'UAC_CANCELLED';
    throw wrappedErr;
  }
}

async function runElevatedPowerShell(innerScript, options = {}) {
  const timeout = Number.isInteger(options.timeout) ? options.timeout : 30000;
  const tempDir = options.tempDir || os.tmpdir();
  fs.mkdirSync(tempDir, { recursive: true });
  const id = crypto.randomUUID();
  const scriptPath = path.join(tempDir, `elevated-${id}.ps1`);
  const donePath = path.join(tempDir, `elevated-${id}.done`);
  const errPath = path.join(tempDir, `elevated-${id}.err`);

  const wrappedInner = [
    `$ProgressPreference = 'SilentlyContinue'`,
    `$exitCode = 0`,
    `try {`,
    `  $ret = & {`,
    innerScript,
    `  }`,
    `  if ($ret -is [int]) { $exitCode = $ret }`,
    `} catch {`,
    `  $msg = $_.Exception.Message`,
    `  try { [IO.File]::WriteAllText(${psQuote(errPath)}, [string]$msg, [Text.UTF8Encoding]::new($false)) } catch {}`,
    `  $exitCode = 1`,
    `} finally {`,
    `  try { [IO.File]::WriteAllText(${psQuote(donePath)}, [string]$exitCode, [Text.UTF8Encoding]::new($false)) } catch {}`,
    `}`,
    `exit $exitCode`,
  ].join('\r\n');

  // 写入 UTF-8 BOM，保证 Windows PowerShell 5.1 正确识别中文字符
  const contentBuf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(wrappedInner, 'utf8')]);
  fs.writeFileSync(scriptPath, contentBuf);

  try {
    const argStr = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${scriptPath}"`;
    // 注意：不能加 -Wait，因为 Windows PowerShell 5.1 的 Start-Process -Wait 会死等提权进程拉起的子进程句柄；
    // UAC 授权本身会阻塞在 Start-Process 调用期间（拒绝立即抛 1223），通过后立即返回，再由 Node 轮询 .done 完成信号文件。
    const outer = `$ErrorActionPreference = 'Stop'; $p = Start-Process -FilePath ${psQuote(POWERSHELL_EXE)} -ArgumentList ${psQuote(argStr)} -Verb RunAs -WindowStyle Hidden -PassThru; $p.Id`;
    await runPowerShell(outer, { timeout });

    const deadline = Date.now() + timeout;
    while (!fs.existsSync(donePath)) {
      if (Date.now() >= deadline) {
        throw new Error('管理员操作超时，请确认是否已通过系统 UAC 授权窗口后重试');
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    const doneText = fs.readFileSync(donePath, 'utf8').trim();
    const exitCode = Number.parseInt(doneText, 10);
    if (!Number.isInteger(exitCode)) {
      throw new Error(`无法确认管理员操作结果（输出：${doneText || '空'}）`);
    }
    if (exitCode !== 0 && fs.existsSync(errPath)) {
      const innerErr = fs.readFileSync(errPath, 'utf8').trim();
      if (innerErr) {
        const err = new Error(sanitizePowerShellError(innerErr));
        err.exitCode = exitCode;
        throw err;
      }
    }
    return exitCode;
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (_) { /* ignore */ }
    try { fs.unlinkSync(donePath); } catch (_) { /* ignore */ }
    try { fs.unlinkSync(errPath); } catch (_) { /* ignore */ }
  }
}

function dpapiTransform(value, decrypt) {
  const operation = decrypt ? 'Unprotect' : 'Protect';
  const input = decrypt
    ? '[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())'
    : '[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())';
  const output = decrypt
    ? '[Text.Encoding]::UTF8.GetString($result)'
    : '[Convert]::ToBase64String($result)';
  const script = `Add-Type -AssemblyName System.Security; $bytes=${input}; $result=[Security.Cryptography.ProtectedData]::${operation}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); ${output}`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      POWERSHELL_EXE,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePsCommand(script)],
      { windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Windows 凭据保护失败：${sanitizePowerShellError(stderr)}`));
    });
    child.stdin.end(String(value), 'utf8');
  });
}

function protectSecret(plaintext) {
  if (!plaintext) return Promise.resolve('');
  return dpapiTransform(plaintext, false);
}

function unprotectSecret(ciphertextBase64) {
  if (!ciphertextBase64) return Promise.resolve('');
  return dpapiTransform(ciphertextBase64, true);
}

async function openExternalHttpsUrl(safeUrl) {
  try {
    const electron = require('electron');
    if (electron && electron.shell && typeof electron.shell.openExternal === 'function') {
      await electron.shell.openExternal(safeUrl);
      return;
    }
  } catch (_) {
    /* 非 Electron 环境回退到 rundll32 */
  }
  await execFileAsync(
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe'),
    ['url.dll,FileProtocolHandler', safeUrl],
    { windowsHide: true, timeout: 10000 },
  );
}

module.exports = {
  POWERSHELL_EXE,
  psQuote,
  encodePsCommand,
  isUacCancelledMessage,
  sanitizePowerShellError,
  runPowerShell,
  runElevatedPowerShell,
  protectSecret,
  unprotectSecret,
  openExternalHttpsUrl,
};
