/**
 * Chromium 运行时缓存的统计与清理
 *
 * 只清「可再生」的缓存目录，登录态相关的东西一个都不碰 ——
 * Cookie 在 Network/、登录令牌在 Local Storage/、解密 Cookie 用的密钥在 Local State，
 * 清错任何一个都会直接掉登录。
 *
 * 名单与 build-portable.mjs 打包时的清理保持一致。
 */
const fs = require('fs');
const path = require('path');
const { app, session } = require('electron');

/** 允许清理的缓存目录：删掉只会让下次加载慢一点，运行时会自动重建 */
const CACHE_DIRS = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache'];

/** 明确不能碰的目录，写在这里是为了让后来改代码的人一眼看到边界 */
const KEEP_DIRS = ['Network', 'Local Storage', 'Session Storage', 'Local State', 'login', 'WebStorage'];

/** 递归算目录大小；正在被 Chromium 锁住的文件读不到，按 0 计 */
function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    } catch {
      // 文件被占用/无权限，忽略
    }
  }
  return total;
}

/** 当前缓存占用情况 */
function stats() {
  const dir = app.getPath('userData');
  const items = [];
  let bytes = 0;
  for (const name of CACHE_DIRS) {
    const size = dirSize(path.join(dir, name));
    bytes += size;
    if (size > 0) items.push({ name, bytes: size });
  }
  return { dir, bytes, items };
}

/**
 * 清理缓存。
 *
 * 分两步，因为运行中的 Chromium 会独占锁住这些文件，直接删会 EACCES：
 *   1. 先走官方 API（clearCache / clearCodeCaches）—— 这是唯一能安全清掉
 *      「正在使用中」的缓存的方式，而且它只碰 HTTP 缓存和 V8 代码缓存，
 *      不会动 Cookie 与 localStorage；
 *   2. 再把 API 覆盖不到的目录（GPU / Dawn 渲染缓存）删掉，
 *      个别文件被占用就跳过，不让整件事失败。
 *
 * 返回清理前后的大小。after 不为 0 是正常的：Chromium 会立刻重建一部分，
 * 而且内存里仍打开的缓存文件要等重启才会真正释放。
 */
async function clear() {
  const before = stats();
  const userData = app.getPath('userData');

  let viaApi = false;
  try {
    const sess = session.defaultSession;
    if (sess) {
      await sess.clearCache();
      if (typeof sess.clearCodeCaches === 'function') await sess.clearCodeCaches({ urls: [] });
      viaApi = true;
    }
  } catch {
    // 官方接口失败就交给下面的目录删除兜底
  }

  let removedDirs = 0;
  for (const name of CACHE_DIRS) {
    const p = path.join(userData, name);
    if (!fs.existsSync(p)) continue;
    try {
      fs.rmSync(p, { recursive: true, force: true });
      removedDirs++;
    } catch {
      // 被运行中的进程锁住，跳过
    }
  }

  const after = stats();
  return {
    ok: true,
    viaApi,
    removedDirs,
    before: before.bytes,
    after: after.bytes,
    freed: Math.max(0, before.bytes - after.bytes),
    pending: after.bytes,
  };
}

module.exports = { stats, clear, CACHE_DIRS, KEEP_DIRS };
