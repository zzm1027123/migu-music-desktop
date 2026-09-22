/**
 * 咪咕音乐 PC 客户端 —— Electron 主进程
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, session, shell, Tray, Menu, nativeImage } = require('electron');

// 绿色版：用户数据（含登录 Cookie）存放在程序目录下
// 可用 MIGU_USER_DATA 环境变量覆盖（便于测试与诊断）
const USER_DATA = process.env.MIGU_USER_DATA || path.join(__dirname, '.userdata');
try {
  fs.mkdirSync(USER_DATA, { recursive: true });
} catch {}
app.setPath('userData', USER_DATA);

// 登录信息集中放在 userData/login/ 下，方便备份或整体清理。
// 注意：这两个常量必须在 initLoginDir() 调用之前定义，否则会撞上 const 的暂时性死区，
// 而错误又会被 try/catch 吞掉，导致迁移静默失效。
const LOGIN_DIR = path.join(USER_DATA, 'login');
const AUTH_FILE = path.join(LOGIN_DIR, 'auth.json');

// 日志尽早初始化，这样连「重复启动被拦下」这种事也能记进去
const logger = require('./src/logger');
logger.init(USER_DATA);

// 设置也要在日志清理之前就绪（保留天数从这里读）
const settings = require('./src/settings');
const { LOGIN_TICKET_NAMES, persistLoginTickets } = require('./src/login-tickets');
settings.init(USER_DATA);
initLoginDir();

logger.info(`[启动] 咪咕音乐客户端 v${app.getVersion()} | electron=${process.versions.electron} | argv=${process.argv.slice(1).join(' ')}`);

// 启动时按设置的保留期自动清理旧日志
try {
  const keepDays = Number(settings.get('logRetentionDays'));
  if (keepDays > 0) {
    const r = logger.cleanOlderThan(keepDays);
    if (r.removed) logger.info(`[启动] 已自动清理 ${r.removed} 个超过 ${keepDays} 天的日志`);
  }
} catch {}

/* ------------------------------------------------- 单实例检测：禁止多开 */

/** 进程是否还活着 */
function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === 'EPERM'); // 存在但没权限，也算活着
  }
}

/**
 * 双保险：
 *  1) Electron 自带的单实例锁 —— 拦住「同一份客户端被点了好几次」
 *  2) 临时目录下的 pid 锁 —— 拦住「把客户端拷成两份、分别启动」这种情况
 *     （这种副本的 userData 各自独立，原生锁是拦不住的）
 */
function acquireInstanceLock() {
  if (!app.requestSingleInstanceLock()) {
    return { ok: false, reason: 'electron-lock' };
  }

  const lockPath = path.join(os.tmpdir(), 'migu-music-desktop.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx'); // 排他创建
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return { ok: true, lockPath };
    } catch (e) {
      if (e.code !== 'EEXIST') return { ok: true, lockPath: null }; // 其它错误不阻塞启动
      let pid = 0;
      try {
        pid = Number(String(fs.readFileSync(lockPath, 'utf8')).trim());
      } catch {}
      if (pidAlive(pid)) return { ok: false, reason: 'pid-lock', pid };
      // 上个进程异常退出留下的陈旧锁，清掉重试
      try {
        fs.unlinkSync(lockPath);
      } catch {}
    }
  }
  return { ok: true, lockPath: null };
}

const instanceLock = acquireInstanceLock();
const alreadyRunning = !instanceLock.ok;

