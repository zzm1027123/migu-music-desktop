/**
 * 登录票据加固
 *
 * 背景：咪咕登录后下发的 idmpauth / mg_auth_sid 等票据里有几个是**会话 Cookie**
 * （没有 Expires）。Chromium 在进程退出时会把会话 Cookie 丢掉，于是一重启客户端
 * 登录态就没了 —— 表现是「昨天登录过，今天打开又要重新登录」，而所有用户态接口
 * （我的歌单、收藏、加入歌单）会一起失效，服务端还只会回一句看不懂的
 * 「请求错误，参数校验失败」。
 *
 * 做法：把**会话级**票据补上过期时间，改写成持久 Cookie，让登录态能跨重启保留。
 *
 * 两条硬性约束（都是踩坑之后加的）：
 *
 * 1) 只碰会话级票据。带 Expires 的票据是服务端主动下发的 —— 咪咕会把 pacmtoken
 *    刷新成 2 小时有效这类短周期 Cookie，它们由服务端负责续期。客户端去「延长」
 *    反而危险：cookies.get 读到的 value 和 cookies.set 写回之间，服务端可能已经
 *    换发了新 token，这一写就把新 token 覆盖成旧的，登录态当场失效。
 * 2) 同一个值每个进程只加固一次。否则每次查登录态都会重写一遍认证 Cookie，
 *    把上面那个竞态窗口放大到几乎必然发生。
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

/** 本进程内已经加固过的 `名字@域@路径=值`，同一个值不重复写 */
const hardened = new Set();

/**
 * 把**会话级**登录票据改写成持久 Cookie。
 * @param {Electron.Session} sess
 * @param {number} days 保留天数
 * @returns {Promise<{total:number, extended:number, skipped:number, failed:number}>}
 */
async function persistLoginTickets(sess, days = 30) {
  const cookies = await fullCookies(sess);
  const tickets = cookies.filter(
    (c) => LOGIN_TICKET_NAMES.includes(c.name) && (c.value || '').length > 12 && !c.expirationDate
  );
  if (!tickets.length) return { total: 0, extended: 0, skipped: 0, failed: 0 };

  const until = Math.floor(Date.now() / 1000) + days * 86400;
  let extended = 0;
  let skipped = 0;
  let failed = 0;

  for (const c of tickets) {
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
    // 带上名字和 value 长度：以后要是再出现登录态丢失，能从这里看出 token 是否被换发过
    const detail = tickets.map((c) => `${c.name}:${String(c.value || '').length}`).join(' ');
    logger.info(
      `[登录] 票据加固：会话级票据 ${tickets.length} 个，本次延长有效期 ${extended} 个（${days} 天）` +
        `${skipped ? `，已加固过跳过 ${skipped} 个` : ''}${failed ? `，失败 ${failed} 个` : ''} [${detail}]`
    );
  }
  return { total: tickets.length, extended, skipped, failed };
}

module.exports = { LOGIN_TICKET_NAMES, TICKET_DOMAINS, fullCookies, persistLoginTickets };
