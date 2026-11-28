'use strict';

// 统一插件数据存储管理：将 plugin-data 固定放到当前「插件目录」下，支持跨盘迁移、目录更换迁移与安全删除。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PLUGIN_DATA_DIR_NAME = 'plugin-data';

const LEGACY_PLUGIN_DATA = new Map([
  ['frpc\0frpc', 'frpc-utools'],
  ['hosts-editor\0Hosts 快速编辑', 'hosts-editor'],
  ['password-box\0密码盒', 'password-box'],
  ['download\0拾影', 'shiying-douyin-plugin'],
  ['application-proxy\0应用代理', 'application-proxy'],
]);

function pluginDataFolder(pluginFolderPath) {
  return path.join(pluginFolderPath, PLUGIN_DATA_DIR_NAME);
}

function isSafeDataSubdir(name) {
  return typeof name === 'string'
    && name !== '.'
    && name !== '..'
    && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(name);
}

function isLegacyPlugin(plugin) {
  if (!plugin || typeof plugin !== 'object') return false;
  return LEGACY_PLUGIN_DATA.has(`${plugin.code || ''}\0${plugin.name || ''}`);
}

function resolvePluginDataSubdir(plugin) {
  if (!plugin || typeof plugin !== 'object') return '';
  const legacy = LEGACY_PLUGIN_DATA.get(`${plugin.code || ''}\0${plugin.name || ''}`);
  if (legacy) return legacy;
  if (typeof plugin.pluginId === 'string' && isSafeDataSubdir(plugin.pluginId)) {
    return plugin.pluginId;
  }
  return '';
}

function assertNotSymlink(target, message) {
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new Error(message || '插件数据目录不能是链接');
  }
}

function moveDirSafe(src, dest, options = {}) {
  assertNotSymlink(src, '原插件数据目录不能是链接');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const renameFn = typeof options.renameSync === 'function' ? options.renameSync : fs.renameSync;
  try {
    renameFn(src, dest);
    return;
  } catch (error) {
    if (!error || error.code !== 'EXDEV') throw error;
  }

  // 跨盘（如 C: -> D:）先复制到目标同级临时目录再原子替换，确保异常时不破坏源数据。
  const temp = `${dest}.migrating-${crypto.randomUUID()}`;
  try {
    fs.cpSync(src, temp, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: (entry) => {
        if (fs.lstatSync(entry).isSymbolicLink()) {
          throw new Error('数据目录包含快捷链接，无法安全迁移');
        }
        return true;
      },
    });
    fs.renameSync(temp, dest);
    fs.rmSync(src, { recursive: true, force: true });
  } catch (error) {
    try {
      fs.rmSync(temp, { recursive: true, force: true });
    } catch (_) {
      /* ignore cleanup */
    }
    throw error;
  }
}

function migrateSinglePluginData({
  plugin,
  targetRoot,
  legacyGlobalRoot,
  legacyUserDataRoot,
  resolveConflict,
  moveDir = moveDirSafe,
}) {
  assertNotSymlink(targetRoot, '插件数据目录不能是链接');
  fs.mkdirSync(targetRoot, { recursive: true });

  const subdir = resolvePluginDataSubdir(plugin);
  if (!subdir) return { root: targetRoot, subdir: '', legacy: false };

  const newDir = path.join(targetRoot, subdir);
  const resolvedNew = path.resolve(newDir).toLowerCase();

  const candidates = [];
  if (legacyGlobalRoot) {
    candidates.push({ dir: path.join(legacyGlobalRoot, subdir), label: 'global' });
  }
  const legacy = isLegacyPlugin(plugin);
  if (legacy && legacyUserDataRoot) {
    candidates.push({ dir: path.join(legacyUserDataRoot, subdir), label: 'userData' });
  }

  for (const item of candidates) {
    const oldDir = item.dir;
    if (path.resolve(oldDir).toLowerCase() === resolvedNew) continue;
    if (!fs.existsSync(oldDir)) continue;

    assertNotSymlink(oldDir, '原插件数据目录不能是链接');
    if (!fs.existsSync(newDir)) {
      moveDir(oldDir, newDir);
      continue;
    }

    assertNotSymlink(newDir, '新插件数据目录不能是链接');
    const choice = typeof resolveConflict === 'function'
      ? resolveConflict({ plugin, subdir, oldDir, newDir, sourceKind: item.label })
      : 'use-current';

    if (choice === 'cancel') return null;
    if (choice === 'skip') continue;

    const backupRoot = path.dirname(oldDir);
    const backup = path.join(backupRoot, `${subdir}-backup-${crypto.randomUUID()}`);
    if (fs.existsSync(backup)) throw new Error('备份目录已存在');

    if (choice === 'use-current') {
      moveDir(oldDir, backup);
    } else if (choice === 'use-old') {
      moveDir(newDir, backup);
      try {
        moveDir(oldDir, newDir);
      } catch (error) {
        try {
          if (!fs.existsSync(newDir) && fs.existsSync(backup)) moveDir(backup, newDir);
        } catch (_) {
          throw new Error(`恢复数据失败，请检查 ${backup} 与 ${oldDir}`);
        }
        throw error;
      }
    }
  }

  return { root: targetRoot, subdir, legacy };
}

