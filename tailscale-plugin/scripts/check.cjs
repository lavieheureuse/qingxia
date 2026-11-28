'use strict';

// 静态结构与规范自检：不依赖轻匣宿主，检查清单、零依赖、CSP、禁用宿主 API、语法、符号链接与体积。
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const problems = [];
const notes = [];

function fail(msg) {
  problems.push(msg);
}
function note(msg) {
  notes.push(msg);
}
function read(rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch (error) {
    fail(`缺少或无法读取 ${rel}：${error.message}`);
    return null;
  }
}
function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

// 1) plugin.json 校验
const manifestText = read('plugin.json');
let manifest = null;
if (manifestText !== null) {
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    fail(`plugin.json 不是合法 JSON：${error.message}`);
  }
}
if (manifest) {
  if (typeof manifest.id !== 'string' || !/^[a-z0-9][a-z0-9.-]{2,}$/i.test(manifest.id)) {
    fail('plugin.json 必须包含稳定的唯一 id（例如 com.qingxia.tailscale）');
  }
  for (const key of ['main', 'preload', 'logo']) {
    if (typeof manifest[key] !== 'string' || !manifest[key]) fail(`plugin.json 缺少 ${key}`);
    else if (!exists(manifest[key])) fail(`plugin.json 指向的 ${key} 不存在：${manifest[key]}`);
  }
  const features = Array.isArray(manifest.features) ? manifest.features : [];
  if (features.length === 0) fail('plugin.json 至少需要一个 features 条目');
  else {
    const f0 = features[0];
    if (!f0 || typeof f0.code !== 'string' || !f0.code) fail('features[0].code 缺失');
    if (!Array.isArray(f0.cmds) || typeof f0.cmds[0] !== 'string' || !f0.cmds[0]) fail('features[0].cmds 不能为空');
    if (typeof f0.description !== 'string' || !f0.description) fail('features[0].description 缺失');
  }
}

// 2) package.json 零运行时依赖
const pkgText = read('package.json');
if (pkgText !== null) {
  try {
    const pkg = JSON.parse(pkgText);
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      if (pkg[field] && Object.keys(pkg[field]).length > 0) {
        fail(`package.json 的 ${field} 必须为空（插件零依赖）`);
      }
    }
    if (!pkg.version) fail('package.json 缺少 version');
  } catch (error) {
    fail(`package.json 不是合法 JSON：${error.message}`);
  }
}

// 3) index.html CSP 与本地资源校验
const html = read('index.html');
if (html !== null) {
  if (!/<meta[^>]+http-equiv="Content-Security-Policy"/i.test(html)) fail('index.html 缺少 Content-Security-Policy');
  if (!/default-src 'none'/i.test(html)) fail("CSP 应以 default-src 'none' 为基础");
  if (!/connect-src 'none'/i.test(html)) fail("CSP 应限制 connect-src 'none'");
  if (!/src="\.\/app\.js"/.test(html)) fail('index.html 未引用 ./app.js');
  if (!/href="\.\/styles\.css"/.test(html)) fail('index.html 未引用 ./styles.css');
}

