'use strict';

// 静态自检：不依赖 uTools 宿主，检查插件包完整性、CSP、外部资源与语法。
// 用法：node scripts/check.cjs
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const problems = [];
const notes = [];

function fail(message) { problems.push(message); }
function note(message) { notes.push(message); }
function read(file) {
  try { return fs.readFileSync(path.join(root, file), 'utf8'); } catch (error) { fail(`缺少或无法读取 ${file}：${error.message}`); return null; }
}
function exists(file) { return fs.existsSync(path.join(root, file)); }

// 1) 清单
let manifest = null;
const manifestText = read('plugin.json');
if (manifestText !== null) {
  try { manifest = JSON.parse(manifestText); } catch (error) { fail(`plugin.json 不是合法 JSON：${error.message}`); }
}
if (manifest) {
  for (const key of ['main', 'preload', 'logo']) {
    if (typeof manifest[key] !== 'string' || !manifest[key]) fail(`plugin.json 缺少 ${key}`);
    else if (!exists(manifest[key])) fail(`plugin.json 指向的 ${key} 文件不存在：${manifest[key]}`);
  }
  const features = Array.isArray(manifest.features) ? manifest.features : [];
  if (features.length === 0) fail('plugin.json 至少需要一个 feature');
  features.forEach((feature, index) => {
    if (!feature || typeof feature.code !== 'string' || !feature.code) fail(`features[${index}].code 缺失`);
    if (!Array.isArray(feature.cmds) || feature.cmds.length === 0) fail(`features[${index}].cmds 不能为空`);
    if (typeof feature.explain !== 'string' && typeof feature.description !== 'string') fail(`features[${index}] 缺少 explain`);
  });
  if (manifest.pluginSetting && manifest.pluginSetting.single !== true) note('pluginSetting.single 未设为 true，可能出现多窗口');
}

// 2) 依赖必须为空（插件不能装 npm 依赖）
const pkgText = read('package.json');
if (pkgText !== null) {
  try {
    const pkg = JSON.parse(pkgText);
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const deps = pkg[field];
      if (deps && Object.keys(deps).length > 0) fail(`package.json 的 ${field} 必须为空（插件零依赖）`);
    }
    if (!pkg.version) fail('package.json 缺少 version');
  } catch (error) { fail(`package.json 不是合法 JSON：${error.message}`); }
}

// 3) HTML：CSP、本地资源、无外链
const html = read('index.html');
if (html !== null) {
  if (!/<meta[^>]+http-equiv="Content-Security-Policy"/i.test(html)) fail('index.html 缺少 Content-Security-Policy');
  if (!/default-src 'none'/i.test(html)) fail('CSP 应以 default-src \'none\' 为基础');
  if (/<script[^>]+src="(?:https?:)?\/\//i.test(html)) fail('index.html 引用了外部脚本');
  if (/<link[^>]+href="(?:https?:)?\/\//i.test(html)) fail('index.html 引用了外部样式');
  if (!/src="\.\/app\.js"/.test(html)) fail('index.html 未引用 ./app.js');
  if (!/href="\.\/styles\.css"/.test(html)) fail('index.html 未引用 ./styles.css');
  if (!/<html[^>]+lang="zh-CN"/i.test(html)) note('index.html 未声明 lang="zh-CN"');
}

// 4) 静态资源不能真的去加载外部资源（纯文本里出现地址是允许的，例如默认 API 地址说明）
//    渲染进程也不允许自己发网络请求，网络必须走 preload。
const EXTERNAL_LOADERS = [
  { name: '外部脚本', re: /<script[^>]+src\s*=\s*["']?(?:https?:)?\/\//i },
  { name: '外部样式', re: /<link[^>]+href\s*=\s*["']?(?:https?:)?\/\//i },
  { name: '外部 @import', re: /@import\s+(?:url\()?\s*["']?https?:\/\//i },
  { name: '外部 css url()', re: /url\(\s*["']?https?:\/\//i },
  { name: '渲染进程直连网络', re: /\bfetch\s*\(\s*["']https?:\/\/|new\s+XMLHttpRequest|\.open\s*\(\s*["'](?:GET|POST)["']\s*,\s*["']https?:\/\//i },
  { name: '外部动态 import', re: /import\s*\(\s*["']https?:\/\//i }
];
for (const file of ['app.js', 'styles.css', 'preload.js', 'index.html']) {
  if (!exists(file)) { fail(`缺少 ${file}`); continue; }
  const text = read(file) || '';
  for (const rule of EXTERNAL_LOADERS) {
    if (rule.re.test(text)) fail(`${file} 使用了${rule.name}`);
  }
}
// 核心模块（preload 侧）只允许 https 请求 GitHub/frp 官方地址
for (const file of ['core/binary.cjs', 'core/service.cjs']) {
  if (!exists(file)) continue;
  const text = read(file) || '';
  for (const match of text.matchAll(/["'`](https?:\/\/[^"'`\s]+)["'`]/g)) {
    const url = match[1];
    const allowed = /^https:\/\/(?:api\.github\.com|github\.com|ghproxy\.net|gh-proxy\.com)\//.test(url);
    if (!allowed) note(`${file} 出现非白名单网络地址：${url}`);
  }
}

// 5) preload 的 require 必须都能解析到真实文件
if (exists('preload.js')) {
  const preload = read('preload.js') || '';
  for (const match of preload.matchAll(/require\('(\.\/[^']+)'\)/g)) {
    const target = path.resolve(root, match[1]);
    if (!fs.existsSync(target) && !fs.existsSync(`${target}.cjs`) && !fs.existsSync(`${target}.js`)) {
      fail(`preload.js 引用了不存在的模块：${match[1]}`);
    }
  }
  for (const match of preload.matchAll(/require\('(node:[^']+)'\)/g)) {
    try { require.resolve(match[1]); } catch (error) { fail(`preload.js 引用了不可用的内置模块 ${match[1]}：${error.message}`); }
  }
}

// 6) 语法检查：所有 .js / .cjs（排除 scripts 自身与 tests 由 node --test 负责）
function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(cjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const files = [];
for (const dir of ['core', '']) if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir), files);
for (const file of new Set(files)) {
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); }
  catch (error) { fail(`语法错误 ${path.relative(root, file)}：${String(error.stderr || error.message).trim().split('\n')[0]}`); }
}

// 7) 图标
if (exists('logo.png')) {
  const buf = fs.readFileSync(path.join(root, 'logo.png'));
  const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!isPng) fail('logo.png 不是合法 PNG');
  else {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width < 64 || height < 64) fail(`logo.png 尺寸过小：${width}x${height}，建议 >=256`);
    if (width !== height) note(`logo.png 非正方形：${width}x${height}`);
    note(`logo.png ${width}x${height}`);
  }
} else fail('缺少 logo.png');

// 8) 关键模块
for (const file of ['core/service.cjs', 'core/config.cjs', 'core/binary.cjs', 'core/runner.cjs', 'core/store.cjs', 'core/zip.cjs']) {
  if (!exists(file)) fail(`缺少核心模块 ${file}`);
}

if (problems.length > 0) {
  console.error(`自检失败（${problems.length} 项）：`);
  problems.forEach((problem) => console.error(` - ${problem}`));
  process.exitCode = 1;
} else {
  if (notes.length > 0) notes.forEach((message) => console.log(`· ${message}`));
  console.log('自检通过：插件结构、CSP、零依赖、语法与资源引用均正常。');
}