if (alreadyRunning) {
  const msg = `[单实例] 检测到客户端已在运行（${instanceLock.reason}${
    instanceLock.pid ? ' pid=' + instanceLock.pid : ''
  }），本次启动退出`;
  logger.warn(msg);
  console.log(msg);
  app.quit();
} else {
  // 有第二个实例试图启动时，Electron 会在这里通知我们 —— 把已有窗口唤回来
  app.on('second-instance', () => {
    logger.info('[单实例] 检测到重复启动，已唤回主窗口');
    showMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:alreadyRunning');
    }
    if (process.env.MIGU_TEST_LOG) {
      try {
        fs.appendFileSync(process.env.MIGU_TEST_LOG, 'second-instance\n');
      } catch {}
    }
  });

  // 退出时清掉 pid 锁，避免下次启动被自己的陈旧锁挡住
  app.on('will-quit', () => {
    if (instanceLock.lockPath) {
      try {
        fs.unlinkSync(instanceLock.lockPath);
      } catch {}
    }
  });

  // app.exit() 之类的强制退出不会触发 will-quit，这里再兜一层
  process.on('exit', () => {
    if (instanceLock.lockPath) {
      try {
        fs.unlinkSync(instanceLock.lockPath);
      } catch {}
    }
  });
}

const api = require('./src/migu-api');
const { registerIpc } = require('./src/ipc');
const resolver = require('./src/resolver');
const lyricWin = require('./src/lyric-window');

const LOGIN_URL =
  'https://music.migu.cn/v5/#/musicLibrary';
const PASSPORT_URL =
  'https://passport.migu.cn/login?sourceid=220029&forceAuthn=true&hideRegister=1&hideForgetPass=1&callbackURL=PostToken';

let mainWindow = null;
let loginWindow = null;
let loginWatcher = null;
let loginBeforeKeys = new Set();
let tray = null;
let isQuitting = false;

/** 登录态缓存 */
const authState = {
  loggedIn: false,
  nickname: '',
  avatar: '',
  userId: '',
  cookies: [],
  cookieKeys: [], // 登录时新增的 Cookie 标识，用于重启后校验登录态
  since: 0,
};

/* ------------------------------------------------------------------ 窗口 */

const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    title: '咪咕音乐',
    backgroundColor: '#11131a',
    autoHideMenuBar: true,
    show: false,
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 关闭按钮：按设置决定「退出」还是「最小化到托盘」
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    if (settings.get('minimizeToTray') && tray) {
      event.preventDefault();
      mainWindow.hide();
      logger.info('[窗口] 点击关闭 -> 已最小化到系统托盘');
      if (settings.get('showTrayTip') && !settings.get('trayTipShown')) {
        settings.set({ trayTipShown: true });
        try {
          tray.displayBalloon({
            title: '咪咕音乐仍在后台运行',
            content: '已最小化到系统托盘，点击托盘图标可重新打开；右键可选择退出。',
          });
        } catch {}
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    resolver.destroy(); // 主窗口关闭后释放解析器窗口
  });

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* ------------------------------------------------------------ 系统托盘 */

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** 把播放控制指令发给渲染层 */
function sendPlayerCommand(cmd) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('player:command', cmd);
  }
}

/** 通知界面：桌面歌词状态变了 */
function notifyLyricChanged() {
  rebuildTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('lyric:changed', { open: lyricWin.isOpen(), ...lyricWin.status() });
  }
}

/** 开关桌面歌词窗口，并让界面按钮保持同步 */
function toggleLyricWindow() {
  const wasOpen = lyricWin.isOpen();
  const r = wasOpen ? lyricWin.close() : lyricWin.open(__dirname);
  notifyLyricChanged();
  return r;
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    // 兜底：用内联的最小图形，保证托盘始终可用
    image = nativeImage.createEmpty();
  }
  tray = new Tray(image);
  tray.setToolTip('咪咕音乐');
  rebuildTrayMenu();

  // Windows 上单击/双击托盘图标都唤回窗口
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
}

function rebuildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: showMainWindow },
    { type: 'separator' },
    { label: '播放 / 暂停', click: () => sendPlayerCommand('toggle') },
    { label: '上一首', click: () => sendPlayerCommand('prev') },
    { label: '下一首', click: () => sendPlayerCommand('next') },
    { type: 'separator' },
    {
      label: '桌面歌词',
      type: 'checkbox',
      checked: lyricWin.isOpen(),
      click: () => {
        toggleLyricWindow();
      },
    },
    {
      label: '锁定桌面歌词（鼠标穿透）',
      type: 'checkbox',
      enabled: lyricWin.isOpen(),
      checked: !!settings.get('lyricLocked'),
      click: (item) => {
        lyricWin.setLocked(!!item.checked);
        notifyLyricChanged();
      },
    },
    { type: 'separator' },
    {
      label: '关闭窗口时最小化到托盘',
      type: 'checkbox',
      checked: !!settings.get('minimizeToTray'),
      click: (item) => {
        settings.set({ minimizeToTray: !!item.checked });
        notifySettingsChanged();
      },
    },
    { type: 'separator' },
    {
      label: '退出咪咕音乐',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

/** 设置变化后同步给渲染层与托盘菜单 */
function notifySettingsChanged() {
  logger.info('[设置] 已更新：' + JSON.stringify(settings.all()));
  rebuildTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('settings:changed', settings.all());
  }
}

/* ------------------------------------------------------------ 登录相关 */

async function snapshotCookies() {
  try {
    const list = await session.defaultSession.cookies.get({ domain: '.migu.cn' });
    const one = await session.defaultSession.cookies.get({ domain: 'music.migu.cn' });
    const merged = [...list, ...one];
    return merged.map((c) => ({ name: c.name, domain: c.domain, valueLen: (c.value || '').length }));
  } catch {
    return [];
  }
}

/** 尝试从已登录的咪咕页面里读取用户昵称 / 头像 / userId */
async function probeUserProfile(win) {
  const js = `(() => {
    const out = { nickname: '', avatar: '', userId: '' };
    try {
      const pick = (sels) => {
        for (const s of sels) {
          const el = document.querySelector(s);
          if (el) {
            const t = (el.innerText || el.textContent || '').trim();
            if (t && t.length < 30) return t;
          }
        }
        return '';
      };
      out.nickname = pick(['[class*="userName"]','[class*="user-name"]','[class*="nickName"]','[class*="nickname"]','[class*="userInfo"] span','[class*="user-info"] span']);
      const imgs = document.querySelectorAll('img');
      for (const im of imgs) {
        const cls = (im.className || '') + ' ' + (im.parentElement?.className || '');
        if (/avatar|head|user-?img|portrait/i.test(cls) && im.src) { out.avatar = im.src; break; }
      }
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        const v = String(localStorage.getItem(k) || '');
        const m = v.match(/"(?:userId|uid|userid|passportId|msisdn)"\\s*:\\s*"?([\\w-]{4,})/i);
        if (m) { out.userId = m[1]; break; }
      }
    } catch (e) {}
    return out;
  })()`;
  try {
    return await win.webContents.executeJavaScript(js, true);
  } catch {
    return { nickname: '', avatar: '', userId: '' };
  }
}

/** 页面是否仍显示“登录”入口（用于判断是否已登录） */
async function pageShowsLoginEntry(win) {
  const js = `(() => {
    try {
      const els = document.querySelectorAll('div,span,a,button');
      for (const el of els) {
        if (el.children.length) continue;
        const t = (el.innerText || '').trim();
        if (t === '登录' && el.offsetParent !== null) return true;
      }
      return false;
    } catch (e) { return true; }
  })()`;
  try {
    return await win.webContents.executeJavaScript(js, true);
  } catch {
    return true;
  }
}

function stopLoginWatch() {
  if (loginWatcher) {
    clearInterval(loginWatcher);
    loginWatcher = null;
  }
}

/* ------------------------------ 登录凭据持久化（避免匿名 Cookie 造成误判） */

