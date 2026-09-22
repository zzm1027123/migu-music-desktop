/**
 * 登录票据加固
 *
 * 背景：咪咕登录后下发的 idmpauth / pacmtoken / mg_auth_sid 里有几个是**会话 Cookie**
 * （没有 Expires）。Chromium 在进程退出时会把会话 Cookie 丢掉，于是一重启客户端登录态就没了 ——
 * 表现是「昨天登录过，今天打开又要重新登录」，而所有用户态接口（我的歌单、收藏、
 * 加入歌单）会一起失效，服务端还只会回一句看不懂的「请求错误，参数校验失败」。
 *
 * 这里在登录成功（或依据票据恢复登录态）后，把票据补上过期时间改写成持久 Cookie，
 * 让登录态能跨重启保留。只动 LOGIN_TICKET_NAMES 里的票据，不碰任何业务/埋点 Cookie。
 *
 * 单独成模块是为了能脱离 main.js 直接单测（见 test-ticket-persist.js）。
 */
const logger = require('./logger');

/** 咪咕的登录票据 Cookie 名 */
const LOGIN_TICKET_NAMES = ['idmpauth', 'pacmtoken', 'mg_auth_sid', 'migu-utoken-sessionid', 'migu-utoken'];

/** 票据可能落在这些域上 */
const TICKET_DOMAINS = ['.migu.cn', 'music.migu.cn', 'passport.migu.cn'];

/** 完整 Cookie 记录（带 value / 过期时间 / secure 等），用于加固 */
async function fullCookies(sess) {
  try {
    const all = [];
    for (const d of TICKET_DOMAINS) {
      all.push(...(await sess.cookies.get({ domain: d })));
    }
    const map = new Map();
    for (const c of all) map.set(`${c.name}@${c.domain}@${c.path}`, c);
    return [...map.values()];
  } catch {
    return [];
  }
}

let loggedSig = '';

/**
 * 把登录票据改写成持久 Cookie。
 * @param {Electron.Session} sess
 * @param {number} days 保留天数
 * @returns {Promise<{total:number, session:number, extended:number, failed:number}>}
 */
async function persistLoginTickets(sess, days = 30) {
  const cookies = await fullCookies(sess);
  const tickets = cookies.filter((c) => LOGIN_TICKET_NAMES.includes(c.name) && (c.value || '').length > 12);
  if (!tickets.length) return { total: 0, session: 0, extended: 0, failed: 0 };

  const until = Math.floor(Date.now() / 1000) + days * 86400;
  let sessionCount = 0;
  let extended = 0;
  let failed = 0;

  for (const c of tickets) {
    if (!c.expirationDate) sessionCount += 1;
    if (c.expirationDate && c.expirationDate >= until) continue; // 已经够长，不重复写
    const host = String(c.domain || '').replace(/^\./, '');
    try {
      await sess.cookies.set({
        url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        sameSite: c.sameSite || 'unspecified',
        expirationDate: until,
      });
      extended += 1;
    } catch (e) {
      failed += 1;
      logger.warn(`[登录] 票据 ${c.name} 持久化失败：${(e && e.message) || e}`);
    }
  }

  const sig = `${tickets.length}/${sessionCount}/${extended}`;
  if (sig !== loggedSig) {
    loggedSig = sig;
    logger.info(
      `[登录] 票据加固：票据 ${tickets.length} 个，其中会话级 ${sessionCount} 个，` +
        `本次延长有效期 ${extended} 个（${days} 天）${failed ? `，失败 ${failed} 个` : ''}`
    );
  }
  return { total: tickets.length, session: sessionCount, extended, failed };
}

module.exports = { LOGIN_TICKET_NAMES, TICKET_DOMAINS, fullCookies, persistLoginTickets };
