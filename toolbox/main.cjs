'use strict';
const { app, BrowserWindow, BrowserView, ipcMain, dialog, shell, screen, Tray, Menu, nativeImage, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { uIOhook } = require('uiohook-napi');
const { pluginDataFolder, resolvePluginDataSubdir, isLegacyPlugin, migrateSinglePluginData, migrateInstalledPluginsDataOnStartup, collectRemovablePluginDataDirs, copyPluginDataRoot, isManagedPluginDataDir } = require('./plugin-storage.cjs');

const dataRoot = path.join(app.getPath('appData'), 'qingxia');
const oldDataRoot = path.join(app.getPath('appData'), '个人工具箱');
function migrateDataDirectory() {
  if (fs.existsSync(dataRoot) || !fs.existsSync(oldDataRoot)) return;
  if (fs.lstatSync(oldDataRoot).isSymbolicLink()) throw new Error('原数据目录不能是链接');
  const config = path.join(oldDataRoot, 'toolbox.json');
  let settings;
  if (fs.existsSync(config)) {
    settings = JSON.parse(fs.readFileSync(config, 'utf8').replace(/^\uFEFF/, ''));
    const remap = value => {
      if (typeof value !== 'string' || !path.isAbsolute(value)) return value;
      const relative = path.relative(oldDataRoot, value);
      return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) ? path.join(dataRoot, relative) : value;
    };
    if (settings.pluginFolder) settings.pluginFolder = remap(settings.pluginFolder);
    for (const key of ['plugins', 'panel', 'independent', 'background', 'pluginStartup']) if (Array.isArray(settings[key])) settings[key] = settings[key].map(remap);
  }
  fs.renameSync(oldDataRoot, dataRoot);
  try {
    if (settings) {
      const target = path.join(dataRoot, 'toolbox.json');
      fs.writeFileSync(target + '.tmp', JSON.stringify(settings, null, 2));
      fs.renameSync(target + '.tmp', target);
    }
  } catch (error) {
    try { fs.renameSync(dataRoot, oldDataRoot); } catch (rollbackError) { console.error('恢复旧数据目录失败:', rollbackError); }
    throw error;
  }
}

if (process.argv.includes('--uninstall-ui')) {
  app.setName('轻匣');
  app.setPath('userData', !fs.existsSync(dataRoot) && fs.existsSync(oldDataRoot) ? oldDataRoot : dataRoot);
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    let choice = 3;
    const iconPath = path.join(app.isPackaged ? path.join(process.resourcesPath, 'bundle') : path.join(__dirname, 'resources'), 'app-icon.png');
    const win = new BrowserWindow({ width: 760, height: 565, minWidth: 760, minHeight: 565, resizable: false, title: '卸载轻匣', icon: iconPath, autoHideMenuBar: true, backgroundColor: '#faf8f4', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: false } });
    ipcMain.handle('toolbox', (event, action, value) => {
      if (event.sender !== win.webContents) return { ok: false, message: '无权操作' };
      if (action === 'uninstall-icon') return { ok: true, value: nativeImage.createFromPath(iconPath).toDataURL() };
      if (action === 'uninstall-choice' && [0, 2, 3].includes(value)) { choice = value; setImmediate(() => app.exit(choice)); return { ok: true }; }
      return { ok: false, message: '不支持的操作' };
    });
    win.on('closed', () => app.exit(choice));
    win.loadFile('index.html', { query: { uninstall: '1' } });
  }).catch(() => app.exit(3));
} else {

app.setName('轻匣');
try { migrateDataDirectory(); } catch (error) { console.error('迁移数据目录失败:', error); dialog.showErrorBox('轻匣无法启动', '原有数据目录无法迁移。请先退出所有轻匣进程，检查数据目录权限后重新打开。'); app.exit(1); }
app.setPath('userData', dataRoot);
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else app.on('second-instance', showMain);
const bundle = app.isPackaged ? path.join(process.resourcesPath, 'bundle') : path.join(__dirname, 'resources');
const data = app.getPath('userData');
const settingsFile = path.join(data, 'toolbox.json');
const DEFAULT_GITHUB_REPO = 'https://github.com/lavieheureuse/qingxia';
const GITHUB_RELEASES_URL = 'https://github.com/lavieheureuse/qingxia/releases';
const GITHUB_LATEST_API = 'https://api.github.com/repos/lavieheureuse/qingxia/releases/latest';
const UPDATES_DIR = path.join(data, 'updates');
let settings = { version: 1, plugins: [], panel: [], independent: [], background: [], pluginStartup: [], mainIndependent: false, middle: true, autoStart: false, autoCheckUpdate: true, skippedVersion: '' };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch (_) {}
function save() { fs.mkdirSync(data, { recursive: true }); const tmp = settingsFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(settings, null, 2)); fs.renameSync(tmp, settingsFile); }

function compareVersions(a, b) {
  const parse = raw => {
    const clean = String(raw || '').trim().replace(/^v/i, '').split(/[-+]/)[0];
    if (!clean) return null;
    const parts = clean.split('.');
    if (!parts.length || parts.some(part => !/^\d+$/.test(part))) return null;
    return parts.map(Number);
  };
  const left = parse(a), right = parse(b);
  if (!left || !right) return 0;
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const x = left[i] || 0, y = right[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function detectUpdateMode() {
  if (!app.isPackaged) return 'dev';
  if (process.env.PORTABLE_EXECUTABLE_FILE && fs.existsSync(process.env.PORTABLE_EXECUTABLE_FILE)) return 'portable';
  return 'setup';
}

function isTrustedGithubUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return host === 'github.com' || host.endsWith('.github.com') || host.endsWith('.githubusercontent.com');
  } catch (_) {
    return false;
  }
}

function httpsGetFollow(rawUrl, headers, timeoutMs, maxRedirects = 5, onAbort = null) {
  return new Promise((resolve, reject) => {
    let settled = false, currentReq = null;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(val);
    };
    if (onAbort) {
      onAbort(() => {
        if (currentReq) currentReq.destroy(new Error('已取消下载'));
        finish(new Error('已取消下载'));
      });
    }
    const visit = (target, depth) => {
      if (!isTrustedGithubUrl(target)) {
        finish(new Error('更新地址不受信任，已中止操作。'));
        return;
      }
      const req = require('node:https').get(target, { headers, timeout: timeoutMs }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (depth <= 0) {
            finish(new Error('更新地址跳转次数过多，请稍后重试。'));
            return;
          }
          let nextUrl;
          try { nextUrl = new URL(res.headers.location, target).href; }
          catch (_) { finish(new Error('更新跳转地址无效。')); return; }
          visit(nextUrl, depth - 1);
          return;
        }
        finish(null, { res, req });
      });
      currentReq = req;
      req.on('timeout', () => {
        req.destroy(new Error('连接 GitHub 超时，请检查网络后重试。'));
      });
      req.on('error', err => finish(err));
    };
    visit(rawUrl, maxRedirects);
  });
}

function cleanupUpdatesDir() {
  try {
    if (!fs.existsSync(UPDATES_DIR)) return;
    for (const entry of fs.readdirSync(UPDATES_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/\.(exe|part|ps1)$/i.test(entry.name)) continue;
      try { fs.rmSync(path.join(UPDATES_DIR, entry.name), { force: true }); }
      catch (_) {}
    }
  } catch (_) {}
}

function selectReleaseAsset(assets, mode) {
  if (!Array.isArray(assets)) return null;
  const valid = assets.filter(asset =>
    asset && typeof asset.name === 'string' && /\.exe$/i.test(asset.name)
    && typeof asset.browser_download_url === 'string' && isTrustedGithubUrl(asset.browser_download_url)
  );
  if (!valid.length) return null;
  let picked = null;
  if (mode === 'portable') {
    picked = valid.find(asset => /portable.*\.exe$/i.test(asset.name));
  } else {
    picked = valid.find(asset => /setup.*\.exe$/i.test(asset.name)) || valid.find(asset => !/portable/i.test(asset.name));
  }
  return picked ? { name: picked.name, size: Number(picked.size) || 0, url: picked.browser_download_url } : null;
}

