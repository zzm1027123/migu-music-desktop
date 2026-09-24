/**
 * 播放地址解析器（核心模块）
 *
 * 背景：咪咕网页版的播放接口 `/strategy/pc/listen/v2.0` 响应是加密的
 * （调用处写的是 `{encrypt: !0}`），拿到的字节流无法直接解析；
 * 而 App 端的老接口 `listenSong.do` 不认网页版登录态，会员歌曲一律拿不到地址。
 *
 * 解决：用一个隐藏窗口加载咪咕网页版，复用**它自己的 @migusdk 模块**完成
 * 「请求 + 解密」两件事。好处：
 *   1. 不用担心官方改加密算法；
 *   2. 隐藏窗口与主程序共享持久化 Session，自动携带登录 Cookie，
 *      因此会员账号的权益能正常生效；
 *   3. 动态发现 SDK chunk 名，官方改版换 hash 也不会失效。
 */
const { BrowserWindow, session } = require('electron');
const logger = require('./logger');

const PAGE_URL = 'https://music.migu.cn/v5/';
const FALLBACK_SDK = '/v5/static/js/@migusdk-617e3513.js';

const TONE_CHAIN = {
  PQ: ['PQ', 'LQ'],
  HQ: ['HQ', 'PQ', 'LQ'],
  SQ: ['SQ', 'HQ', 'PQ', 'LQ'],
  LQ: ['LQ'],
};

let win = null;
let booting = null;
let ready = false;
let lastError = '';

/**
 * 把 cookie 里的 pacmtoken 补进页面的 localStorage。
 *
 * 这是登录态"看起来还在、实际用不了"的真正原因：
 * 咪咕网页版的 SDK 把登录 token 放在 **localStorage 的 `mg_auth_pacmtoken`**，
 * HTTP 客户端的默认请求头里有 `pacmtoken` 字段，值就从那里读 —— 它**不看 cookie**。
 * 而登录态失效、或页面重新初始化时这个键会丢，于是请求等于没带 token，
 * 服务端一律回「请先登录」（注意不是"token 无效"，是压根没带）。
 *
 * 我们已经在票据加固那一层保住了 cookie 里的 pacmtoken，这里把它同步回
 * localStorage。
 *
 * 关于 reload：页面重载能逼 SDK 用新 token 重新初始化，但重载之后
 * `window.__miguHttp` 就没了 —— 所以重载完必须把 ready 置回 false，
 * 否则后续请求会打在一个没有 SDK 的页面上，报
 * 「Cannot read properties of undefined (reading 'get')」。
 * 运行时（保活）同步一律传 reload:false，避免重载打断正在进行的请求。
 *
 * @returns {Promise<'same'|'set'|'none'|'error'>}
 */
async function restorePacToken(w, opts = {}) {
  const reload = opts.reload !== false;
  try {
    const cookies = await session.defaultSession.cookies.get({ name: 'pacmtoken' });
    const c = (cookies || []).find((x) => x.value && x.value.length > 12);
    if (!c) return 'none';

    const js = `(() => {
      try {
        const cur = localStorage.getItem('mg_auth_pacmtoken');
        if (cur === ${JSON.stringify(c.value)}) return 'same';
        localStorage.setItem('mg_auth_pacmtoken', ${JSON.stringify(c.value)});
        return 'set';
      } catch (e) { return 'error'; }
    })()`;
    const r = await w.webContents.executeJavaScript(js, true);
    if (r === 'set') {
      if (!reload) {
        logger.info('[解析器] 已把 pacmtoken 写入页面 localStorage（本次不重载，下次打开页面生效）');
        return r;
      }
      logger.info('[解析器] 已把 cookie 里的 pacmtoken 补回页面 localStorage，重载页面让 SDK 重新初始化');
      const done = new Promise((resolve) => {
        w.webContents.once('did-finish-load', resolve);
        setTimeout(resolve, 8000);
      });
      w.webContents.reload();
      await done;
      // 关键：重载带走了 window.__miguHttp，标记未就绪，下次调用会重新探测
      if (win === w) ready = false;
    }
    return r;
  } catch (e) {
    logger.warn('[解析器] 同步 pacmtoken 失败：' + ((e && e.message) || e));
    return 'error';
  }
}

