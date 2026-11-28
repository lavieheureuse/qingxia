'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  pluginDataFolder,
  resolvePluginDataSubdir,
  moveDirSafe,
  migrateSinglePluginData,
  migrateInstalledPluginsDataOnStartup,
  collectRemovablePluginDataDirs,
  copyPluginDataRoot,
  isManagedPluginDataDir,
} = require('../plugin-storage.cjs');

test('resolvePluginDataSubdir resolves legacy plugins, pluginId, and rejects unsafe names', () => {
  assert.equal(resolvePluginDataSubdir({ code: 'frpc', name: 'frpc' }), 'frpc-utools');
  assert.equal(resolvePluginDataSubdir({ code: 'tailscale', name: 'Tailscale', pluginId: 'com.qingxia.tailscale' }), 'com.qingxia.tailscale');
  assert.equal(resolvePluginDataSubdir({ code: 'x', name: 'x', pluginId: '../escape' }), '');
});

test('moveDirSafe handles same-drive rename and simulated EXDEV cross-drive copy+cleanup', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-move-'));
  try {
    const src1 = path.join(tmp, 'src1');
    const dst1 = path.join(tmp, 'dst1');
    fs.mkdirSync(src1);
    fs.writeFileSync(path.join(src1, 'a.txt'), 'hello');
    moveDirSafe(src1, dst1);
    assert.equal(fs.existsSync(src1), false);
    assert.equal(fs.readFileSync(path.join(dst1, 'a.txt'), 'utf8'), 'hello');

    const src2 = path.join(tmp, 'src2');
    const dst2 = path.join(tmp, 'dst2');
    fs.mkdirSync(src2);
    fs.writeFileSync(path.join(src2, 'b.txt'), 'cross-drive');
    moveDirSafe(src2, dst2, {
      renameSync: () => {
        const err = new Error('EXDEV');
        err.code = 'EXDEV';
        throw err;
      },
    });
    assert.equal(fs.existsSync(src2), false);
    assert.equal(fs.readFileSync(path.join(dst2, 'b.txt'), 'utf8'), 'cross-drive');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('migrateSinglePluginData moves legacy global C: plugin-data into <pluginFolder>/plugin-data and handles conflicts safely', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-mig-'));
  try {
    const targetRoot = pluginDataFolder(path.join(tmp, 'D-drive', 'qingxia-plugin'));
    const legacyGlobalRoot = path.join(tmp, 'C-drive', 'plugin-data');
    const legacyUserDataRoot = path.join(tmp, 'C-drive');

    const plugin = { code: 'tailscale', name: 'Tailscale', pluginId: 'com.qingxia.tailscale' };
    const oldTs = path.join(legacyGlobalRoot, 'com.qingxia.tailscale');
    fs.mkdirSync(oldTs, { recursive: true });
    fs.writeFileSync(path.join(oldTs, 'config.json'), '{"ok":true}');

    const res1 = migrateSinglePluginData({ plugin, targetRoot, legacyGlobalRoot, legacyUserDataRoot });
    assert.equal(res1.subdir, 'com.qingxia.tailscale');
    assert.equal(fs.existsSync(oldTs), false);
    assert.equal(fs.readFileSync(path.join(targetRoot, 'com.qingxia.tailscale', 'config.json'), 'utf8'), '{"ok":true}');

    // 冲突场景：同时存在新旧数据时按用户选择备份另一份
    fs.mkdirSync(oldTs, { recursive: true });
    fs.writeFileSync(path.join(oldTs, 'config.json'), '{"old":true}');
    const resCancel = migrateSinglePluginData({
      plugin,
      targetRoot,
      legacyGlobalRoot,
      legacyUserDataRoot,
      resolveConflict: () => 'cancel',
    });
    assert.equal(resCancel, null);

    const resUseOld = migrateSinglePluginData({
      plugin,
      targetRoot,
      legacyGlobalRoot,
      legacyUserDataRoot,
      resolveConflict: () => 'use-old',
    });
    assert.equal(resUseOld.subdir, 'com.qingxia.tailscale');
    assert.equal(fs.readFileSync(path.join(targetRoot, 'com.qingxia.tailscale', 'config.json'), 'utf8'), '{"old":true}');
    const backups = fs.readdirSync(legacyGlobalRoot).filter((n) => n.startsWith('com.qingxia.tailscale-backup-'));
    assert.equal(backups.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('copyPluginDataRoot copies plugin-data when changing folder and rejects collisions', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-cp-'));
  try {
    const oldFolder = path.join(tmp, 'old-qingxia');
    const newFolder = path.join(tmp, 'new-qingxia');
    fs.mkdirSync(path.join(oldFolder, 'plugin-data', 'com.qingxia.tailscale'), { recursive: true });
    fs.writeFileSync(path.join(oldFolder, 'plugin-data', 'com.qingxia.tailscale', 'state.txt'), '1');

    const res = copyPluginDataRoot({ oldFolder, newFolder });
    assert.equal(res.migrated, true);
    assert.equal(fs.readFileSync(path.join(newFolder, 'plugin-data', 'com.qingxia.tailscale', 'state.txt'), 'utf8'), '1');

    assert.throws(
      () => copyPluginDataRoot({ oldFolder, newFolder }),
      /已存在同名数据/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('isManagedPluginDataDir only accepts direct safe children of plugin-data', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-safe-'));
  try {
    const root = path.join(tmp, 'plugin-data');
    const valid = path.join(root, 'com.qingxia.tailscale');
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(valid, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });

    assert.equal(isManagedPluginDataDir(valid, root), true);
    assert.equal(isManagedPluginDataDir(root, root), false);
    assert.equal(isManagedPluginDataDir(outside, root), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('migrateInstalledPluginsDataOnStartup moves non-conflicting data and skips conflicts for interactive open', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-boot-'));
  try {
    const targetRoot = pluginDataFolder(path.join(tmp, 'user-folder'));
    const legacyGlobalRoot = path.join(tmp, 'appdata', 'plugin-data');
    const legacyUserDataRoot = path.join(tmp, 'appdata');

    const pClean = { code: 'tailscale', name: 'Tailscale', pluginId: 'com.qingxia.tailscale' };
    const pConflict = { code: 'password-box', name: '密码盒', pluginId: '' };

    fs.mkdirSync(path.join(legacyGlobalRoot, 'com.qingxia.tailscale'), { recursive: true });
    fs.writeFileSync(path.join(legacyGlobalRoot, 'com.qingxia.tailscale', 'cfg.json'), 'clean');

    fs.mkdirSync(path.join(legacyGlobalRoot, 'password-box'), { recursive: true });
    fs.writeFileSync(path.join(legacyGlobalRoot, 'password-box', 'db.json'), 'old');
    fs.mkdirSync(path.join(targetRoot, 'password-box'), { recursive: true });
    fs.writeFileSync(path.join(targetRoot, 'password-box', 'db.json'), 'new');

    const summary = migrateInstalledPluginsDataOnStartup({
      installedPlugins: [pClean, pConflict],
      targetRoot,
      legacyGlobalRoot,
      legacyUserDataRoot,
    });

    assert.deepEqual(summary.migrated, ['com.qingxia.tailscale']);
    assert.deepEqual(summary.skipped, ['password-box']);
    assert.deepEqual(summary.errors, []);
    assert.equal(fs.readFileSync(path.join(targetRoot, 'com.qingxia.tailscale', 'cfg.json'), 'utf8'), 'clean');
    assert.equal(fs.readFileSync(path.join(legacyGlobalRoot, 'password-box', 'db.json'), 'utf8'), 'old');
    assert.equal(fs.readFileSync(path.join(targetRoot, 'password-box', 'db.json'), 'utf8'), 'new');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('collectRemovablePluginDataDirs collects current and unmigrated legacy data dirs without duplicates', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-del-'));
  try {
    const currentDataRoot = path.join(tmp, 'custom', 'plugin-data');
    const legacyGlobalRoot = path.join(tmp, 'appdata', 'plugin-data');
    const legacyUserDataRoot = path.join(tmp, 'appdata');

    const legacyPlugin = { code: 'hosts-editor', name: 'Hosts 快速编辑', pluginId: '' };
    const d1 = path.join(currentDataRoot, 'hosts-editor');
    const d2 = path.join(legacyGlobalRoot, 'hosts-editor');
    const d3 = path.join(legacyUserDataRoot, 'hosts-editor');
    fs.mkdirSync(d1, { recursive: true });
    fs.mkdirSync(d2, { recursive: true });
    fs.mkdirSync(d3, { recursive: true });

    const dirs = collectRemovablePluginDataDirs({
      plugin: legacyPlugin,
      currentDataRoot,
      legacyGlobalRoot,
      legacyUserDataRoot,
    });
    assert.deepEqual(dirs, [d1, d2, d3]);

    // 现代插件（非 legacy）不会收集 legacyUserDataRoot 下的同名目录
    const modernPlugin = { code: 'ts', name: 'TS', pluginId: 'com.qingxia.tailscale' };
    fs.mkdirSync(path.join(legacyUserDataRoot, 'com.qingxia.tailscale'), { recursive: true });
    fs.mkdirSync(path.join(legacyGlobalRoot, 'com.qingxia.tailscale'), { recursive: true });
    const modernDirs = collectRemovablePluginDataDirs({
      plugin: modernPlugin,
      currentDataRoot,
      legacyGlobalRoot,
      legacyUserDataRoot,
    });
    assert.deepEqual(modernDirs, [path.join(legacyGlobalRoot, 'com.qingxia.tailscale')]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

