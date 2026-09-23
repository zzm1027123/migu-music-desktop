/**
 * 登录票据加固验证
 *
 * 要防的是两种"消失"：
 *   - 会话 Cookie（没有 Expires）：Chromium 进程一退就丢；
 *   - pacmtoken 这种服务端给的短周期 Cookie（实测 2 小时），客户端关久了就过期。
 * 两者都会让「关掉客户端过一阵再打开」登录态全废，所以两种都要延长。
 *
 * 分两个进程跑：
 *   phase1：造这两类票据 → 跑加固 → 确认都被延长、值没被改、写入受节流；
 *   phase2：全新进程重新读取，确认票据还在（这才叫跨重启保留）。
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
const SESSION_NAME = 'idmpauth'; // 会话级（没有 Expires）
const SHORT_NAME = 'pacmtoken'; // 服务端给的短周期
const SESSION_VALUE = 'SESSION-TICKET-abcdefghijklmnop-0123456789';
const SHORT_VALUE = 'SHORT-LIVED-token-0987654321-abcdef';
const SHORT_TTL = 7200; // 2 小时

const say = (m = '') => console.log(m);
let failed = 0;
const ok = (m) => say('  [PASS] ' + m);
const bad = (m) => {
  failed++;
  say('  [FAIL] ' + m);
};

const pick = async (sess, name) => (await fullCookies(sess)).find((c) => c.name === name);
const daysLeft = (c) => Math.round(((c.expirationDate || 0) * 1000 - Date.now()) / 86400000);

app.whenReady().then(async () => {
  const sess = session.defaultSession;
  say(`=== 登录票据加固验证（phase${PHASE}）===\n`);

  if (PHASE === 1) {
    // 1) 会话级票据
    await sess.cookies.set({
      url: 'https://music.migu.cn/',
      name: SESSION_NAME,
      value: SESSION_VALUE,
      domain: '.migu.cn',
      path: '/',
      secure: true,
      httpOnly: true,
    });

    // 2) 短周期票据（服务端只给 2 小时）
    await sess.cookies.set({
      url: 'https://music.migu.cn/',
      name: SHORT_NAME,
      value: SHORT_VALUE,
      domain: '.migu.cn',
      path: '/',
      secure: true,
      httpOnly: true,
      expirationDate: Math.floor(Date.now() / 1000) + SHORT_TTL,
    });

    const beforeSession = await pick(sess, SESSION_NAME);
    const beforeShort = await pick(sess, SHORT_NAME);
    if (!beforeSession || !beforeShort) return done('没写进去测试 Cookie');
    if (beforeSession.expirationDate) bad('测试前提不成立：会话票据竟然带了 Expires');
    else ok('测试前提成立：造出一个会话级票据（无 Expires）');
    if (beforeShort.expirationDate) ok(`测试前提成立：造出一个短周期票据（${SHORT_TTL / 3600} 小时）`);
    else bad('测试前提不成立：短周期票据没带上 Expires');

    const r = await persistLoginTickets(sess, 30);
    say('      加固结果 ' + JSON.stringify(r));
    if (r.extended >= 2) ok(`两个票据都被延长了（extended=${r.extended}）`);
    else bad(`只延长了 ${r.extended} 个，短周期票据可能被漏掉`);

    say('\n  —— 会话级票据 ——');
    const afterSession = await pick(sess, SESSION_NAME);
    if (!afterSession) return done('会话票据消失了');
    if (afterSession.value !== SESSION_VALUE) bad('值被改坏了');
    else ok('值保持不变');
    if (daysLeft(afterSession) >= 29) ok(`已变成持久 Cookie，剩余约 ${daysLeft(afterSession)} 天`);
    else bad(`没有延长成功，剩余 ${daysLeft(afterSession)} 天`);
    if (!afterSession.httpOnly) bad('丢了 httpOnly');
    else ok('保留 httpOnly');

    say('\n  —— 短周期票据（这次的关键：pacmtoken 只有 2 小时，不延长就跨不过关闭期）——');
    const afterShort = await pick(sess, SHORT_NAME);
    if (!afterShort) {
      bad('短周期票据消失了');
    } else {
      if (afterShort.value === SHORT_VALUE) ok('值没被改');
      else bad('值被改了');
      if (daysLeft(afterShort) >= 29) ok(`已从 ${SHORT_TTL / 3600} 小时延长到约 ${daysLeft(afterShort)} 天`);
      else bad(`仍然只有 ${daysLeft(afterShort)} 天，没延长成功`);
    }

    say('\n  —— 写入要克制，别反复重写认证 Cookie ——');
    const r2 = await persistLoginTickets(sess, 30);
    say('      紧接着再调一次 ' + JSON.stringify(r2));
    if (r2.throttled) ok('60 秒内被节流，没有再写');
    else bad('没有节流，又写了一遍');

    const r3 = await persistLoginTickets(sess, 30, { force: true });
    say('      force 调一次 ' + JSON.stringify(r3));
    if (r3.extended === 0) ok('force 也只在必要时写：已经够长的直接跳过');
    else bad(`force 又写了 ${r3.extended} 个`);
  } else {
    const a = await pick(sess, SESSION_NAME);
    const b = await pick(sess, SHORT_NAME);
    if (a) ok(`会话票据跨重启保留成功（剩余约 ${daysLeft(a)} 天）`);
    else bad('会话票据重启后不见了');
    if (b) ok(`短周期票据也保住了（剩余约 ${daysLeft(b)} 天）—— 这正是 pacmtoken 过期问题的解药`);
    else bad('短周期票据重启后不见了');
  }

  done();
});

function done(err) {
  if (err) bad(err);
  say('\n=== ' + (failed ? failed + ' 项失败' : '通过') + ' ===');
  app.exit(failed ? 1 : 0);
}