/** 对外的便捷入口：窗口还活着就把 pacmtoken 同步一次 */
async function syncPacToken(opts = {}) {
  if (!alive()) return 'none';
  return restorePacToken(win, opts);
}

/** 诊断用：页面里 pacmtoken 的现状 */
async function pacTokenState() {
  if (!alive()) return null;
  try {
    const cookies = await session.defaultSession.cookies.get({ name: 'pacmtoken' });
    const cookieVal = ((cookies || [])[0] || {}).value || '';
    const js = `JSON.stringify({
      storedLen: (localStorage.getItem('mg_auth_pacmtoken') || '').length,
      cookieLen: ${JSON.stringify(cookieVal.length)},
      same: localStorage.getItem('mg_auth_pacmtoken') === ${JSON.stringify(cookieVal)}
    })`;
    return JSON.parse(await win.webContents.executeJavaScript(js, true));
  } catch {
    return null;
  }
}

/** 在页面里定位并加载 migusdk，返回其 http 客户端可用性 */
const SDK_PROBE = `(async () => {
  const found = performance.getEntriesByType('resource')
    .map(e => e.name)
    .filter(n => /@migusdk-[\\w-]+\\.js$/.test(n));
  const candidates = [...found, '${FALLBACK_SDK}'];
  for (const u of candidates) {
    try {
      const m = await import(u);
      if (m && m.h && typeof m.h.get === 'function') {
        window.__miguHttp = m.h;
        window.__miguSdkUrl = u;
        return u;
      }
    } catch (e) { /* 试下一个 */ }
  }
  throw new Error('未能在页面中找到 migusdk 模块');
})()`;

function alive() {
  return win && !win.isDestroyed();
}

