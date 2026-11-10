'use strict';
const { app, BrowserWindow, BrowserView, ipcMain, dialog, shell, screen, Tray, Menu, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { uIOhook } = require('uiohook-napi');

app.setName('轻匣');
app.setPath('userData', path.join(app.getPath('appData'), '个人工具箱'));
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else app.on('second-instance', showMain);
const bundle = app.isPackaged ? path.join(process.resourcesPath, 'bundle') : path.join(__dirname, 'resources');
const data = app.getPath('userData');
const settingsFile = path.join(data, 'toolbox.json');
let settings = { version: 1, plugins: [], panel: [], independent: [], middle: true, autoStart: false };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch (_) {}
function save() { fs.mkdirSync(data, { recursive: true }); const tmp = settingsFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(settings, null, 2)); fs.renameSync(tmp, settingsFile); }
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
  return { dir: root, main, preload, icon, name: (Array.isArray(feature.cmds) ? feature.cmds : []).find(x => typeof x === 'string') || feature.code || path.basename(root), description: feature.description || '', code: feature.code || '' };
}
function displayPlugin(p) { return { ...p, icon: p.icon ? require('node:url').pathToFileURL(p.icon).href : '' }; }
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
const pluginDialogs = new Set();
let changingFolder = false;
function pluginFolder() { return settings.pluginFolder || path.join(data, 'plugins'); }
async function changePluginFolder(target) {
  if ([...windows.values()].some(win => !win.isDestroyed())) throw new Error('请先关闭已打开的插件窗口，再更改插件目录。');
  const destination = fs.realpathSync(target);
  if (!fs.statSync(destination).isDirectory()) throw new Error('请选择有效的文件夹。');
  if (path.resolve(destination).toLowerCase() === path.resolve(pluginFolder()).toLowerCase()) return;
  const oldFolder = pluginFolder();
  const sources = settings.plugins.map(dir => ({ original: dir, plugin: readPlugin(dir) }));
  for (const { plugin } of sources) {
    const relative = path.relative(plugin.dir, destination);
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('新目录不能位于已安装插件的文件夹内。');
  }
  const mapping = new Map();
  for (const { original, plugin } of sources) {
    const targetDir = path.join(destination, require('node:crypto').randomUUID());
    await fs.promises.cp(plugin.dir, targetDir, { recursive: true, errorOnExist: true, force: false, filter: source => { if (fs.lstatSync(source).isSymbolicLink()) throw new Error('插件中包含快捷链接，无法安全复制；原目录没有改变。'); return true; } });
    mapping.set(original, readPlugin(targetDir).dir);
  }
  const previous = settings;
  settings = { ...settings, pluginFolder: destination, plugins: settings.plugins.map(dir => mapping.get(dir)), panel: settings.panel.map(dir => mapping.get(dir) || dir), independent: settings.independent.map(dir => mapping.get(dir) || dir) };
  try { save(); } catch (error) { settings = previous; throw error; }
  let cleanupFailed = false;
  for (const { plugin } of sources) {
    if (path.dirname(plugin.dir).toLowerCase() !== path.resolve(oldFolder).toLowerCase() || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(path.basename(plugin.dir))) { cleanupFailed = true; continue; }
    try { await shell.trashItem(plugin.dir); } catch (error) { console.error('清理旧插件目录失败:', error); cleanupFailed = true; }
  }
  try { fs.rmdirSync(oldFolder); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) cleanupFailed = true; }
  return cleanupFailed ? '插件已迁移到新目录，但部分旧插件文件未能清理，请检查原目录。' : '';
}
function plugins() { return settings.plugins.flatMap(dir => { try { return [readPlugin(dir)]; } catch (_) { return []; } }); }
function snapshot() { return { plugins: plugins().map(displayPlugin), panel: settings.panel, middle: settings.middle, autoStart: settings.autoStart, version: app.getVersion(), folder: pluginFolder(), appIcon: require('node:url').pathToFileURL(path.join(bundle, 'app-icon.png')).href }; }
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
function openPlugin(dir) {
  const plugin = plugins().find(p => p.dir === dir); if (!plugin) throw new Error('工具不存在');
  if (windows.has(dir) && !windows.get(dir).isDestroyed()) { windows.get(dir).show(); windows.get(dir).focus(); return; }
  const win = new BrowserWindow({ width: 900, height: 760, minWidth: 650, minHeight: 500, title: plugin.name, icon: path.join(bundle, 'app-icon.ico'), titleBarStyle: 'hidden', titleBarOverlay: { color: '#faf8f4', symbolColor: '#163529', height: 36 }, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: false } });
  const view = new BrowserView({ webPreferences: { preload: path.join(__dirname, 'plugin-preload.cjs'), sandbox: false, contextIsolation: false, nodeIntegration: false, additionalArguments: ['--toolbox-plugin=' + encodeURIComponent(plugin.preload), '--toolbox-code=' + encodeURIComponent(plugin.code), '--toolbox-browser=' + encodeURIComponent(path.join(bundle, 'chromium', 'chrome.exe'))] } });
  const contents = view.webContents;
  win.setMenu(null);
  windows.set(dir, win); pluginViews.set(contents.id, win);
  win.setBrowserView(view);
  const layout = () => { const [width, height] = win.getContentSize(); view.setBounds({ x: 0, y: 36, width, height: Math.max(0, height - 36) }); };
  layout(); win.on('resize', layout);
  win.on('blur', () => { if (!settings.independent.includes(dir) && !pluginDialogs.has(win) && !win.isDestroyed()) win.hide(); });
  win.on('closed', () => { windows.delete(dir); pluginViews.delete(contents.id); pluginDialogs.delete(win); if (!contents.isDestroyed()) contents.close(); });
  contents.on('will-navigate', (event, url) => { if (!url.startsWith('file:')) event.preventDefault(); });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile('index.html', { query: { plugin: '1' } });
  contents.loadFile(plugin.main); if (panelWindow) panelWindow.hide();
}
app.whenReady().then(async () => {
  if (!singleInstance) return;
  Menu.setApplicationMenu(null);
  fs.mkdirSync(data, { recursive: true });
  mainWindow = new BrowserWindow({ width: 1000, height: 740, minWidth: 700, minHeight: 550, title: '轻匣', icon: path.join(bundle, 'app-icon.ico'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: false } });
  mainWindow.setMenu(null);
  mainWindow.loadFile('index.html'); mainWindow.on('close', e => { if (!app.quitting) { e.preventDefault(); mainWindow.hide(); } });
  tray = new Tray(nativeImage.createFromPath(path.join(bundle, 'app-icon.png')).resize({ width: 16, height: 16 }));
  tray.setToolTip('轻匣'); tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开轻匣', click: showMain }, { label: '退出', click: () => { app.quitting = true; app.quit(); } }])); tray.on('click', showMain);
  try { uIOhook.on('mousedown', e => { if (e.button === 3 && settings.middle) showPanel(); }); uIOhook.start(); } catch (error) { console.error('鼠标快捷面板不可用:', error); const notice = () => mainWindow.webContents.send('notice', '鼠标中键快捷面板暂时不可用，请重启工具箱后重试。'); if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', notice); else notice(); }
});
app.on('before-quit', () => { app.quitting = true; try { uIOhook.stop(); } catch (_) {} });
ipcMain.handle('toolbox', async (event, action, value) => {
  try { return { ok: true, value: await toolboxAction(event, action, value) }; }
  catch (error) { console.error('工具箱操作失败:', action, error); return { ok: false, message: friendlyError(error) }; }
});
async function toolboxAction(event, action, value) {
  const pluginEntry = [...windows.entries()].find(([, win]) => win.webContents === event.sender);
  if (pluginEntry) {
    const [dir] = pluginEntry;
    if (action === 'plugin-state') return { name: readPlugin(dir).name, independent: settings.independent.includes(dir) };
    if (action === 'plugin-independent') {
      const previous = settings.independent;
      settings.independent = value ? [...new Set([...previous, dir])] : previous.filter(item => item !== dir);
      try { save(); } catch (error) { settings.independent = previous; throw error; }
      return { name: readPlugin(dir).name, independent: settings.independent.includes(dir) };
    }
    throw new Error('无权操作');
  }
  if (![mainWindow, panelWindow].some(w => w && w.webContents === event.sender)) throw new Error('无权操作');
  if (changingFolder && action !== 'state' && action !== 'hide') throw new Error('正在更改插件目录，请稍候。');
  if (action === 'state') return snapshot();
  if (action === 'open') return openPlugin(value);
  if (action === 'hide') return panelWindow && panelWindow.hide();
  if (action === 'manage') { if (panelWindow) panelWindow.hide(); mainWindow.show(); mainWindow.webContents.send('navigate', 'panel'); return; }
  if (action === 'github') return downloadGithub(value);
  if (action === 'github-clear') { clearGithubStaging(); return; }
  if (action === 'pick') {
    const r = await dialog.showOpenDialog(mainWindow, { title: '选择插件的 plugin.json 文件', properties: ['openFile'], filters: [{ name: '插件配置文件', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths.length) return null;
    if (path.basename(r.filePaths[0]).toLowerCase() !== 'plugin.json') throw new Error('请选择名为 plugin.json 的插件配置文件。');
    return displayPlugin(readPlugin(path.dirname(r.filePaths[0])));
  }
  if (action === 'add') { const p = readPlugin(value); const base = pluginFolder(); fs.mkdirSync(base, { recursive: true }); const target = path.join(base, require('node:crypto').randomUUID()); fs.cpSync(p.dir, target, { recursive: true, errorOnExist: true, force: false, filter: source => !fs.lstatSync(source).isSymbolicLink() }); const installed = readPlugin(target); settings.plugins.push(installed.dir); save(); clearGithubStaging(); refresh(); return snapshot(); }
  if (action === 'remove') { settings.plugins = settings.plugins.filter(x => x !== value); settings.panel = settings.panel.filter(x => x !== value); settings.independent = settings.independent.filter(x => x !== value); save(); refresh(); return snapshot(); }
  if (action === 'panel') { const valid = new Set(plugins().map(p => p.dir)); settings.panel = value.filter(x => valid.has(x)); save(); refresh(); return snapshot(); }
  if (action === 'middle') { settings.middle = !!value; save(); refresh(); return snapshot(); }
  if (action === 'autostart') { app.setLoginItemSettings({ openAtLogin: !!value }); settings.autoStart = app.getLoginItemSettings().openAtLogin; save(); refresh(); return snapshot(); }
  if (action === 'folder') { fs.mkdirSync(pluginFolder(), { recursive: true }); const error = await shell.openPath(pluginFolder()); if (error) throw new Error('无法打开插件目录，请检查文件夹是否可访问。'); return; }
  if (action === 'change-folder') {
    changingFolder = true;
    try {
      const result = await dialog.showOpenDialog(mainWindow, { title: '选择新的插件目录', properties: ['openDirectory', 'createDirectory'] });
      if (result.canceled || !result.filePaths.length) return snapshot();
      const warning = await changePluginFolder(result.filePaths[0]); refresh(); return { ...snapshot(), warning };
    }
    finally { changingFolder = false; }
  }
  throw new Error('不支持的操作');
}
ipcMain.on('host-path', (e, name) => { e.returnValue = ['userData', 'downloads', 'desktop', 'documents', 'temp'].includes(name) ? app.getPath(name) : ''; });
ipcMain.handle('host-dialog', async (e, options) => { const owner = pluginViews.get(e.sender.id) || BrowserWindow.fromWebContents(e.sender); if (owner) pluginDialogs.add(owner); try { const result = await dialog.showOpenDialog(owner, options); return result.canceled ? undefined : result.filePaths; } finally { if (owner) pluginDialogs.delete(owner); } });
ipcMain.handle('host-open', (e, p) => shell.openPath(p));
ipcMain.handle('host-show', (e, p) => shell.showItemInFolder(p));