/** 建目录，并把老版本散在 userData 根目录的 auth.json 迁进来 */
function initLoginDir() {
  try {
    fs.mkdirSync(LOGIN_DIR, { recursive: true });
  } catch {}
  const legacy = path.join(USER_DATA, 'auth.json');
  try {
    if (fs.existsSync(legacy) && !fs.existsSync(AUTH_FILE)) {
      fs.renameSync(legacy, AUTH_FILE);
      logger.info('[登录] auth.json 已迁移到 login/ 目录');
    } else if (fs.existsSync(legacy)) {
      // 新位置已有，旧的直接清掉，避免两份登录信息不一致
      fs.unlinkSync(legacy);
      logger.info('[登录] 清理了 userData 根目录下多余的 auth.json');
    }
  } catch (e) {
    console.error('[登录] 迁移 auth.json 失败：', e && e.message);
  }

  // 放一份说明，写清楚这个目录里有什么、Cookie 为什么不在这里
  try {
    const note = path.join(LOGIN_DIR, '说明.txt');
    if (!fs.existsSync(note)) {
      fs.writeFileSync(
        note,
        [
          '这个目录存放咪咕音乐客户端的登录信息。',
          '',
          '  auth.json   登录态记录（登录时间、昵称、登录时新增的 Cookie 名称）',
          '',
          '完整的登录凭据还包括浏览器 Cookie，它由 Chromium 统一管理，',
          '位置固定在：',
          '  ..\\Network\\Cookies',
          '',
          '想退出登录，请用客户端界面右上角的「退出」按钮，',
          '它会同时清理 Cookie 和本目录里的 auth.json。',
          '',
          '若要手动清理：只删本目录不够 —— 还需删掉 ..\\Network\\Cookies，',
          '否则客户端仍会被判定为处于登录状态。',
          '',
        ].join('\r\n'),
        'utf8'
      );
    }
  } catch {}
}

function saveAuthFile() {
  try {
    fs.mkdirSync(LOGIN_DIR, { recursive: true });
    fs.writeFileSync(
      AUTH_FILE,
      JSON.stringify(
        {
          loggedIn: authState.loggedIn,
          nickname: authState.nickname,
          avatar: authState.avatar,
          userId: authState.userId,
          cookieKeys: authState.cookieKeys,
          since: authState.since,
        },
        null,
        2
      )
    );
  } catch {}
}

function loadAuthFile() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function clearAuthFile() {
  try {
    fs.unlinkSync(AUTH_FILE);
  } catch {}
}

/** 在登录窗口里自动点开“登录”入口，省去用户再点一次 */
async function autoClickLoginEntry(win) {
  const js = `(() => {
    try {
      const els = document.querySelectorAll('div,span,a,button');
      for (const el of els) {
        if (el.children.length) continue;
        if ((el.innerText || '').trim() === '登录' && el.offsetParent !== null) { el.click(); return true; }
      }
    } catch (e) {}
    return false;
  })()`;
  for (let i = 0; i < 8 && win && !win.isDestroyed(); i++) {
    try {
      if (await win.webContents.executeJavaScript(js, true)) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

async function finishLogin(reason) {
  if (!loginWindow) return { ok: false };
  const prof = await probeUserProfile(loginWindow);
  const cookies = await snapshotCookies();
  const added = cookies.filter((c) => !loginBeforeKeys.has(c.name + '@' + c.domain));

  authState.loggedIn = true;
  authState.nickname = prof.nickname || '';
  authState.avatar = prof.avatar || '';
  authState.userId = prof.userId || '';
  authState.since = Date.now();
  authState.cookies = cookies;
  authState.cookieKeys = added.map((c) => c.name + '@' + c.domain);
  // 会话级票据在进程退出时会被 Chromium 丢掉，先加固成持久 Cookie 再落盘
  await persistLoginTickets(session.defaultSession).catch(() => {});
  saveAuthFile();
  stopLoginWatch();
  logger.info(`[登录] 登录成功（${reason}）昵称=${authState.nickname || '(未获取)'} 新增Cookie=${added.length}个`);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('auth:changed', { ...authState, reason });
  }
  const w = loginWindow;
  loginWindow = null;
  setTimeout(() => {
    try {
      if (!w.isDestroyed()) w.close();
    } catch {}
  }, 700);
  return { ok: true };
}

async function openLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return { ok: true, already: true };
  }
  const before = await snapshotCookies();
  loginBeforeKeys = new Set(before.map((c) => c.name + '@' + c.domain));

  loginWindow = new BrowserWindow({
    width: 480,
    height: 700,
    parent: mainWindow || undefined,
    title: '登录咪咕音乐',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // 使用默认持久化 session，与主窗口共享 Cookie
    },
  });
  loginWindow.loadURL(LOGIN_URL);

  // 页面加载完成后自动点开登录框
  loginWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (loginWindow && !loginWindow.isDestroyed()) autoClickLoginEntry(loginWindow);
    }, 1200);
  });

  loginWindow.on('closed', () => {
    stopLoginWatch();
    loginWindow = null;
  });

  // 轮询：出现新增登录 Cookie，或页面登录入口消失 => 判定登录成功
  let ticks = 0;
  loginWatcher = setInterval(async () => {
    ticks += 1;
    if (!loginWindow || loginWindow.isDestroyed()) return stopLoginWatch();
    try {
      const now = await snapshotCookies();
      const added = now.filter((c) => !loginBeforeKeys.has(c.name + '@' + c.domain) && c.valueLen > 12);
      // 排除咪咕的匿名统计类 Cookie
      const meaningful = added.filter((c) => !/uem|device|uuid|cookieId|task-session|logId|^gsm/i.test(c.name));
      if (meaningful.length) return finishLogin('cookie:' + meaningful.map((c) => c.name).join(','));
      if (ticks % 4 === 0) {
        const shows = await pageShowsLoginEntry(loginWindow);
        if (!shows && added.length) return finishLogin('dom');
      }
    } catch {}
    if (ticks > 900) stopLoginWatch();
  }, 1200);

  return { ok: true };
}

