'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const field of ['main', 'preload', 'logo']) {
  const file = path.resolve(root, manifest[field]);
  if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile()) throw new Error(`Missing/unsafe ${field}`);
}
for (const feature of manifest.features) for (const cmd of feature.cmds) {
  if (typeof cmd !== 'string' && cmd.type === 'regex') {
    const match = /^\/(.*)\/([a-z]*)$/.exec(cmd.match);
    if (!match) throw new Error('Invalid uTools regex command');
    new RegExp(match[1], match[2]);
  }
}
function check(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !['node_modules', 'dist'].includes(entry.name)) check(path.join(directory, entry.name));
    if (entry.isFile() && /\.(?:cjs|js)$/.test(entry.name)) {
      const filename = path.join(directory, entry.name);
      new vm.Script(fs.readFileSync(filename, 'utf8'), { filename });
    }
  }
}
check(root);
const html = fs.readFileSync(path.join(root, manifest.main), 'utf8');
if (!html.includes("connect-src 'none'") || !html.includes("script-src 'self'")) throw new Error('Renderer security policy missing');
console.log('Manifest, feature regex, files, CSP and JavaScript syntax: OK');