function isInsideOrSame(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function copyPluginDataRoot({ oldFolder, newFolder }) {
  const oldData = pluginDataFolder(oldFolder);
  const newData = pluginDataFolder(newFolder);
  if (!fs.existsSync(oldData)) return { migrated: false, oldData, created: [] };
  assertNotSymlink(oldData, '原插件数据目录不能是快捷链接，无法安全迁移。');
  if (!fs.statSync(oldData).isDirectory()) return { migrated: false, oldData, created: [] };
  if (isInsideOrSame(newFolder, oldData)) {
    throw new Error('新目录不能位于当前 plugin-data 文件夹内。');
  }
  assertNotSymlink(newData, '目标插件目录中的 plugin-data 不能是快捷链接。');

  const entries = fs.readdirSync(oldData);
  if (entries.length === 0) return { migrated: true, oldData, created: [] };

  const created = [];
  const dataExisted = fs.existsSync(newData);
  if (!dataExisted) {
    fs.mkdirSync(newData, { recursive: true });
    created.push(newData);
  } else if (!fs.statSync(newData).isDirectory()) {
    throw new Error('目标插件目录中的 plugin-data 不是有效文件夹。');
  }

  for (const entry of entries) {
    const srcEntry = path.join(oldData, entry);
    const dstEntry = path.join(newData, entry);
    if (fs.existsSync(dstEntry)) {
      throw new Error(`目标插件目录的 plugin-data 中已存在同名数据（${entry}），请先处理后再更改目录。`);
    }
    created.push(dstEntry);
    fs.cpSync(srcEntry, dstEntry, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: (source) => {
        if (fs.lstatSync(source).isSymbolicLink()) {
          throw new Error('插件数据目录中包含快捷链接，无法安全复制；原目录没有改变。');
        }
        return true;
      },
    });
  }

  return { migrated: true, oldData, created };
}

function isManagedPluginDataDir(target, dataRoot) {
  if (!dataRoot || !fs.existsSync(dataRoot) || !fs.existsSync(target)) return false;
  if (fs.lstatSync(dataRoot).isSymbolicLink() || fs.lstatSync(target).isSymbolicLink()) return false;
  if (!fs.statSync(target).isDirectory()) return false;
  const realRoot = fs.realpathSync(dataRoot);
  const realTarget = fs.realpathSync(target);
  return path.dirname(realTarget).toLowerCase() === realRoot.toLowerCase()
    && isSafeDataSubdir(path.basename(realTarget));
}

function migrateInstalledPluginsDataOnStartup({
  installedPlugins,
  targetRoot,
  legacyGlobalRoot,
  legacyUserDataRoot,
  moveDir = moveDirSafe,
}) {
  const seen = new Set();
  const migrated = [];
  const skipped = [];
  const errors = [];
  for (const plugin of Array.isArray(installedPlugins) ? installedPlugins : []) {
    const subdir = resolvePluginDataSubdir(plugin);
    if (!subdir || seen.has(subdir)) continue;
    seen.add(subdir);
    let conflicted = false;
    try {
      migrateSinglePluginData({
        plugin,
        targetRoot,
        legacyGlobalRoot,
        legacyUserDataRoot,
        moveDir,
        resolveConflict: () => {
          conflicted = true;
          return 'skip';
        },
      });
      if (conflicted) skipped.push(subdir);
      else migrated.push(subdir);
    } catch (error) {
      errors.push({ subdir, message: error && error.message ? error.message : String(error) });
    }
  }
  return { migrated, skipped, errors };
}

function collectRemovablePluginDataDirs({
  plugin,
  currentDataRoot,
  legacyGlobalRoot,
  legacyUserDataRoot,
}) {
  const subdir = resolvePluginDataSubdir(plugin);
  if (!subdir) return [];
  const roots = [currentDataRoot, legacyGlobalRoot];
  if (isLegacyPlugin(plugin)) roots.push(legacyUserDataRoot);

  const seen = new Set();
  const targets = [];
  for (const root of roots) {
    if (!root || typeof root !== 'string') continue;
    const candidate = path.join(root, subdir);
    if (!fs.existsSync(candidate)) continue;
    if (!isManagedPluginDataDir(candidate, root)) continue;
    const real = fs.realpathSync(candidate).toLowerCase();
    if (seen.has(real)) continue;
    seen.add(real);
    targets.push(candidate);
  }
  return targets;
}

module.exports = {
  PLUGIN_DATA_DIR_NAME,
  LEGACY_PLUGIN_DATA,
  pluginDataFolder,
  isSafeDataSubdir,
  isLegacyPlugin,
  resolvePluginDataSubdir,
  moveDirSafe,
  migrateSinglePluginData,
  migrateInstalledPluginsDataOnStartup,
  collectRemovablePluginDataDirs,
  copyPluginDataRoot,
  isManagedPluginDataDir,
};