async function logout() {
  try {
    await session.defaultSession.clearStorageData({
      storages: ['cookies', 'localstorage', 'sessionstorage', 'indexdb', 'websql', 'cachestorage'],
    });
  } catch {}
  authState.loggedIn = false;
  authState.nickname = '';
  authState.avatar = '';
  authState.userId = '';
  authState.cookies = [];
  authState.cookieKeys = [];
  clearAuthFile();
  logger.info('[登录] 已退出登录，本地 Cookie 已清除');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('auth:changed', { ...authState, reason: 'logout' });
  }
  return { ok: true };
}

/**
 * 登录态判定：
 *  1) 优先看 auth.json 里记录的「登录时新增的 Cookie」是否还有存活；
 *  2) 若 auth.json 不存在或那些 Cookie 过期轮换了，再用明确的登录票据兜底。
 *
 * 注意：绝不能因为「没匹配上记录的 Cookie」就直接登出 ——
 * 咪咕的 idmpauth / mg_auth_sid 这类票据会过期轮换，
 * 早期版本一旦匹配失败就删 auth.json，会把还在有效期的登录态误清掉。
 * （LOGIN_TICKET_NAMES / persistLoginTickets 在 src/login-tickets.js，供这里与加固逻辑共用。）
 */
async function checkAuth() {
  const saved = loadAuthFile();
  if (saved && saved.loggedIn && Array.isArray(saved.cookieKeys) && saved.cookieKeys.length) {
    const now = await snapshotCookies();
    const keys = new Set(now.map((c) => c.name + '@' + c.domain));
    const alive = saved.cookieKeys.filter((k) => keys.has(k));
    if (alive.length) {
      authState.loggedIn = true;
      authState.nickname = saved.nickname || '';
      authState.avatar = saved.avatar || '';
      authState.userId = saved.userId || '';
      authState.cookieKeys = saved.cookieKeys;
      authState.since = saved.since || 0;
      persistLoginTickets(session.defaultSession).catch(() => {}); // 后台加固，不拖慢界面
      return { ...authState, restored: true };
    }
  }

  // 兜底：还有没有明确的登录票据？有就恢复登录态并重建 auth.json
  const cookies = await snapshotCookies();
  const ticket = cookies.find((c) => LOGIN_TICKET_NAMES.includes(c.name) && c.valueLen > 12);
  if (ticket) {
    authState.loggedIn = true;
    authState.cookieKeys = cookies.map((c) => c.name + '@' + c.domain);
    authState.since = Date.now();
    authState.cookies = cookies;
    // 恢复出来的票据往往也是会话级，顺手加固，避免下次启动又掉
    await persistLoginTickets(session.defaultSession).catch(() => {});
    saveAuthFile();
    logger.info(`[登录] 依据登录票据恢复登录态（${ticket.name}），auth.json 已重建`);
    return { ...authState, recovered: true };
  }

  authState.loggedIn = false;
  authState.cookieKeys = [];
  clearAuthFile();
  if (saved) logger.info('[登录] 登录票据已失效，需要重新登录');
  return { ...authState };
}