async function boot() {
  if (alive() && ready) return win;
  if (booting) return booting;

  booting = (async () => {
    if (!alive()) {
      const w = new BrowserWindow({
        show: false,
        width: 1100,
        height: 800,
        title: '咪咕音乐解析器',
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
          // 使用默认持久化 session —— 与主窗口共享登录 Cookie
        },
      });
      w.on('closed', () => {
        if (win === w) {
          win = null;
          ready = false;
        }
      });
      win = w;
      await w.loadURL(PAGE_URL);
      await restorePacToken(w);
    }

    // 页面刚加载时 SDK 可能还没在 performance 里登记，重试几次
    const t0 = Date.now();
    let lastErr = null;
    for (let i = 0; i < 12; i++) {
      try {
        const url = await win.webContents.executeJavaScript(SDK_PROBE, true);
        ready = true;
        lastError = '';
        logger.info(`[解析器] 就绪，耗时 ${Date.now() - t0}ms，SDK=${String(url).split('/').pop()}`);
        return { ok: true, sdk: url };
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    ready = false;
    lastError = lastErr ? String(lastErr.message || lastErr) : 'unknown';
    logger.error('[解析器] 初始化失败：' + lastError);
    throw new Error(lastError);
  })();

  try {
    return await booting;
  } catch (e) {
    booting = null;
    throw e;
  } finally {
    // 无条件清空：如果这里因为 ready 为 false 而留着旧 promise，
    // 后面 ready 被置回 false（比如页面重载）时就再也 boot 不起来了
    booting = null;
  }
}

/** 预热（启动后台加载，不阻塞界面） */
function prewarm() {
  boot().catch((e) => {
    lastError = String(e.message || e);
  });
}

/** 解析单曲播放地址（含音质降级） */
async function resolvePlayUrl(song, tone = 'PQ') {
  if (!song || !song.contentId) return { url: null, via: 'none', info: '缺少 contentId' };
  try {
    await boot();
  } catch (e) {
    return { url: null, via: 'none', info: '解析器不可用：' + (e.message || e) };
  }

  const chain = TONE_CHAIN[tone] || TONE_CHAIN.PQ;
  const tried = [];

  for (const flag of chain) {
    const params = {
      scene: '',
      netType: '01',
      resourceType: '2',
      copyrightId: song.copyrightId || '0',
      contentId: song.contentId,
      toneFlag: flag,
    };
    const js = `(async () => {
      try {
        const res = await window.__miguHttp.get('/strategy/pc/listen/v2.0', ${JSON.stringify(params)}, { encrypt: true });
        return JSON.stringify({ ok: true, res });
      } catch (e) {
        return JSON.stringify({ ok: false, err: String((e && e.message) || e) });
      }
    })()`;

    let payload;
    try {
      payload = JSON.parse(await win.webContents.executeJavaScript(js, true));
    } catch (e) {
      tried.push(flag + ':exec-err');
      continue;
    }
    if (!payload.ok) {
      tried.push(flag + ':err');
      lastError = payload.err;
      continue;
    }
    const res = payload.res || {};
    const data = res.data || {};
    if (res.code === '000000' && data.url) {
      return {
        url: data.url,
        tone: data.audioFormatType || flag,
        lrcUrl: data.lrcUrl || '',
        song: data.song || null,
        via: 'web-sdk',
        tried,
      };
    }
    tried.push(`${flag}:${res.code || '?'}`);
  }

  return { url: null, via: 'web-sdk', tried, info: lastError || '该歌曲当前账号无权播放（可能需要会员或受版权限制）' };
}

/**
 * 通用调用：借用网页版自己的 http 客户端发请求。
 * 咪咕的用户类接口（歌单、收藏等）依赖客户端自动注入的 uid / token 等 header，
 * 直接用自己的 net 请求会返回「请先登录」，所以统一走这里。
 */
async function webCall(pathname, params = {}, method = 'get', _retry = 0) {
  try {
    await boot();
  } catch (e) {
    return { ok: false, err: '解析器不可用：' + (e.message || e) };
  }
  const js = `(async () => {
    try {
      const res = await window.__miguHttp[${JSON.stringify(method)}](${JSON.stringify(pathname)}, ${JSON.stringify(
    params || {}
  )});
      return JSON.stringify({ ok: true, res });
    } catch (e) {
      return JSON.stringify({ ok: false, err: String((e && e.message) || e) });
    }
  })()`;
  try {
    const out = JSON.parse(await win.webContents.executeJavaScript(js, true));
    /*
     * 页面重载过（比如 pacmtoken 更新触发的）会让 window.__miguHttp 消失，
     * 这时所有请求都会报「Cannot read properties of undefined」。
     * 重新探测一次 SDK 再重试，别把这种一次性的状态问题甩给用户。
     */
    if (!out.ok && /Cannot read propert|__miguHttp/.test(String(out.err || '')) && _retry < 1) {
      logger.warn('[解析器] SDK 变量丢失（页面可能刚重载过），重新探测后重试');
      ready = false;
      try {
        await boot();
      } catch (e) {
        return { ok: false, err: '解析器重新初始化失败：' + ((e && e.message) || e) };
      }
      return webCall(pathname, params, method, _retry + 1);
    }
    return out;
  } catch (e) {
    return { ok: false, err: String((e && e.message) || e) };
  }
}

/** 批量查询可播放性（用于在列表上标注 VIP / 不可播） */
async function canListen(contentIds) {
  const ids = (contentIds || []).filter(Boolean);
  if (!ids.length) return {};
  try {
    await boot();
  } catch {
    return {};
  }
  const js = `(async () => {
    try {
      const res = await window.__miguHttp.post('/strategy/pc/can-listen/v1.0', {
        contentIds: ${JSON.stringify(ids.join(','))}, curPlayContentId: ''
      });
      return JSON.stringify(res);
    } catch (e) { return JSON.stringify({ code: '-1', info: String((e && e.message) || e) }); }
  })()`;
  try {
    const res = JSON.parse(await win.webContents.executeJavaScript(js, true));
    const map = {};
    const list = (res && res.data && res.data.canListenRespItemList) || [];
    for (const it of list) map[it.contentId] = { canListen: !!it.canListen, limitLength: !!it.limitLength };
    return map;
  } catch {
    return {};
  }
}

function status() {
  return { ready, hasWindow: alive(), lastError };
}

function destroy() {
  if (alive()) {
    try {
      win.destroy();
    } catch {}
  }
  win = null;
  ready = false;
  booting = null;
}

module.exports = {
  resolvePlayUrl,
  canListen,
  webCall,
  prewarm,
  status,
  destroy,
  restorePacToken,
  syncPacToken,
  pacTokenState,
};
