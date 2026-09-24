/**
 * 测试公共工具
 *
 * 各个测试都需要一份「带登录态的 userData 副本」，又不能直接借用客户端正在用的那份，
 * 所以过去每个测试都自己写一遍「把 dist 里的 .userdata 整个复制过来」。这段复制有两个坑：
 *
 *  1. Cache / Code Cache 这些纯缓存目录又大（约 26MB）又和测试无关；
 *  2. **客户端开着的时候，这些缓存文件被独占锁定，cpSync 会抛 EACCES，
 *     而且是在主进程里抛，直接弹「A JavaScript error occurred in the main process」把测试崩掉。**
 *
 * 现在改成：只挑登录态与设置相关的文件，逐个复制并容错 ——
 * 个别文件被占用就跳过，不该让整个测试挂掉。
 */
const path = require('path');
const fs = require('fs');

/** 纯缓存目录：测试用不到，且会被运行中的客户端锁住 */
const SKIP_NAMES = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'DIPS',
  'DIPS-wal',
  'Shared Dictionary',
  'Session Storage',
  'blob_storage',
  'declarative_performance_observer.db',
  'declarative_performance_observer.db-journal',
]);

const REAL_UD =
  process.env.MIGU_TEST_UD ||
  path.join(__dirname, 'dist', '咪咕音乐', 'resources', 'app', '.userdata');

const DEV_UD = path.join(__dirname, '.userdata');

/** 递归复制，跳过缓存目录，单个文件失败不影响整体。返回跳过的文件数 */
function copyFiltered(src, dest) {
  let skipped = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_NAMES.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    try {
      if (e.isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        skipped += copyFiltered(s, d);
      } else {
        fs.copyFileSync(s, d);
      }
    } catch {
      skipped++; // 被运行中的客户端占用、或无权限，跳过
    }
  }
  return skipped;
}

/**
 * 准备一个测试专用的 userData 目录，返回该目录路径。
 *
 * - 目录已存在就直接复用（不重复复制）
 * - 不存在则从 dist 的 .userdata 复制一份「登录态」，跳过缓存
 * - 连真身都没有时退回开发目录 .userdata，与各测试原本的兜底行为一致
 *
 * @param {string} name 目录名（相对项目根）或绝对路径
 */
function prepareUserData(name) {
  const dir = path.isAbsolute(name) ? name : path.join(__dirname, name);
  if (fs.existsSync(dir)) return dir;
  if (!fs.existsSync(REAL_UD)) return fs.existsSync(DEV_UD) ? DEV_UD : dir;

  fs.mkdirSync(dir, { recursive: true });
  const skipped = copyFiltered(REAL_UD, dir);
  if (skipped) console.log(`（有 ${skipped} 个缓存文件被占用，已跳过 —— 不影响登录态）`);
  return dir;
}

module.exports = { prepareUserData, copyFiltered, REAL_UD, DEV_UD };
