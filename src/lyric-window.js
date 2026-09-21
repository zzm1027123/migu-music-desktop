/**
 * 桌面歌词悬浮窗
 * 无边框、透明、置顶的小窗口，像字幕一样浮在桌面最上层。
 */
const path = require('path');
const { BrowserWindow, screen } = require('electron');
const settings = require('./settings');

let win = null;
let onClosed = null;
let lastPayload = null; // 缓存最后一次歌词，窗口加载完成后补发

const DEFAULT_W = 980;
const DEFAULT_H = 160;

function isOpen() {
  return !!(win && !win.isDestroyed());
}

function currentBounds() {
  const s = settings.all();
  if (s.lyricX != null && s.lyricY != null && s.lyricW && s.lyricH) {
    return { x: s.lyricX, y: s.lyricY, width: s.lyricW, height: s.lyricH };
  }
  const { workArea } = screen.getPrimaryDisplay();
  return {
    width: DEFAULT_W,
    height: DEFAULT_H,
    x: Math.round(workArea.x + (workArea.width - DEFAULT_W) / 2),
    y: workArea.y + workArea.height - DEFAULT_H - 70,
  };
}

function open(rootDir) {
  if (isOpen()) {
    win.show();
    return { ok: true, already: true };
  }

  const b = currentBounds();
  win = new BrowserWindow({
    width: b.width,
    height: b.height,
    x: b.x,
    y: b.y,
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: '桌面歌词',
    webPreferences: {
      preload: path.join(rootDir, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // screen-saver 层级可以压住大多数全屏应用
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(rootDir, 'renderer', 'lyric.html'));

  win.once('ready-to-show', () => {
    if (isOpen()) {
      win.show();
      // 恢复上次是否锁定的状态
      win.setIgnoreMouseEvents(!!settings.get('lyricLocked'), { forward: true });
    }
  });

  // 窗口刚打开时页面还没监听到 IPC，直接 send 会丢消息，
  // 所以等加载完成后再把最后一次歌词补发一次。
  win.webContents.on('did-finish-load', () => {
    if (lastPayload && isOpen()) {
      try {
        win.webContents.send('lyric:render', lastPayload);
      } catch {}
    }
    if (isOpen()) {
      try {
        win.webContents.send('lyric:locked', !!settings.get('lyricLocked'));
      } catch {}
    }
  });

  // 记住用户拖到哪儿了
  const remember = () => {
    if (!isOpen()) return;
    const [x, y] = win.getPosition();
    const [w, h] = win.getSize();
    settings.set({ lyricX: x, lyricY: y, lyricW: w, lyricH: h });
  };
  win.on('moved', remember);
  win.on('resized', remember);

  win.on('closed', () => {
    win = null;
    if (onClosed) onClosed();
  });

  return { ok: true };
}

function close() {
  if (isOpen()) {
    try {
      win.close();
    } catch {}
  }
  win = null;
  return { ok: true };
}

function toggle(rootDir) {
  if (isOpen()) return close();
  return open(rootDir);
}

function send(payload) {
  lastPayload = payload || null;
  if (isOpen()) {
    try {
      win.webContents.send('lyric:render', payload);
    } catch {}
  }
}

function setLocked(locked) {
  const v = !!locked;
  settings.set({ lyricLocked: v });
  if (isOpen()) {
    win.setIgnoreMouseEvents(v, { forward: true });
    // 通知歌词窗口同步控制条的显隐（否则从托盘解锁后按钮仍然是隐藏的）
    try {
      win.webContents.send('lyric:locked', v);
    } catch {}
  }
  return { ok: true, locked: v };
}

function status() {
  return { open: isOpen(), locked: !!settings.get('lyricLocked') };
}

function setOnClosed(cb) {
  onClosed = cb;
}

module.exports = { open, close, toggle, send, setLocked, status, isOpen, setOnClosed };