/* ------------------------------------------------------------------ IPC */

const ipcContext = {
  getAuthState: () => checkAuth(),
  login: () => openLoginWindow(),
  logout: () => logout(),
  confirmLogin: () => finishLogin('manual'),
  getSettings: () => settings.all(),
  setSettings: (patch) => {
    const next = settings.set(patch);
    notifySettingsChanged();
    return next;
  },
  minimizeToTray: () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    return { ok: true };
  },
  showWindow: () => {
    showMainWindow();
    return { ok: true };
  },
  quitApp: () => {
    isQuitting = true;
    app.quit();
  },
  lyricToggle: () => toggleLyricWindow(),
  lyricClose: () => {
    const r = lyricWin.close();
    notifyLyricChanged();
    return r;
  },
  lyricUpdate: (payload) => {
    lyricWin.send(payload);
    return { ok: true };
  },
  lyricLock: (v) => {
    const r = lyricWin.setLocked(v);
    notifyLyricChanged();
    return r;
  },
  lyricStatus: () => lyricWin.status(),
  lyricFont: () => ({ cur: settings.get('lyricFontCur'), next: settings.get('lyricFontNext') }),
  lyricSaveFont: (f) => settings.set({ lyricFontCur: f && f.cur, lyricFontNext: f && f.next }),
};

/* --------------------------------------------------------------- 启动 */

app.whenReady().then(() => {
  if (alreadyRunning) return; // 已有实例在跑，本次启动就此结束
  registerIpc(ipcContext);
  createMainWindow();
  createTray();
  lyricWin.setOnClosed(() => {
    notifyLyricChanged();
  });
  checkAuth();
  // 后台预热解析器（隐藏窗口加载咪咕网页版，复用其官方 SDK 解密播放地址）
  setTimeout(() => resolver.prewarm(), 1500);
  if (process.argv.includes('--smoke')) runSmokeTest();
  if (process.argv.includes('--tray-test')) runTrayTest();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else showMainWindow();
  });
});

// 真正退出前放行 close 拦截
app.on('before-quit', () => {
  isQuitting = true;
});

/** 冒烟测试：以真实入口启动，截图并退出（npm run smoke） */
function runSmokeTest() {
  const guard = setTimeout(() => {
    console.log('SMOKE_TIMEOUT');
    app.exit(3);
  }, 40000);

  mainWindow.webContents.once('did-finish-load', async () => {
    await new Promise((r) => setTimeout(r, 7000));
    try {
      const img = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, 'screenshot-app.png'), img.toPNG());
      const info = await mainWindow.webContents.executeJavaScript(
        `JSON.stringify({
           rows: document.querySelectorAll('.song-row').length,
           cards: document.querySelectorAll('.card').length,
           title: document.querySelector('.page-title') ? document.querySelector('.page-title').textContent : '',
           loginBtn: !!document.getElementById('loginBtn'),
           quality: !!document.getElementById('toneSel'),
           settingsBtn: !!document.getElementById('settingsBtn')
         })`,
        true
      );
      console.log('SMOKE_OK ' + info);

      // 打开设置面板截个图
      await mainWindow.webContents.executeJavaScript(
        `(()=>{document.getElementById('settingsBtn').click();return 1})()`,
        true
      );
      await new Promise((r) => setTimeout(r, 1200));
      const shot2 = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, 'screenshot-settings.png'), shot2.toPNG());
      const panel = await mainWindow.webContents.executeJavaScript(
        `JSON.stringify({
           open: document.getElementById('settingsMask').classList.contains('show'),
           trayChecked: document.getElementById('setTray').checked,
           tone: document.getElementById('setTone').value,
           volume: document.getElementById('setVolume').value
         })`,
        true
      );
      console.log('SETTINGS_PANEL ' + panel);
    } catch (e) {
      console.log('SMOKE_ERR ' + (e.message || e));
    }
    clearTimeout(guard);
    app.exit(0);
  });
}

