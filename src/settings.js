/**
 * 设置持久化（存到 userData/settings.json）
 */
const path = require('path');
const fs = require('fs');

const DEFAULTS = {
  minimizeToTray: true, // 关闭主窗口时最小化到系统托盘，而不是退出
  showTrayTip: true, // 首次最小化时弹一次气泡提示
  trayTipShown: false,
  tone: 'PQ', // 默认音质
  volume: 70, // 默认音量
  lyricLocked: false, // 桌面歌词是否锁定（锁定后鼠标穿透）
  lyricFontCur: 30,
  lyricFontNext: 16,
  logRetentionDays: 30, // 启动时自动清理多少天前的日志；0 = 不自动清理
};

let file = '';
let cache = null;

function init(userDataDir) {
  file = path.join(userDataDir, 'settings.json');
  cache = load();
  return { ...cache };
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

function all() {
  if (!cache) cache = load();
  return { ...cache };
}

function get(key) {
  return all()[key];
}

function set(patch) {
  cache = { ...all(), ...(patch || {}) };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache, null, 2));
  } catch {}
  return { ...cache };
}

module.exports = { init, all, get, set, DEFAULTS };