// 4) 禁止外部加载、window.open 与轻匣未实现宿主接口
const EXTERNAL_RULES = [
  { name: '外部脚本', re: /<script[^>]+src\s*=\s*["']?(?:https?:)?\/\//i },
  { name: '外部样式', re: /<link[^>]+href\s*=\s*["']?(?:https?:)?\/\//i },
  { name: '外部 @import', re: /@import\s+(?:url\()?\s*["']?https?:\/\//i },
  { name: '外部 css url()', re: /url\(\s*["']?https?:\/\//i },
  { name: '渲染进程网络请求', re: /\bfetch\s*\(|new\s+XMLHttpRequest/i },
  { name: 'window.open 调用', re: /\bwindow\.open\s*\(/i },
];

for (const file of ['index.html', 'app.js', 'styles.css']) {
  const text = read(file);
  if (text === null) continue;
  for (const rule of EXTERNAL_RULES) {
    if (rule.re.test(text)) fail(`${file} 触发禁用规则：${rule.name}`);
  }
}

const FORBIDDEN_HOST_APIS = [
  /\butools\.dbStorage\b/,
  /\butools\.db\b/,
  /\bonPluginOut\b/,
  /\bshellOpenExternal\b/,
  /\bubrowser\b/i,
  /\bsetSubInput\b/,
];

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      fail(`禁止存在符号链接：${path.relative(root, full)}`);
      continue;
    }
    if (entry.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

const allFiles = walkFiles(root);
let totalBytes = 0;

for (const full of allFiles) {
  const rel = path.relative(root, full).replace(/\\/g, '/');
  totalBytes += fs.statSync(full).size;

  if (/\.(cjs|js)$/.test(rel) && !rel.startsWith('tests/') && rel !== 'scripts/check.cjs') {
    const content = fs.readFileSync(full, 'utf8');
    for (const apiRe of FORBIDDEN_HOST_APIS) {
      if (apiRe.test(content)) {
        fail(`${rel} 使用了轻匣未实现的宿主接口（匹配 ${apiRe}）`);
      }
    }
  }

  if (/\.(cjs|js)$/.test(rel)) {
    try {
      execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
    } catch (error) {
      fail(`语法错误 ${rel}：${String(error.stderr || error.message).trim().split('\n')[0]}`);
    }
  }
}

// 5) preload.js require 可解析性与内置模块检查
const preloadText = read('preload.js');
if (preloadText !== null) {
  for (const match of preloadText.matchAll(/require\('(\.\/[^']+)'\)/g)) {
    const target = path.resolve(root, match[1]);
    if (!fs.existsSync(target) && !fs.existsSync(`${target}.cjs`) && !fs.existsSync(`${target}.js`)) {
      fail(`preload.js 引用了不存在的模块：${match[1]}`);
    }
  }
  for (const match of preloadText.matchAll(/require\('(node:[^']+)'\)/g)) {
    try {
      require.resolve(match[1]);
    } catch (error) {
      fail(`preload.js 引用了不可用的内置模块 ${match[1]}：${error.message}`);
    }
  }
}

// 6) logo.png 校验（合法正方形 PNG，>= 64x64）
if (exists('logo.png')) {
  const buf = fs.readFileSync(path.join(root, 'logo.png'));
  const isPng = buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!isPng) {
    fail('logo.png 不是有效的 PNG 图片');
  } else {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width < 64 || height < 64) fail(`logo.png 尺寸过小：${width}x${height}`);
    if (width !== height) fail(`logo.png 必须是正方形（当前 ${width}x${height}）`);
    note(`logo.png ${width}x${height}`);
  }
} else {
  fail('缺少 logo.png');
}

// 7) 核心模块存在性 & 体积检查
const requiredCore = [
  'core/node-fetch.cjs',
  'core/redact.cjs',
  'core/config.cjs',
  'core/win-ps.cjs',
  'core/binary.cjs',
  'core/status.cjs',
  'core/diagnostics.cjs',
  'core/daemon.cjs',
  'core/service.cjs',
  'README.md',
];
for (const rel of requiredCore) {
  if (!exists(rel)) fail(`缺少必需文件：${rel}`);
}

const maxBytes = 50 * 1024 * 1024;
if (totalBytes > maxBytes) {
  fail(`插件目录体积过大（${(totalBytes / 1024 / 1024).toFixed(2)} MB），超出 GitHub 导入预算`);
} else {
  note(`插件总大小 ${(totalBytes / 1024).toFixed(1)} KB（${allFiles.length} 个文件）`);
}

if (problems.length > 0) {
  console.error(`自检失败（${problems.length} 项）：`);
  for (const problem of problems) console.error(` - ${problem}`);
  process.exitCode = 1;
} else {
  for (const item of notes) console.log(`· ${item}`);
  console.log('自检通过：plugin.json、CSP、宿主边界、零依赖、语法与图标均符合轻匣插件规范。');
}
