/**
 * 登录票据加固
 *
 * 咪咕把登录态挂在一组 Cookie 上，它们会以两种方式"消失"：
 *
 *   - idmpauth / mg_auth_sid / migu-utoken-sessionid 常常是**会话 Cookie**（没有 Expires），
 *     Chromium 一退出进程就丢掉；
 *   - pacmtoken 由服务端下发，**短周期**（实测只有 2 小时），靠客户端持续请求来续期。
 *
 * 两者都会导致「关掉客户端过一阵子再打开，登录态就没了」。实测过一次：
 * 09:21 关客户端，pacmtoken 在 11:21 过期并被浏览器删掉，12:09 再启动时请求里
 * 已经没有这个 Cookie，服务端一律回「请先登录」，歌单等用户态接口全废。
 *
 * 做法：把这些票据的浏览器侧有效期统一延长，让它们能跨过"客户端没在运行"的这段时间。
 *
 * 两条约束（都是踩坑换来的）：
 *
 * 1) 写入必须克制。cookies.get 读到 value 和 cookies.set 写回之间，服务端可能已经
 *    换发了新 token，这一写就把新 token 覆盖成旧的 —— 登录态会当场失效。
 *    所以：同一个 value 每个进程只写一次，且两次加固之间至少间隔 60 秒。
 * 2) 只在有意义的时机写：启动、登录成功、定时保活、退出前。不要每次查登录态都写。
 *
 * 单独成模块是为了能脱离 main.js 直接单测（见 test-ticket-persist.js）。
 */
const logger = require('./logger');

/** 咪咕的登录票据 Cookie 名 */
const LOGIN_TICKET_NAMES = ['idmpauth', 'pacmtoken', 'mg_auth_sid', 'migu-utoken-sessionid', 'migu-utoken'];

/** 票据可能落在这些域上 */
const TICKET_DOMAINS = ['.migu.cn', 'music.migu.cn', 'passport.migu.cn'];

/** 两次加固之间的最小间隔，防止频繁重写认证 Cookie */
const MIN_INTERVAL_MS = 60 * 1000;

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

/** 本进程内已经加固过的 `名字@域@路径=值`，同一个值不重复写 */
const hardened = new Set();
let lastRunAt = 0;

/**
 * 把登录票据的浏览器侧有效期延长。
 * @param {Electron.Session} sess
 * @param {number} days 保留天数
 * @param {{force?: boolean}} [opts] force 可越过节流（登录成功、退出前用）
 * @returns {Promise<{total:number, extended:number, skipped:number, failed:number, throttled?:boolean}>}
 */
async function persistLoginTickets(sess, days = 30, opts = {}) {
  const force = !!(opts && opts.force);
  const now = Date.now();
  if (!force && lastRunAt && now - lastRunAt < MIN_INTERVAL_MS) {
    return { total: 0, extended: 0, skipped: 0, failed: 0, throttled: true };
  }
  lastRunAt = now;

  const cookies = await fullCookies(sess);
  const tickets = cookies.filter((c) => LOGIN_TICKET_NAMES.includes(c.name) && (c.value || '').length > 12);
  if (!tickets.length) return { total: 0, extended: 0, skipped: 0, failed: 0 };

  const until = Math.floor(now / 1000) + days * 86400;
  let extended = 0;
  let skipped = 0;
  let failed = 0;

  for (const c of tickets) {
    // 已经比目标还长就不动它，避免无谓重写
    if (c.expirationDate && c.expirationDate >= until) {
      skipped += 1;
      continue;
    }
    const key = `${c.name}@${c.domain}@${c.path}=${c.value}`;
    if (hardened.has(key)) {
      skipped += 1;
      continue;
    }
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
      hardened.add(key);
      extended += 1;
    } catch (e) {
      failed += 1;
      logger.warn(`[登录] 票据 ${c.name} 持久化失败：${(e && e.message) || e}`);
    }
  }

  if (extended || failed) {
    // 带上名字和 value 长度：以后排查登录态问题，能看出 token 是否被换发
    const detail = tickets.map((c) => `${c.name}:${String(c.value || '').length}`).join(' ');
    logger.info(
      `[登录] 票据加固：票据 ${tickets.length} 个，本次延长有效期 ${extended} 个（${days} 天）` +
        `${skipped ? `，跳过 ${skipped} 个` : ''}${failed ? `，失败 ${failed} 个` : ''} [${detail}]`
    );
  }
  return { total: tickets.length, extended, skipped, failed };
}

module.exports = { LOGIN_TICKET_NAMES, TICKET_DOMAINS, fullCookies, persistLoginTickets };