let appUpdate = {
  phase: 'idle',
  currentVersion: app.getVersion(),
  latestVersion: '',
  releaseName: '',
  publishedAt: '',
  notes: '',
  htmlUrl: GITHUB_RELEASES_URL,
  assetName: '',
  assetUrl: '',
  assetSize: 0,
  mode: detectUpdateMode(),
  progress: 0,
  receivedBytes: 0,
  totalBytes: 0,
  speedBytes: 0,
  downloadedPath: '',
  error: '',
  checkedAt: 0,
  silent: false
};
let updateCheckPromise = null;
let downloadAbort = null;

function publicAppUpdate() {
  return { ...appUpdate };
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const items = [];
  if ((appUpdate.phase === 'available' || appUpdate.phase === 'downloaded') && appUpdate.latestVersion) {
    items.push({
      label: appUpdate.phase === 'downloaded' ? `重启安装 v${appUpdate.latestVersion}` : `发现新版本 v${appUpdate.latestVersion}…`,
      click: () => {
        showMain();
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('navigate', 'update');
      }
    });
  }
  items.push({ label: '打开轻匣', click: showMain }, { label: '退出', click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function broadcastAppUpdate() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app-update', publicAppUpdate());
  }
  updateTrayMenu();
}

async function checkAppUpdate({ silent = false } = {}) {
  if (['downloading', 'downloaded', 'installing'].includes(appUpdate.phase)) return publicAppUpdate();
  if (updateCheckPromise) return updateCheckPromise;
  updateCheckPromise = (async () => {
    const previous = publicAppUpdate();
    appUpdate = { ...appUpdate, phase: 'checking', error: '', silent, currentVersion: app.getVersion(), mode: detectUpdateMode() };
    if (!silent) broadcastAppUpdate();
    try {
      const { res } = await httpsGetFollow(
        GITHUB_LATEST_API,
        { 'User-Agent': 'personal-toolbox', 'Accept': 'application/vnd.github+json' },
        15000
      );
      const chunks = [];
      let total = 0;
      await new Promise((resolve, reject) => {
        res.on('data', chunk => {
          total += chunk.length;
          if (total > 5 * 1024 * 1024) {
            res.destroy(new Error('更新信息体积过大，无法解析。'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', resolve);
        res.on('error', reject);
      });
      if (res.statusCode !== 200) {
        if (res.statusCode === 403) throw new Error('GitHub 访问频率受限，请稍后重试，或前往发布页手动查看。');
        if (res.statusCode === 404) throw new Error('暂未找到正式发布版本。');
        throw new Error('无法检查更新，请检查 GitHub 网络连接后重试。');
      }
      const release = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const latestVersion = String(release.tag_name || '').replace(/^v/i, '').trim();
      if (!latestVersion || compareVersions(latestVersion, app.getVersion()) <= 0) {
        appUpdate = {
          ...appUpdate,
          phase: silent ? 'idle' : 'latest',
          latestVersion: latestVersion || app.getVersion(),
          checkedAt: Date.now(),
          error: ''
        };
        if (!silent) broadcastAppUpdate();
        return publicAppUpdate();
      }
      const mode = detectUpdateMode();
      const asset = selectReleaseAsset(release.assets, mode);
      const htmlUrl = typeof release.html_url === 'string' && isTrustedGithubUrl(release.html_url)
        ? release.html_url
        : GITHUB_RELEASES_URL;
      const skipped = silent && settings.skippedVersion && settings.skippedVersion === latestVersion;
      if (!silent && settings.skippedVersion === latestVersion) {
        settings.skippedVersion = '';
        try { save(); } catch (_) {}
      }
      appUpdate = {
        ...appUpdate,
        phase: skipped ? 'idle' : 'available',
        latestVersion,
        releaseName: String(release.name || `轻匣 ${latestVersion}`).trim(),
        publishedAt: String(release.published_at || ''),
        notes: String(release.body || '').trim(),
        htmlUrl,
        assetName: asset ? asset.name : '',
        assetUrl: asset ? asset.url : '',
        assetSize: asset ? asset.size : 0,
        mode,
        progress: 0,
        receivedBytes: 0,
        totalBytes: asset ? asset.size : 0,
        speedBytes: 0,
        downloadedPath: '',
        error: '',
        checkedAt: Date.now()
      };
      broadcastAppUpdate();
      return publicAppUpdate();
    } catch (error) {
      if (silent) {
        console.error('后台检查更新失败:', error.message);
        appUpdate = { ...previous, currentVersion: app.getVersion(), mode: detectUpdateMode() };
        return publicAppUpdate();
      }
      const msg = /[\u4e00-\u9fff]/.test(error?.message || '') ? error.message : '无法检查更新，请检查 GitHub 网络连接后重试。';
      appUpdate = { ...appUpdate, phase: 'error', error: msg, checkedAt: Date.now() };
      broadcastAppUpdate();
      return publicAppUpdate();
    } finally {
      updateCheckPromise = null;
    }
  })();
  return updateCheckPromise;
}

async function downloadAppUpdate() {
  if (!appUpdate.latestVersion) throw new Error('请先检查新版本后再下载。');
  if (appUpdate.phase === 'downloading' || appUpdate.phase === 'downloaded') return publicAppUpdate();
  if (appUpdate.mode === 'dev') throw new Error('源码开发模式不支持应用内覆盖升级，请点击打开发布页手动下载。');
  if (!appUpdate.assetUrl) throw new Error('当前版本未提供匹配的 Windows 安装包，请前往发布页下载。');

  fs.mkdirSync(UPDATES_DIR, { recursive: true });
  const safeName = path.basename(appUpdate.assetName || `qingxia-${appUpdate.latestVersion}.exe`).replace(/[^A-Za-z0-9._-]/g, '_') || 'qingxia-update.exe';
  const partPath = path.join(UPDATES_DIR, safeName + '.part');
  const finalPath = path.join(UPDATES_DIR, safeName);
  try { fs.rmSync(partPath, { force: true }); } catch (_) {}
  try { fs.rmSync(finalPath, { force: true }); } catch (_) {}

  let cancelled = false;
  let activeRes = null;
  let abortNetwork = null;
  downloadAbort = () => {
    cancelled = true;
    if (abortNetwork) abortNetwork();
    if (activeRes && !activeRes.destroyed) activeRes.destroy(new Error('已取消下载'));
  };

  appUpdate = {
    ...appUpdate,
    phase: 'downloading',
    progress: 0,
    receivedBytes: 0,
    totalBytes: appUpdate.assetSize || 0,
    speedBytes: 0,
    downloadedPath: '',
    error: ''
  };
  broadcastAppUpdate();

  try {
    const { res } = await httpsGetFollow(
      appUpdate.assetUrl,
      { 'User-Agent': 'personal-toolbox' },
      30000,
      5,
      fn => { abortNetwork = fn; }
    );
    activeRes = res;
    if (cancelled) throw new Error('已取消下载');
    if (res.statusCode !== 200) {
      res.resume();
      throw new Error('下载安装包失败，请检查网络连接或前往发布页手动下载。');
    }
    const headerLength = Number(res.headers['content-length']) || 0;
    const totalBytes = headerLength || appUpdate.assetSize || 0;
    appUpdate.totalBytes = totalBytes;

    const out = fs.createWriteStream(partPath, { flags: 'wx' });
    let receivedBytes = 0;
    let lastEmit = 0;
    let sampleTime = Date.now();
    let sampleBytes = 0;
    let speedBytes = 0;

    res.on('data', chunk => {
      receivedBytes += chunk.length;
      if (receivedBytes > 1024 * 1024 * 1024) {
        res.destroy(new Error('安装包体积异常，已中止下载。'));
        return;
      }
      const now = Date.now();
      const elapsed = now - sampleTime;
      if (elapsed >= 500) {
        speedBytes = Math.round(((receivedBytes - sampleBytes) * 1000) / elapsed);
        sampleTime = now;
        sampleBytes = receivedBytes;
      }
      if (now - lastEmit >= 150) {
        lastEmit = now;
        appUpdate.receivedBytes = receivedBytes;
        appUpdate.speedBytes = speedBytes;
        appUpdate.progress = totalBytes > 0 ? Math.min(99, Math.round((receivedBytes / totalBytes) * 100)) : 0;
        broadcastAppUpdate();
      }
    });

    await require('node:stream/promises').pipeline(res, out);
    if (cancelled) throw new Error('已取消下载');
    if (receivedBytes <= 0 || (appUpdate.assetSize > 0 && receivedBytes !== appUpdate.assetSize)) {
      throw new Error('安装包下载不完整，请重试。');
    }
    fs.renameSync(partPath, finalPath);
    appUpdate = {
      ...appUpdate,
      phase: 'downloaded',
      progress: 100,
      receivedBytes,
      totalBytes: receivedBytes,
      speedBytes: 0,
      downloadedPath: finalPath,
      error: ''
    };
    broadcastAppUpdate();
    return publicAppUpdate();
  } catch (error) {
    try { fs.rmSync(partPath, { force: true }); } catch (_) {}
    if (cancelled) {
      appUpdate = {
        ...appUpdate,
        phase: 'available',
        progress: 0,
        receivedBytes: 0,
        speedBytes: 0,
        error: ''
      };
      broadcastAppUpdate();
      return publicAppUpdate();
    }
    const msg = /[\u4e00-\u9fff]/.test(error?.message || '') ? error.message : '下载连接超时，请检查 GitHub 网络连接后重试，或前往发布页手动下载。';
    appUpdate = {
      ...appUpdate,
      phase: 'error',
      speedBytes: 0,
      error: msg
    };
    broadcastAppUpdate();
    return publicAppUpdate();
  } finally {
    downloadAbort = null;
  }
}

function cancelAppUpdateDownload() {
  if (downloadAbort) {
    downloadAbort();
  } else if (appUpdate.phase === 'downloading') {
    appUpdate = { ...appUpdate, phase: 'available', progress: 0, receivedBytes: 0, speedBytes: 0, error: '' };
    broadcastAppUpdate();
  }
  return publicAppUpdate();
}

async function installAppUpdate() {
  if (appUpdate.mode === 'dev') throw new Error('源码开发模式不支持应用内覆盖升级。');
  if (appUpdate.phase !== 'downloaded' || !appUpdate.downloadedPath || !fs.existsSync(appUpdate.downloadedPath)) {
    throw new Error('找不到已下载的更新文件，请重新下载。');
  }
  const realUpdates = fs.realpathSync(UPDATES_DIR);
  const realUpdateFile = fs.realpathSync(appUpdate.downloadedPath);
  if (!realUpdateFile.startsWith(realUpdates + path.sep)) throw new Error('更新文件路径无效。');

  appUpdate = { ...appUpdate, phase: 'installing', error: '' };
  broadcastAppUpdate();

  const quittingIds = [...pluginViews.keys()];
  const results = await Promise.allSettled(quittingIds.map(id => {
    const contents = require('electron').webContents.fromId(id);
    return contents ? cleanupPlugin(contents) : pluginExitHandlers.has(id) ? Promise.reject(new Error('插件页面已关闭，无法确认后台任务是否停止。')) : Promise.resolve();
  }));
  const failed = results.find(result => result.status === 'rejected');
  if (failed) {
    for (let i = 0; i < quittingIds.length; i++) {
      if (results[i]?.status !== 'fulfilled') continue;
      const contents = require('electron').webContents.fromId(quittingIds[i]);
      if (contents && !contents.isDestroyed()) contents.send('host-plugin-exit-cancelled');
    }
    const reason = failed.reason?.message || '插件未能停止后台任务';
    appUpdate = { ...appUpdate, phase: 'downloaded', error: `插件后台任务未能停止：${reason}` };
    broadcastAppUpdate();
    throw new Error(appUpdate.error);
  }

  const psScript = [
    "$ErrorActionPreference = 'Stop'",
    "$mode = $env:QINGXIA_UPDATE_MODE",
    "$parentPid = [int]$env:QINGXIA_UPDATE_PID",
    "$updateFile = $env:QINGXIA_UPDATE_FILE",
    "$appExe = $env:QINGXIA_UPDATE_EXE",
    "$portableTarget = $env:QINGXIA_UPDATE_PORTABLE",
    "for ($i = 0; $i -lt 60; $i++) {",
    "  if (-not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { break }",
    "  Start-Sleep -Milliseconds 500",
    "}",
    "Start-Sleep -Milliseconds 600",
    "if ($mode -eq 'setup') {",
    "  $proc = Start-Process -FilePath $updateFile -ArgumentList '/S' -Wait -PassThru",
    "  if ($proc.ExitCode -eq 0 -and (Test-Path -LiteralPath $appExe)) {",
    "    Start-Process -FilePath $appExe",
    "  }",
    "} elseif ($mode -eq 'portable' -and $portableTarget) {",
    "  $replaced = $false",
    "  for ($i = 0; $i -lt 60; $i++) {",
    "    try {",
    "      $tmpNew = $portableTarget + '.new'",
    "      $bak = $portableTarget + '.bak'",
    "      Copy-Item -LiteralPath $updateFile -Destination $tmpNew -Force",
    "      if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue }",
    "      if (Test-Path -LiteralPath $portableTarget) { Move-Item -LiteralPath $portableTarget -Destination $bak -Force }",
    "      try {",
    "        Move-Item -LiteralPath $tmpNew -Destination $portableTarget -Force",
    "      } catch {",
    "        if ((Test-Path -LiteralPath $bak) -and -not (Test-Path -LiteralPath $portableTarget)) { Move-Item -LiteralPath $bak -Destination $portableTarget -Force -ErrorAction SilentlyContinue }",
    "        throw",
    "      }",
    "      if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue }",
    "      $replaced = $true",
    "      break",
    "    } catch {",
    "      Start-Sleep -Milliseconds 500",
    "    }",
    "  }",
    "  if ($replaced -and (Test-Path -LiteralPath $portableTarget)) {",
    "    Start-Process -FilePath $portableTarget",
    "  }",
    "}"
  ].join('\r\n');

  const scriptPath = path.join(UPDATES_DIR, 'apply-update.ps1');
  fs.writeFileSync(scriptPath, psScript, 'utf8');

  const child = spawn(
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        QINGXIA_UPDATE_MODE: appUpdate.mode,
        QINGXIA_UPDATE_PID: String(process.pid),
        QINGXIA_UPDATE_FILE: realUpdateFile,
        QINGXIA_UPDATE_EXE: process.execPath,
        QINGXIA_UPDATE_PORTABLE: process.env.PORTABLE_EXECUTABLE_FILE || ''
      }
    }
  );
  child.unref();

  quitReady = true;
  app.quitting = true;
  setImmediate(() => app.quit());
  return publicAppUpdate();
}
function readPlugin(dir) {
  const root = fs.realpathSync(dir);
  const manifestPath = path.join(root, 'plugin.json');
  if (!fs.existsSync(manifestPath)) throw new Error('所选文件夹中没有 plugin.json。请选择包含该文件的插件文件夹，或直接选择 plugin.json。');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error instanceof SyntaxError) throw new Error('plugin.json 格式有误，请检查插件文件是否完整。'); throw error; }
  function inside(file) { const target = fs.realpathSync(path.resolve(root, file)); if (!target.startsWith(root + path.sep) || !fs.statSync(target).isFile()) throw new Error('插件入口文件必须位于插件文件夹内。'); return target; }
  if (!manifest || typeof manifest.main !== 'string' || (manifest.preload !== undefined && typeof manifest.preload !== 'string')) throw new Error('插件配置缺少有效的 main 入口，或 preload 配置有误。');
  const main = inside(manifest.main), preload = manifest.preload ? inside(manifest.preload) : '';
  const feature = manifest.features && manifest.features[0] || {};
  let icon = ''; try { icon = inside(manifest.logo); } catch (_) {}
  const name = (Array.isArray(feature.cmds) ? feature.cmds : []).find(x => typeof x === 'string') || feature.code || path.basename(root);
  const id = typeof manifest.id === 'string' ? manifest.id.trim().toLowerCase() : '';
  const code = typeof feature.code === 'string' ? feature.code.trim().toLowerCase() : '';
  const identity = code && typeof name === 'string' ? 'feature:' + JSON.stringify([code, name.trim().toLowerCase()]) : 'manifest:' + require('node:crypto').createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex');
  return { dir: root, main, preload, icon, name, description: feature.description || '', code: feature.code || '', pluginId: id, identity };
}
function samePlugin(a, b) { return a.pluginId && b.pluginId ? a.pluginId === b.pluginId : a.identity === b.identity; }
function displayPlugin(p) { return { ...p, dataSubdir: resolvePluginDataSubdir(p), icon: p.icon ? require('node:url').pathToFileURL(p.icon).href : '' }; }
function friendlyError(error) {
  if (error.code === 'ENOENT') return '找不到插件需要的文件。请确认插件已经完整解压，并重新选择包含 plugin.json 的文件夹。';
  if (error.code === 'EACCES' || error.code === 'EPERM') return '无法访问该文件或文件夹，请检查访问权限或文件是否被占用。';
  if (error.code === 'ENOSPC') return '磁盘空间不足，请清理空间后重试。';
  if (error.message && /[\u4e00-\u9fff]/.test(error.message)) return error.message;
  return '操作未完成，请检查插件文件是否完整后重试。';
}
const githubStaging = new Set();
function clearGithubStaging() {
  for (const dir of githubStaging) {
    try { fs.rmSync(dir, { recursive: true, force: true }); githubStaging.delete(dir); }
    catch (error) { console.error('清理临时文件失败:', error); }
  }
}
async function downloadGithub(input) {
  let url;
  try { url = new URL(input); } catch (_) { throw new Error('请输入完整的 GitHub 仓库链接，例如 https://github.com/用户名/仓库名。'); }
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password || url.search || url.hash || parts.length !== 2 || !/^[A-Za-z0-9_.-]+$/.test(parts[0]) || !/^[A-Za-z0-9_.-]+$/.test(parts[1])) throw new Error('请输入公开 GitHub 仓库的首页链接，例如 https://github.com/用户名/仓库名。');
  const repo = parts[1].replace(/\.git$/i, '');
  if (!repo || repo === '.' || repo === '..' || parts[0] === '.' || parts[0] === '..') throw new Error('GitHub 仓库链接无效。');
  fs.mkdirSync(data, { recursive: true });
  const dir = fs.mkdtempSync(path.join(data, 'github-import-')); githubStaging.add(dir);
  try {
    const archive = path.join(dir, 'archive.zip');
    await new Promise((resolve, reject) => {
      const request = require('node:https').get(`https://codeload.github.com/${parts[0]}/${repo}/zip/HEAD`, { headers: { 'User-Agent': 'personal-toolbox' }, timeout: 30000 }, res => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error('无法下载仓库，请检查链接、网络以及仓库是否公开。')); return; }
        const out = fs.createWriteStream(archive, { flags: 'wx' }); let bytes = 0;
        res.on('data', chunk => { bytes += chunk.length; if (bytes > 100 * 1024 * 1024) { res.destroy(new Error('仓库压缩包超过 100 MB，无法导入。')); } });
        require('node:stream/promises').pipeline(res, out).then(resolve, reject);
      });
      request.on('timeout', () => request.destroy(new Error('连接 GitHub 超时，请检查网络后重试。'))); request.on('error', reject);
    });
    const extracted = path.join(dir, 'files'); fs.mkdirSync(extracted);
    await new Promise((resolve, reject) => require('yauzl').open(archive, { lazyEntries: true }, (err, zip) => {
      if (err) { reject(new Error('下载的仓库压缩包无法读取。')); return; }
      let count = 0, bytes = 0, done = false;
      const fail = error => { if (done) return; done = true; zip.close(); reject(error); };
      zip.on('error', fail); zip.on('end', () => { if (!done) { done = true; resolve(); } });
      zip.on('entry', entry => {
        try {
          const name = entry.fileName; const components = name.split('/').filter(Boolean);
          if (++count > 10000 || (bytes += entry.uncompressedSize) > 500 * 1024 * 1024) throw new Error('仓库文件过多或解压后超过 500 MB，无法导入。');
          if (!components.length || components.length > 30 || name.includes('\\') || components.some(part => part === '.' || part === '..' || /[:*?"<>|]/.test(part)) || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new Error('仓库包含不支持的文件路径，无法安全导入。');
          const target = path.resolve(extracted, ...components);
          if (!target.startsWith(extracted + path.sep)) throw new Error('仓库包含不支持的文件路径，无法安全导入。');
          if (/\/$/.test(name)) { fs.mkdirSync(target, { recursive: true }); zip.readEntry(); return; }
          fs.mkdirSync(path.dirname(target), { recursive: true });
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) { fail(streamError); return; }
            require('node:stream/promises').pipeline(stream, fs.createWriteStream(target, { flags: 'wx' })).then(() => zip.readEntry(), fail);
          });
        } catch (error) { fail(error); }
      });
      zip.readEntry();
    }));
    const matches = []; let needsBuild = false;
    function findPlugins(parent, depth) {
      if (fs.existsSync(path.join(parent, 'plugin.json'))) {
        try { matches.push(readPlugin(parent)); }
        catch (error) { if (error.code === 'ENOENT' && path.basename(parent) === 'public' && fs.existsSync(path.join(path.dirname(parent), 'package.json'))) needsBuild = true; else throw error; }
        return;
      }
      if (!depth) return;
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) if (entry.isDirectory() && !['node_modules', '.git', 'dist', 'tests'].includes(entry.name)) findPlugins(path.join(parent, entry.name), depth - 1);
    }
    findPlugins(extracted, 4);
    if (!matches.length && needsBuild) throw new Error('这个 GitHub 仓库提供的是插件源码，缺少构建后的运行文件，暂时不能直接导入。请先构建项目，再选择生成目录中的 plugin.json。');
    if (!matches.length) throw new Error('仓库中没有找到可导入的 plugin.json，请确认仓库包含完整的插件文件。');
    return matches.map(displayPlugin);
  } catch (error) {
    clearGithubStaging();
    if (!/[\u4e00-\u9fff]/.test(error.message || '')) throw new Error('下载或解压失败，请检查 GitHub 网络连接和仓库文件后重试。');
    throw error;
  }
}
let mainWindow, panelWindow, tray;
function showMain() { if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } }
const windows = new Map();
const pluginViews = new Map();
const pluginDataRoots = new Map();
const legacyPluginData = new Map([
  ['frpc\0frpc', 'frpc-utools'],
  ['hosts-editor\0Hosts 快速编辑', 'hosts-editor'],
  ['password-box\0密码盒', 'password-box'],
  ['download\0拾影', 'shiying-douyin-plugin'],
  ['application-proxy\0应用代理', 'application-proxy']
]);
function emptyFrpcData(dir) {
  try {
    const files = fs.readdirSync(dir);
    if (files.length !== 1 || files[0] !== 'settings.json') return false;
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8').replace(/^\uFEFF/, ''));
    const connection = settings.connection, frpc = settings.frpc, sync = settings.autoSync;
    return !!connection && !!frpc && !!sync && !connection.pcToken && !connection.pcTokenEnc && !frpc.path && !sync.enabled && !sync.startOnLaunch;
  } catch (_) { return false; }
}
function configuredFrpcData(dir) {
  try {
    const connection = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8').replace(/^\uFEFF/, '')).connection || {};
    return typeof connection.pcId === 'string' && !!connection.pcId.trim()
      && (typeof connection.pcToken === 'string' && !!connection.pcToken || typeof connection.pcTokenEnc === 'string' && !!connection.pcTokenEnc);
  } catch (_) { return false; }
}
function describeFrpcData(dir) {
  try {
    const connection = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8').replace(/^\uFEFF/, '')).connection || {};
    return `电脑 ID：${connection.pcId || '未设置'}，Token：${connection.pcToken || connection.pcTokenEnc ? '已设置' : '未设置'}`;
  } catch (_) { return '无法读取连接设置'; }
}
function preparePluginData(plugin) {
  const targetRoot = pluginDataFolder(pluginFolder());
  try {
    const result = migrateSinglePluginData({
      plugin,
      targetRoot,
      legacyGlobalRoot: path.join(data, 'plugin-data'),
      legacyUserDataRoot: data,
      resolveConflict: ({ subdir, oldDir, newDir }) => {
        if (subdir === 'frpc-utools' && emptyFrpcData(oldDir) && configuredFrpcData(newDir)) return 'use-current';
        const details = subdir === 'frpc-utools'
          ? `当前数据：${describeFrpcData(newDir)}\n旧数据：${describeFrpcData(oldDir)}\n\n`
          : '';
        if (mainWindow) pluginDialogs.add(mainWindow);
        try {
          const choice = dialog.showMessageBoxSync({
            type: 'question', title: '选择插件数据', message: `发现两份${plugin.name}数据`,
            detail: `${details}请选择要继续使用的数据，另一份会保留为备份。两份数据不会合并。\n\n当前目录：${newDir}\n旧目录：${oldDir}`,
            buttons: ['使用当前数据', '使用旧数据', '取消'], defaultId: 0, cancelId: 2, noLink: true,
          });
          return choice === 0 ? 'use-current' : choice === 1 ? 'use-old' : 'cancel';
        } finally { if (mainWindow) pluginDialogs.delete(mainWindow); }
      },
    });
    if (result === null) return null;
    return isLegacyPlugin(plugin) ? targetRoot : '';
  } catch (error) { throw new Error(`无法迁移${plugin.name}的数据：${error.message}。原有数据未被覆盖。`); }
}
const pluginMenus = new Map();
const pluginDialogs = new Set();
const pluginOperations = new Set();
const pluginExitHandlers = new Set();
const pluginExitPending = new Map();
const pluginExitRunning = new Map();
let quitReady = false, quitPending = false;
function cleanupPlugin(contents) {
  if (!pluginExitHandlers.has(contents.id)) return Promise.resolve();
  if (pluginExitRunning.has(contents.id)) return pluginExitRunning.get(contents.id);
  const promise = new Promise((resolve, reject) => {
    if (contents.isDestroyed()) { reject(new Error('插件页面已关闭，无法确认后台任务是否停止。')); return; }
    const id = require('node:crypto').randomUUID();
    const finish = error => { clearTimeout(timer); contents.removeListener('destroyed', destroyed); pluginExitPending.delete(id); if (error) reject(error); else resolve(); };
    const destroyed = () => finish(new Error('插件页面意外关闭，无法确认后台任务是否停止。'));
    const timer = setTimeout(() => finish(new Error('插件停止后台任务超时。')), 120000);
    contents.once('destroyed', destroyed);
    pluginExitPending.set(id, { sender: contents.id, finish });
    try { contents.send('host-plugin-exit', id); } catch (error) { finish(error); }
  }).finally(() => pluginExitRunning.delete(contents.id));
  pluginExitRunning.set(contents.id, promise);
  return promise;
}
ipcMain.on('host-plugin-exit-ready', event => { if (pluginViews.has(event.sender.id)) pluginExitHandlers.add(event.sender.id); });
ipcMain.on('host-plugin-busy', (event, busy) => { if (pluginViews.has(event.sender.id)) { if (busy) pluginOperations.add(event.sender.id); else pluginOperations.delete(event.sender.id); } event.returnValue = undefined; });
ipcMain.on('host-plugin-exit-result', (event, id, error) => {
  const pending = pluginExitPending.get(id);
  if (!pending || pending.sender !== event.sender.id) return;
  pending.finish(error ? new Error(String(error).slice(0, 500)) : null);
});
let changingFolder = false;
function pluginFolder() { return settings.pluginFolder || path.join(data, 'plugins'); }
async function changePluginFolder(target) {
  if ([...windows.values()].some(win => !win.isDestroyed())) throw new Error('请先关闭已打开的插件窗口；后台运行的插件需先取消“后台运行”并关闭窗口，再更改插件目录。');
  const selected = fs.realpathSync(target);
  if (!fs.statSync(selected).isDirectory()) throw new Error('请选择有效的文件夹。');
  const destination = path.basename(selected).toLowerCase() === 'qingxia-plugin' ? selected : path.join(selected, 'qingxia-plugin');
  if (path.resolve(destination).toLowerCase() === path.resolve(pluginFolder()).toLowerCase()) return;
  const oldFolder = pluginFolder();
  const sources = settings.plugins.map(dir => ({ original: dir, plugin: readPlugin(dir) }));
  for (const { plugin } of sources) {
    const relative = path.relative(plugin.dir, destination);
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('新目录不能位于已安装插件的文件夹内。');
  }
  if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) throw new Error('插件目录不能是快捷链接，请选择其他位置。');
  fs.mkdirSync(destination, { recursive: true });
  if (!fs.statSync(destination).isDirectory()) throw new Error('插件目录不可用，请选择其他位置。');
  const mapping = new Map(), created = [];
  const previous = settings;
  let dataMigration = { migrated: false, oldData: '', created: [] };
  try {
    dataMigration = copyPluginDataRoot({ oldFolder, newFolder: destination });
    created.push(...dataMigration.created);
    for (const { original, plugin } of sources) {
      const targetDir = path.join(destination, require('node:crypto').randomUUID());
      fs.mkdirSync(targetDir);
      created.push(targetDir);
      for (const entry of await fs.promises.readdir(plugin.dir)) {
        await fs.promises.cp(path.join(plugin.dir, entry), path.join(targetDir, entry), { recursive: true, errorOnExist: true, force: false, filter: source => { if (fs.lstatSync(source).isSymbolicLink()) throw new Error('插件中包含快捷链接，无法安全复制；原目录没有改变。'); return true; } });
      }
      mapping.set(original, readPlugin(targetDir).dir);
    }
    settings = { ...settings, pluginFolder: destination, plugins: settings.plugins.map(dir => mapping.get(dir)), panel: settings.panel.map(dir => mapping.get(dir) || dir), independent: settings.independent.map(dir => mapping.get(dir) || dir), background: settings.background.map(dir => mapping.get(dir) || dir), pluginStartup: settings.pluginStartup.map(dir => mapping.get(dir) || dir) };
    save();
  } catch (error) {
    settings = previous;
    for (const dir of [...created].reverse()) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (cleanupError) { console.error('清理未完成的插件迁移失败:', cleanupError); } }
    throw error;
  }
  let cleanupFailed = false;
  for (const { plugin } of sources) {
    if (path.dirname(plugin.dir).toLowerCase() !== path.resolve(oldFolder).toLowerCase() || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(path.basename(plugin.dir))) { cleanupFailed = true; continue; }
    try { await shell.trashItem(plugin.dir); } catch (error) { console.error('清理旧插件目录失败:', error); cleanupFailed = true; }
  }
  if (dataMigration.migrated && dataMigration.oldData && fs.existsSync(dataMigration.oldData)) {
    try { await shell.trashItem(dataMigration.oldData); } catch (error) { console.error('清理旧插件数据目录失败:', error); cleanupFailed = true; }
  }
  if (path.resolve(oldFolder).toLowerCase() === path.resolve(data, 'plugins').toLowerCase() || path.basename(path.resolve(oldFolder)).toLowerCase() === 'qingxia-plugin') {
    try { fs.rmdirSync(oldFolder); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) cleanupFailed = true; }
  }
  return cleanupFailed ? '插件已迁移到新目录，但部分旧插件文件未能清理，请检查原目录。' : '';
}
function plugins() { return settings.plugins.flatMap(dir => { try { return [readPlugin(dir)]; } catch (_) { return []; } }); }
function snapshot() { return { plugins: plugins().map(displayPlugin), panel: settings.panel, mainIndependent: settings.mainIndependent, middle: settings.middle, autoStart: settings.autoStart, autoCheckUpdate: settings.autoCheckUpdate !== false, skippedVersion: settings.skippedVersion || '', defaultGithubUrl: DEFAULT_GITHUB_REPO, releasesUrl: GITHUB_RELEASES_URL, appUpdate: publicAppUpdate(), version: app.getVersion(), folder: pluginFolder(), appIcon: require('node:url').pathToFileURL(path.join(bundle, 'app-icon.png')).href }; }
function refresh() { for (const win of [mainWindow, panelWindow]) if (win && !win.isDestroyed()) win.webContents.send('updated', snapshot()); }
function windowForPanel() {
  if (panelWindow && !panelWindow.isDestroyed()) return panelWindow;
  panelWindow = new BrowserWindow({ width: 330, height: 410, show: false, frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true, icon: path.join(bundle, 'app-icon.ico'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: false } });
  panelWindow.loadFile('index.html', { query: { panel: '1' } });
  panelWindow.on('blur', () => panelWindow.hide());
  return panelWindow;
}
function showPanel() {
  const win = windowForPanel(); const point = screen.getCursorScreenPoint(); const area = screen.getDisplayNearestPoint(point).workArea; const [w, h] = win.getSize();
  win.setPosition(Math.max(area.x, Math.min(point.x, area.x + area.width - w)), Math.max(area.y, Math.min(point.y, area.y + area.height - h))); win.show(); win.focus();
}
function handleGlobalMouseDown(event) {
  if (event.button === 3 && settings.middle) { showPanel(); return; }
  if (!panelWindow || panelWindow.isDestroyed() || !panelWindow.isVisible()) return;
  const point = screen.getCursorScreenPoint(), bounds = panelWindow.getBounds();
  if (point.x < bounds.x || point.y < bounds.y || point.x >= bounds.x + bounds.width || point.y >= bounds.y + bounds.height) panelWindow.hide();
}
function openPlugin(dir, background = false) {
  const plugin = plugins().find(p => p.dir === dir); if (!plugin) throw new Error('工具不存在');
  if (windows.has(dir) && !windows.get(dir).isDestroyed()) { if (!background) { windows.get(dir).show(); windows.get(dir).focus(); } return; }
  const pluginDataRoot = preparePluginData(plugin);
  if (pluginDataRoot === null) return;
  const win = new BrowserWindow({ width: 900, height: 760, minWidth: 650, minHeight: 500, show: !background, title: plugin.name, icon: path.join(bundle, 'app-icon.ico'), titleBarStyle: 'hidden', titleBarOverlay: { color: '#faf8f4', symbolColor: '#163529', height: 36 }, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: false } });
  const view = new BrowserView({ webPreferences: { preload: path.join(__dirname, 'plugin-preload.cjs'), sandbox: false, contextIsolation: false, nodeIntegration: false, backgroundThrottling: false, additionalArguments: ['--toolbox-plugin=' + encodeURIComponent(plugin.preload), '--toolbox-code=' + encodeURIComponent(plugin.code), '--toolbox-browser=' + encodeURIComponent(path.join(bundle, 'chromium', 'chrome.exe'))] } });
  view.webContents.on('did-finish-load', () => { view.webContents.insertCSS('::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#b8c8b9;border:2px solid transparent;border-radius:8px;background-clip:padding-box}::-webkit-scrollbar-thumb:hover{background:#87a48c;border:2px solid transparent;background-clip:padding-box}::-webkit-scrollbar-corner{background:transparent}').catch(error => console.error('设置滚动条样式失败:', error)); });
  const contents = view.webContents;
  win.setMenu(null);
  windows.set(dir, win); pluginViews.set(contents.id, win); if (pluginDataRoot) pluginDataRoots.set(contents.id, pluginDataRoot);
  win.setBrowserView(view);
  const layout = () => { const [width, height] = win.getContentSize(); view.setBounds({ x: 0, y: 36, width, height: Math.max(0, height - 36) }); const menu = pluginMenus.get(dir); if (menu) menu.setBounds({ x: Math.max(0, width - 432), y: 36, width: 286, height: 208 }); };
  layout(); win.on('resize', layout);
  win.on('blur', () => { if (!settings.independent.includes(dir) && !pluginDialogs.has(win) && !pluginOperations.has(contents.id) && !win.isDestroyed()) win.close(); });
  let allowClose = false, closing = false;
  win.on('close', e => {
    if (allowClose || quitReady) return;
    e.preventDefault();
    if (!app.quitting && settings.background.includes(dir)) { win.hide(); return; }
    if (closing || app.quitting) return;
    closing = true;
    cleanupPlugin(contents).then(() => { allowClose = true; if (!win.isDestroyed()) win.close(); }).catch(async error => {
      if (!win.isDestroyed()) { pluginDialogs.add(win); win.show(); await dialog.showMessageBox(win, { type: 'error', message: '插件未能停止后台任务', detail: error.message }); pluginDialogs.delete(win); }
    }).finally(() => { closing = false; });
  });
  contents.on('focus', () => { const menu = pluginMenus.get(dir); if (menu && win.getBrowserViews().includes(menu)) win.removeBrowserView(menu); });
  win.on('closed', () => { const menu = pluginMenus.get(dir); pluginMenus.delete(dir); if (menu && !menu.webContents.isDestroyed()) menu.webContents.close(); windows.delete(dir); pluginViews.delete(contents.id); pluginDataRoots.delete(contents.id); pluginExitHandlers.delete(contents.id); pluginOperations.delete(contents.id); pluginDialogs.delete(win); if (!contents.isDestroyed()) contents.close(); });
  contents.on('will-navigate', (event, url) => { if (!url.startsWith('file:')) event.preventDefault(); });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile('index.html', { query: { plugin: '1' } });
  contents.loadFile(plugin.main); if (!background && panelWindow) panelWindow.hide();
}
app.whenReady().then(async () => {
  if (!singleInstance) return;
  Menu.setApplicationMenu(null);
  fs.mkdirSync(data, { recursive: true });
  mainWindow = new BrowserWindow({ width: 1000, height: 740, minWidth: 700, minHeight: 550, title: '轻匣', icon: path.join(bundle, 'app-icon.ico'), titleBarStyle: 'hidden', titleBarOverlay: { color: '#faf8f4', symbolColor: '#163529', height: 36 }, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: false } });
  mainWindow.setMenu(null);
  mainWindow.loadFile('index.html'); mainWindow.on('close', e => { if (!app.quitting) { e.preventDefault(); mainWindow.hide(); } });
  mainWindow.on('blur', () => { if (!settings.mainIndependent && !pluginDialogs.has(mainWindow) && !mainWindow.isDestroyed()) mainWindow.hide(); });
  tray = new Tray(nativeImage.createFromPath(path.join(bundle, 'app-icon.png')).resize({ width: 16, height: 16 }));
  tray.setToolTip('轻匣'); updateTrayMenu(); tray.on('click', showMain);
  cleanupUpdatesDir();
  if (settings.autoCheckUpdate !== false) {
    const timer = setTimeout(() => { checkAppUpdate({ silent: true }).catch(() => {}); }, 3000);
    if (typeof timer.unref === 'function') timer.unref();
  }
  try {
    const startupMigration = migrateInstalledPluginsDataOnStartup({
      installedPlugins: plugins(),
      targetRoot: pluginDataFolder(pluginFolder()),
      legacyGlobalRoot: path.join(data, 'plugin-data'),
      legacyUserDataRoot: data,
    });
    for (const err of startupMigration.errors) console.error('启动迁移插件数据失败:', err.subdir, err.message);
  } catch (error) { console.error('启动迁移插件数据异常:', error); }
  for (const dir of settings.pluginStartup) {
    if (!settings.plugins.includes(dir)) continue;
    try { openPlugin(dir, true); } catch (error) { console.error('后台插件启动失败:', error); const notice = () => mainWindow.webContents.send('notice', `后台插件启动失败：${friendlyError(error)}`); if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', notice); else notice(); }
  }
  try { uIOhook.on('mousedown', handleGlobalMouseDown); uIOhook.start(); } catch (error) { console.error('鼠标快捷面板不可用:', error); const notice = () => mainWindow.webContents.send('notice', '鼠标中键快捷面板暂时不可用，请重启工具箱后重试。'); if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', notice); else notice(); }
});
app.on('before-quit', event => {
  if (quitReady) { try { uIOhook.stop(); } catch (_) {} return; }
  event.preventDefault();
  if (quitPending) return;
  quitPending = true; app.quitting = true;
  const quittingIds = [...pluginViews.keys()];
  let cleanupResults = [];
  Promise.allSettled(quittingIds.map(id => {
    const contents = require('electron').webContents.fromId(id);
    return contents ? cleanupPlugin(contents) : pluginExitHandlers.has(id) ? Promise.reject(new Error('插件页面已关闭，无法确认后台任务是否停止。')) : Promise.resolve();
  })).then(results => {
    cleanupResults = results;
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    quitReady = true; app.quit();
  }).catch(async error => {
    app.quitting = false;
    for (let i = 0; i < quittingIds.length; i++) {
      if (cleanupResults[i]?.status !== 'fulfilled') continue;
      const contents = require('electron').webContents.fromId(quittingIds[i]);
      if (contents && !contents.isDestroyed()) contents.send('host-plugin-exit-cancelled');
    }
    await dialog.showMessageBox({ type: 'error', message: '轻匣未退出，因为插件后台任务未能停止', detail: error.message });
  }).finally(() => { quitPending = false; });
});
ipcMain.handle('toolbox', async (event, action, value) => {
  try { return { ok: true, value: await toolboxAction(event, action, value) }; }
  catch (error) { console.error('工具箱操作失败:', action, error); return { ok: false, message: friendlyError(error) }; }
});
async function installPlugins(sources, replace) {
  const installed = plugins();
  for (let i = 0; i < sources.length; i++) {
    if (sources.slice(0, i).some(other => samePlugin(other, sources[i]))) throw new Error('所选插件中有重复项，请只选择一个。');
    const matches = installed.filter(other => samePlugin(other, sources[i]));
    if (matches.length && !replace) throw new Error(`“${sources[i].name}”已添加，请确认是否更新。`);
    if (matches.some(other => { const win = windows.get(other.dir); return win && !win.isDestroyed(); })) throw new Error(`请先关闭“${sources[i].name}”插件；如果它在后台运行，请先停止后台运行后再更新。`);
  }
  const base = pluginFolder(), created = [], mapping = new Map(), previous = settings;
  fs.mkdirSync(base, { recursive: true });
  try {
    for (const source of sources) {
      const target = path.join(base, require('node:crypto').randomUUID());
      fs.mkdirSync(target);
      created.push(target);
      fs.cpSync(source.dir, target, { recursive: true, errorOnExist: true, force: false, filter: entry => !fs.lstatSync(entry).isSymbolicLink() });
      const fresh = readPlugin(target);
      for (const old of installed.filter(other => samePlugin(other, source))) mapping.set(old.dir, fresh.dir);
    }
    const remap = values => [...new Set(values.map(dir => mapping.get(dir) || dir))];
    settings = { ...previous, plugins: remap([...previous.plugins, ...created.map(dir => fs.realpathSync(dir))]), panel: remap(previous.panel), independent: remap(previous.independent), background: remap(previous.background), pluginStartup: remap(previous.pluginStartup) };
    save();
  } catch (error) {
    settings = previous;
    for (const dir of created) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (cleanupError) { console.error('清理未完成的插件失败:', cleanupError); } }
    throw error;
  }
  let cleanupFailed = false;
  let realBase = '';
  try { realBase = fs.realpathSync(base); } catch (error) { console.error('检查插件目录失败:', error); cleanupFailed = mapping.size > 0; }
  for (const old of mapping.keys()) {
    try {
      const oldFrpc = path.join(old, 'bin', 'frpc.exe');
      const targetFrpc = path.join(pluginDataFolder(base), 'frpc-utools', 'bin', 'frpc.exe');
      if (fs.existsSync(oldFrpc) && !fs.existsSync(targetFrpc) && !fs.lstatSync(oldFrpc).isSymbolicLink()) {
        fs.mkdirSync(path.dirname(targetFrpc), { recursive: true });
        fs.copyFileSync(oldFrpc, targetFrpc);
      }
      if (!fs.existsSync(old)) continue;
      if (!isManagedPluginDir(old, realBase)) { cleanupFailed = true; continue; }
      await shell.trashItem(old);
    } catch (error) { console.error('清理旧插件副本失败:', error); cleanupFailed = true; }
  }
  clearGithubStaging(); refresh();
  return { ...snapshot(), ...(cleanupFailed ? { warning: '插件已更新，但部分旧插件文件夹未能移入回收站。请关闭相关程序后检查插件目录。' } : {}) };
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isManagedPluginDir(target, realBase) {
  if (!realBase || !fs.existsSync(target)) return false;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  const realTarget = fs.realpathSync(target);
  return path.dirname(realTarget).toLowerCase() === realBase.toLowerCase() && UUID_RE.test(path.basename(realTarget));
}
function closePluginWindow(win) {
  if (!win || win.isDestroyed()) return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    const done = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, 5000);
    win.once('closed', done);
    win.close();
  });
}
async function cleanOrphanPluginDirs() {
  const base = pluginFolder();
  if (!fs.existsSync(base)) return { removed: 0, failed: 0 };
  const realBase = fs.realpathSync(base);
  const norm = dir => { try { return fs.realpathSync(dir).toLowerCase(); } catch (_) { return path.resolve(dir).toLowerCase(); } };
  const active = new Set(settings.plugins.map(norm));
  const open = new Set([...windows.entries()].filter(([, win]) => win && !win.isDestroyed()).map(([dir]) => norm(dir)));
  let removed = 0, failed = 0;
  for (const entry of fs.readdirSync(realBase, { withFileTypes: true })) {
    const full = path.join(realBase, entry.name);
    try {
      if (!isManagedPluginDir(full, realBase)) continue;
      const key = fs.realpathSync(full).toLowerCase();
      if (active.has(key) || open.has(key)) continue;
      await shell.trashItem(full);
      removed++;
    } catch (error) { console.error('清理残留插件目录失败:', full, error); failed++; }
  }
  return { removed, failed };
}
async function toolboxAction(event, action, value) {
  const pluginEntry = [...windows.entries()].find(([dir, win]) => win.webContents === event.sender || pluginMenus.get(dir)?.webContents === event.sender);
  if (pluginEntry) {
    const [dir] = pluginEntry;
    const pluginState = () => ({ name: readPlugin(dir).name, independent: settings.independent.includes(dir), background: settings.background.includes(dir), pluginStartup: settings.pluginStartup.includes(dir) });
    if (action === 'plugin-state') return pluginState();
    if (action === 'plugin-menu' || action === 'plugin-menu-close') {
      const win = pluginEntry[1]; let menu = pluginMenus.get(dir);
      if (menu && win.getBrowserViews().includes(menu)) { win.removeBrowserView(menu); return; }
      if (action === 'plugin-menu-close') return;
      if (!menu) { menu = new BrowserView({ webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: false } }); pluginMenus.set(dir, menu); menu.webContents.loadFile('index.html', { query: { 'plugin-menu': '1' } }); }
      win.addBrowserView(menu); const [width] = win.getContentSize(); menu.setBounds({ x: Math.max(0, width - 432), y: 36, width: 286, height: 208 }); menu.webContents.focus(); return;
    }
    if (action === 'plugin-independent' || action === 'plugin-background' || action === 'plugin-startup') {
      const key = action === 'plugin-independent' ? 'independent' : action === 'plugin-background' ? 'background' : 'pluginStartup';
      const previous = settings[key];
      settings[key] = value ? [...new Set([...previous, dir])] : previous.filter(item => item !== dir);
      try { save(); } catch (error) { settings[key] = previous; throw error; }
      return pluginState();
    }
    throw new Error('无权操作');
  }
  if (![mainWindow, panelWindow].some(w => w && w.webContents === event.sender)) throw new Error('无权操作');
  if (changingFolder && action !== 'state' && action !== 'hide') throw new Error('正在更改插件目录，请稍候。');
  if (action === 'state') return snapshot();
  if (action === 'main-independent' && event.sender === mainWindow.webContents) { const previous = settings.mainIndependent; settings.mainIndependent = !!value; try { save(); } catch (error) { settings.mainIndependent = previous; throw error; } return snapshot(); }
  if (action === 'open') return openPlugin(value);
  if (action === 'hide') return panelWindow && panelWindow.hide();
  if (action === 'manage') { if (panelWindow) panelWindow.hide(); mainWindow.show(); mainWindow.webContents.send('navigate', 'panel'); return; }
  if (action === 'github') return downloadGithub(value);
  if (action === 'github-clear') { clearGithubStaging(); return; }
  if (action === 'pick') {
    pluginDialogs.add(mainWindow);
    let r; try { r = await dialog.showOpenDialog(mainWindow, { title: '选择插件的 plugin.json 文件', properties: ['openFile'], filters: [{ name: '插件配置文件', extensions: ['json'] }] }); } finally { pluginDialogs.delete(mainWindow); }
    if (r.canceled || !r.filePaths.length) return null;
    if (path.basename(r.filePaths[0]).toLowerCase() !== 'plugin.json') throw new Error('请选择名为 plugin.json 的插件配置文件。');
    return displayPlugin(readPlugin(path.dirname(r.filePaths[0])));
  }
  if (action === 'add') return installPlugins([readPlugin(typeof value === 'string' ? value : value.dir)], typeof value === 'object' && value?.replace === true);
  if (action === 'add-many') {
    const dirs = Array.isArray(value) ? value : value?.dirs;
    if (!Array.isArray(dirs) || !dirs.length || dirs.length > 100 || new Set(dirs).size !== dirs.length) throw new Error('请选择要添加的插件。');
    const sources = dirs.map(dir => {
      const plugin = readPlugin(dir);
      if (![...githubStaging].some(root => { const relative = path.relative(fs.realpathSync(root), plugin.dir); return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); })) throw new Error('插件来源已失效，请重新查找。');
      return plugin;
    });
    return installPlugins(sources, !Array.isArray(value) && value?.replace === true);
  }
  if (action === 'remove') {
    const targetDir = typeof value === 'string' ? value : value?.dir;
    const removeData = Boolean(typeof value === 'object' && value?.removeData);
    let removedPlugin = null;
    try { removedPlugin = readPlugin(targetDir); } catch (_) {}
    const win = windows.get(targetDir);
    if (win && !win.isDestroyed()) {
      const contents = [...pluginViews.entries()].find(([, owner]) => owner === win);
      if (contents) { await cleanupPlugin(require('electron').webContents.fromId(contents[0])); pluginExitHandlers.delete(contents[0]); }
    }
    settings.plugins = settings.plugins.filter(x => x !== targetDir); settings.panel = settings.panel.filter(x => x !== targetDir); settings.independent = settings.independent.filter(x => x !== targetDir); settings.background = settings.background.filter(x => x !== targetDir); settings.pluginStartup = settings.pluginStartup.filter(x => x !== targetDir); save();
    if (win && !win.isDestroyed()) await closePluginWindow(win);
    let cleanupFailed = false;
    try {
      const base = pluginFolder();
      if (fs.existsSync(base) && isManagedPluginDir(targetDir, fs.realpathSync(base))) await shell.trashItem(targetDir);
    } catch (error) { console.error('清理已移除插件副本失败:', error); cleanupFailed = true; }
    if (removeData && removedPlugin) {
      try {
        const subdir = resolvePluginDataSubdir(removedPlugin);
        const stillUsed = subdir && plugins().some(p => resolvePluginDataSubdir(p) === subdir);
        if (subdir && !stillUsed) {
          const targets = collectRemovablePluginDataDirs({
            plugin: removedPlugin,
            currentDataRoot: pluginDataFolder(pluginFolder()),
            legacyGlobalRoot: path.join(data, 'plugin-data'),
            legacyUserDataRoot: data,
          });
          for (const targetDataDir of targets) {
            try { await shell.trashItem(targetDataDir); }
            catch (error) { console.error('清理已移除插件数据失败:', targetDataDir, error); cleanupFailed = true; }
          }
        }
      } catch (error) { console.error('清理已移除插件数据失败:', error); cleanupFailed = true; }
    }
    refresh();
    return { ...snapshot(), ...(cleanupFailed ? { warning: '工具已移除，但部分插件文件或数据未能移入回收站。请关闭相关程序后检查插件目录。' } : {}) };
  }
  if (action === 'clean-orphans') return cleanOrphanPluginDirs();
  if (action === 'panel') { const valid = new Set(plugins().map(p => p.dir)); settings.panel = value.filter(x => valid.has(x)); save(); refresh(); return snapshot(); }
  if (action === 'middle') { settings.middle = !!value; save(); refresh(); return snapshot(); }
  if (action === 'autostart') { app.setLoginItemSettings({ openAtLogin: !!value }); settings.autoStart = app.getLoginItemSettings().openAtLogin; save(); refresh(); return snapshot(); }
  if (action === 'auto-check-update') { settings.autoCheckUpdate = !!value; save(); refresh(); return snapshot(); }
  if (action === 'update-check') return checkAppUpdate({ silent: false });
  if (action === 'update-download') return downloadAppUpdate();
  if (action === 'update-cancel') return cancelAppUpdateDownload();
  if (action === 'update-install') return installAppUpdate();
  if (action === 'update-skip') {
    if (typeof value === 'string' && value.trim()) { settings.skippedVersion = value.trim(); save(); }
    if (appUpdate.phase === 'available') { appUpdate.phase = 'idle'; broadcastAppUpdate(); }
    refresh();
    return snapshot();
  }
  if (action === 'open-external') {
    if (typeof value !== 'string' || !isTrustedGithubUrl(value)) throw new Error('不支持打开该链接。');
    await shell.openExternal(value);
    return;
  }
  if (action === 'copy-text') { if (typeof value === 'string') clipboard.writeText(value); return true; }
  if (action === 'folder') { fs.mkdirSync(pluginFolder(), { recursive: true }); const error = await shell.openPath(pluginFolder()); if (error) throw new Error('无法打开插件目录，请检查文件夹是否可访问。'); return; }
  if (action === 'change-folder') {
    changingFolder = true;
    pluginDialogs.add(mainWindow);
    try {
      const result = await dialog.showOpenDialog(mainWindow, { title: '选择插件存放位置（自动创建 qingxia-plugin 文件夹）', properties: ['openDirectory', 'createDirectory'] });
      if (result.canceled || !result.filePaths.length) return snapshot();
      const warning = await changePluginFolder(result.filePaths[0]); refresh(); return { ...snapshot(), warning };
    }
    finally { pluginDialogs.delete(mainWindow); changingFolder = false; }
  }
  throw new Error('不支持的操作');
}
ipcMain.on('host-path', (e, name) => {
  if (name === 'pluginData') {
    const root = pluginDataFolder(pluginFolder());
    try { fs.mkdirSync(root, { recursive: true }); } catch (_) {}
    e.returnValue = root;
    return;
  }
  e.returnValue = name === 'userData' && pluginDataRoots.has(e.sender.id) ? pluginDataRoots.get(e.sender.id) : ['userData', 'downloads', 'desktop', 'documents', 'temp'].includes(name) ? app.getPath(name) : '';
});
ipcMain.handle('host-dialog', async (e, options) => { const owner = pluginViews.get(e.sender.id) || BrowserWindow.fromWebContents(e.sender); if (owner) pluginDialogs.add(owner); try { const result = await dialog.showOpenDialog(owner, options); return result.canceled ? undefined : result.filePaths; } finally { if (owner) pluginDialogs.delete(owner); } });
ipcMain.handle('host-open', (e, p) => shell.openPath(p));
ipcMain.handle('host-show', (e, p) => shell.showItemInFolder(p));
ipcMain.on('host-hide-main-window', e => { const owner = pluginViews.get(e.sender.id); if (!owner || owner.isDestroyed() || !owner.isVisible()) { e.returnValue = false; return; } e.returnValue = true; setImmediate(() => { if (!owner.isDestroyed()) owner.close(); }); });

}