/** 托盘行为测试：electron . --tray-test */
async function runTrayTest() {
  const LOG = path.join(__dirname, 'tray-test-output.txt');
  const lines = [];
  const say = (m) => {
    lines.push(m);
    console.log(m);
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const guard = setTimeout(() => {
    say('TRAY_TEST_TIMEOUT');
    fs.writeFileSync(LOG, lines.join('\n'));
    app.exit(3);
  }, 45000);

  await wait(6000);
  let failed = 0;
  const ok = (m) => say('  [PASS] ' + m);
  const bad = (m) => {
    failed++;
    say('  [FAIL] ' + m);
  };

  try {
    say('=== 托盘行为测试 ===\n');

    // 1. 托盘图标
    say('[1] 托盘');
    if (tray && !tray.isDestroyed()) ok('托盘图标已创建');
    else bad('托盘未创建');

    // 2. 设置读写
    say('\n[2] 设置读写');
    const before = settings.all();
    say('      当前设置：' + JSON.stringify(before));
    settings.set({ minimizeToTray: true, trayTipShown: true });
    const afterSet = settings.all();
    if (afterSet.minimizeToTray === true) ok('写入 minimizeToTray=true 成功');
    else bad('设置写入失败');
    if (fs.existsSync(path.join(USER_DATA, 'settings.json'))) ok('设置已落盘 settings.json');
    else bad('settings.json 不存在');

    // 3. 关闭窗口 → 应收进托盘（进程保留、窗口隐藏）
    say('\n[3] 开启托盘时点关闭');
    settings.set({ minimizeToTray: true, trayTipShown: true });
    mainWindow.close();
    await wait(1200);
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) ok('窗口已隐藏且进程仍在');
    else bad(`窗口状态异常 destroyed=${!mainWindow || mainWindow.isDestroyed()} visible=${mainWindow && mainWindow.isVisible()}`);

    // 4. 从托盘唤回
    say('\n[4] 从托盘唤回窗口');
    showMainWindow();
    await wait(900);
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) ok('窗口已重新显示');
    else bad('窗口未能唤回');

    // 5. 走退出路径（模拟托盘右键「退出」）时应真正关闭
    say('\n[5] 退出路径');
    settings.set(before); // 还原测试期间改动的设置
    await wait(300);
    app.once('before-quit', () => {
      say('  [PASS] 触发退出流程，程序将真正关闭');
      clearTimeout(guard);
      try {
        fs.writeFileSync(LOG, lines.join('\n'));
      } catch {}
    });
    isQuitting = true;
    mainWindow.close();
    await wait(3500);
    bad('设置了退出标记后窗口仍未关闭');
  } catch (e) {
    bad('异常 ' + (e && e.stack ? e.stack : e));
  }

  if (failed) say('\n=== ' + failed + ' 项失败 ===');
  else say('\n=== 全部通过 ===');
  clearTimeout(guard);
  fs.writeFileSync(LOG, lines.join('\n'));
  app.exit(failed ? 1 : 0);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 安全：禁止渲染层任意跳转
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (event, url) => {
    const allowed = ['file://', 'https://music.migu.cn', 'https://passport.migu.cn'];
    if (!allowed.some((p) => url.startsWith(p))) event.preventDefault();
  });
});
