/**
 * 登录票据加固验证
 *
 * 关键点：会话 Cookie（没有 Expires）在 Chromium 进程退出后会被丢掉，
 * 这正是「昨天登录过、今天歌单就用不了」的根因。本测试分成两个进程：
 *   phase1：造一个会话级票据 Cookie，跑加固，确认它变成了持久 Cookie；
 *           同时确认**服务端下发的持久票据一个字节都没被改动**；
 *   phase2：全新进程重新读取，确认票据还在（这才叫「跨重启保留」）。
 *
 * 运行：electron test-ticket-persist.js
 */
const path = require('path');
const fs = require('fs');
const { app, session } = require('electron');

const TEST_UD = path.join(__dirname, '.userdata-ticket');
fs.mkdirSync(TEST_UD, { recursive: true });
app.setPath('userData', TEST_UD);

const { persistLoginTickets, fullCookies } = require('./src/login-tickets');
const logger = require('./src/logger');
logger.init(TEST_UD);

const PHASE = process.argv.includes('--phase2') ? 2 : 1;
const NAME = 'pacmtoken'; // 会话级的那个（要被加固）
const SERVER_NAME = 'idmpauth'; // 服务端下发的持久票据（不许被碰）
const VALUE = 'TEST-TICKET-abcdefghijklmnop-0123456789';
const SERVER_VALUE = 'SERVER-MANAGED-token-0987654321';
const SERVER_TTL = 3600; // 服务端给的 1 小时

const say = (m = '') => console.log(m);
let failed = 0;
const ok = (m) => say('  [PASS] ' + m);
const bad = (m) => {
  failed++;
  say('  [FAIL] ' + m);
};

const pick = async (sess, name) => (await fullCookies(sess)).find((c) => c.name === name);

app.whenReady().then(async () => {
  const sess = session.defaultSession;
  say(`=== 登录票据加固验证（phase${PHASE}）===\n`);

  if (PHASE === 1) {
    // 1) 会话级票据：模拟咪咕登录后下发的、没有 Expires 的那种
    await sess.cookies.set({
      url: 'https://music.migu.cn/',
      name: NAME,
      value: VALUE,
      domain: '.migu.cn',
      path: '/',
      secure: true,
      httpOnly: true,
    });

    // 2) 服务端管理的持久票据：带一个短 Expires（咪咕会把 pacmtoken 刷成 2 小时这种）
    const serverExp = Math.floor(Date.now() / 1000) + SERVER_TTL;
    await sess.cookies.set({
      url: 'https://music.migu.cn/',
      name: SERVER_NAME,
      value: SERVER_VALUE,
      domain: '.migu.cn',
      path: '/',
      secure: true,
      httpOnly: true,
      expirationDate: serverExp,
    });

    const before = await pick(sess, NAME);
    const beforeServer = await pick(sess, SERVER_NAME);
    if (!before || !beforeServer) return done('没写进去测试 Cookie');
    if (before.expirationDate) bad('测试前提不成立：会话票据竟然带了 Expires');
    else ok('测试前提成立：造出了一个会话级票据（无 Expires）');
    if (beforeServer.expirationDate) ok('测试前提成立：另造了一个服务端管理的短效持久票据');
    else bad('测试前提不成立：服务端票据没带上 Expires');

    const r = await persistLoginTickets(sess, 30);
    say('      加固结果 ' + JSON.stringify(r));
    if (r.extended >= 1) ok(`加固了 ${r.extended} 个会话级票据`);
    else bad('加固没有生效');

    say('\n  —— 会话级票据应当被加固 ——');
    const after = await pick(sess, NAME);
    if (!after) return done('加固后 Cookie 消失了');
    if (after.value !== VALUE) bad('加固把 Cookie 的值改坏了');
    else ok('Cookie 值保持不变');
    if (!after.expirationDate) bad('加固后仍然是会话 Cookie');
    else {
      const days = Math.round((after.expirationDate * 1000 - Date.now()) / 86400000);
      ok(`已变成持久 Cookie，剩余约 ${days} 天`);
    }
    if (!after.httpOnly) bad('加固丢了 httpOnly 属性');
    else ok('保留 httpOnly');
    if (after.name === NAME && String(after.domain).includes('migu.cn')) ok('域名与名字都正确');
    else bad('域名/名字被改坏');

    say('\n  —— 服务端管理的持久票据必须原封不动 ——');
    const afterServer = await pick(sess, SERVER_NAME);
    if (!afterServer) {
      bad('服务端票据被删了');
    } else {
      if (afterServer.value === SERVER_VALUE) ok('值没被改');
      else bad(`值被改了：${afterServer.value}`);
      const drift = Math.abs((afterServer.expirationDate || 0) - serverExp);
      if (drift <= 2) ok(`过期时间没被延长（仍是原来的 ${SERVER_TTL} 秒，误差 ${drift}s）`);
      else {
        const hours = Math.round(((afterServer.expirationDate || 0) - Date.now() / 1000) / 3600);
        bad(`服务端票据的过期时间被改动了：现在约 ${hours} 小时（原本 ${SERVER_TTL / 3600} 小时）`);
      }
    }

    say('\n  —— 同一个值不应该被反复加固 ——');
    const r2 = await persistLoginTickets(sess, 30);
    say('      第二次加固结果 ' + JSON.stringify(r2));
    if (r2.extended === 0) ok('第二次调用没有再写任何 Cookie');
    else bad(`第二次又写了 ${r2.extended} 个，重复加固会放大覆盖新 token 的风险`);
  } else {
    const c = await pick(sess, NAME);
    if (!c) {
      bad('重启后票据不见了 —— 加固没起到跨重启保留的作用');
    } else {
      ok(`重启后票据仍在（值是当初写入的：${c.value === VALUE ? '一致' : '不一致！'}）`);
      if (c.expirationDate) ok(`依然是持久 Cookie，剩余约 ${Math.round((c.expirationDate * 1000 - Date.now()) / 86400000)} 天`);
      else bad('重启后退化成了会话 Cookie');
    }
    const s = await pick(sess, SERVER_NAME);
    if (s && s.value === SERVER_VALUE) ok('服务端票据依然完好');
    else bad('服务端票据丢失或被改动');
  }

  done();
});

function done(err) {
  if (err) bad(err);
  say('\n=== ' + (failed ? failed + ' 项失败' : '通过') + ' ===');
  app.exit(failed ? 1 : 0);
}
