/**
 * 生成免安装绿色版：dist/咪咕音乐/
 * 直接把 Electron 运行时和应用代码组装在一起，双击「咪咕音乐.exe」即可运行。
 * 运行：npm run build:portable
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'node_modules', 'electron', 'dist');
const OUT = path.join(ROOT, 'dist', '咪咕音乐');
const EXE = '咪咕音乐.exe';

if (!fs.existsSync(path.join(SRC, 'electron.exe'))) {
  console.error('未找到 node_modules/electron/dist/electron.exe，请先执行 npm install 或 node fetch-electron.mjs');
  process.exit(1);
}

console.log('清理输出目录…');
// 保留用户的登录数据（.userdata 里存着登录 Cookie）。
// 用「移动到备份位」而不是「复制」：目录有近 200MB，复制既慢又容易出岔子，
// rename 是原子的，打包完再移回来即可。
const APP_UD = path.join(OUT, 'resources', 'app', '.userdata');
const UD_BACKUP = path.join(ROOT, '.userdata-backup');
let hadUserData = false;
if (fs.existsSync(APP_UD)) {
  console.log('移出登录数据…');
  fs.rmSync(UD_BACKUP, { recursive: true, force: true });
  try {
    fs.renameSync(APP_UD, UD_BACKUP);
  } catch {
    fs.cpSync(APP_UD, UD_BACKUP, { recursive: true });
    fs.rmSync(APP_UD, { recursive: true, force: true });
  }
  hadUserData = true;
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

console.log('复制 Electron 运行时…');
fs.cpSync(SRC, OUT, { recursive: true });

// 精简语言包：Electron 自带 55 种语言、约 48MB，而界面只有中文。
// 留简中，并留英文作为「系统语言没有对应 pak 时」的兜底，其余全删。
const LOCALES_KEEP = new Set(['zh-CN.pak', 'en-US.pak']);
const localesDir = path.join(OUT, 'locales');
let locDropped = 0;
let locBytes = 0;
if (fs.existsSync(localesDir)) {
  for (const f of fs.readdirSync(localesDir)) {
    if (LOCALES_KEEP.has(f)) continue;
    locBytes += fs.statSync(path.join(localesDir, f)).size;
    fs.unlinkSync(path.join(localesDir, f));
    locDropped++;
  }
  console.log(`精简语言包：删除 ${locDropped} 个，省 ${(locBytes / 1048576).toFixed(1)} MB`);
}

console.log('写入应用代码…');
const APP = path.join(OUT, 'resources', 'app');
fs.mkdirSync(APP, { recursive: true });
for (const f of ['package.json', 'main.js', 'preload.js']) {
  fs.copyFileSync(path.join(ROOT, f), path.join(APP, f));
}
for (const d of ['src', 'renderer', 'assets']) {
  if (fs.existsSync(path.join(ROOT, d))) {
    fs.cpSync(path.join(ROOT, d), path.join(APP, d), { recursive: true });
  }
}

// 精简：去掉开发依赖声明与说明文件，避免误装
const pkgPath = path.join(APP, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
delete pkg.devDependencies;
delete pkg.scripts;
pkg.name = 'migu-music-desktop';
pkg.version = '1.0.0';
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

// 移除默认应用，避免误加载
const defApp = path.join(OUT, 'resources', 'default_app.asar');
if (fs.existsSync(defApp)) fs.unlinkSync(defApp);

console.log('重命名可执行文件…');
fs.renameSync(path.join(OUT, 'electron.exe'), path.join(OUT, EXE));

if (hadUserData) {
  console.log('放回登录数据…');
  fs.rmSync(APP_UD, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(APP_UD), { recursive: true });
  try {
    fs.renameSync(UD_BACKUP, APP_UD);
  } catch {
    fs.cpSync(UD_BACKUP, APP_UD, { recursive: true });
    fs.rmSync(UD_BACKUP, { recursive: true, force: true });
  }

  // 清掉 Chromium 的纯缓存目录：运行时会自动重建，删了只影响首次加载速度。
  // 注意必须保留这几个 —— Network/（Cookie）、Local Storage/（登录令牌）、
  // login/（应用自己的票据）、Local State（解密 Cookie 用的密钥，删了等于掉登录）。
  const CACHE_DIRS = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache'];
  const dirSize = (d) => {
    let t = 0;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const q = path.join(d, e.name);
      t += e.isDirectory() ? dirSize(q) : fs.statSync(q).size;
    }
    return t;
  };
  let cacheBytes = 0;
  for (const d of CACHE_DIRS) {
    const p = path.join(APP_UD, d);
    if (!fs.existsSync(p)) continue;
    cacheBytes += dirSize(p);
    fs.rmSync(p, { recursive: true, force: true });
  }
  if (cacheBytes) console.log(`清理运行缓存：省 ${(cacheBytes / 1048576).toFixed(1)} MB`);
}

const size = (() => {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += fs.statSync(p).size;
    }
  };
  walk(OUT);
  return (total / 1048576).toFixed(1);
})();

console.log(`\n完成：${OUT}`);
console.log(`双击 ${EXE} 即可启动（共 ${size} MB）`);
