/**
 * 登录票据加固验证
 *
 * 关键点：会话 Cookie（没有 Expires）在 Chromium 进程退出后会被丢掉，
 * 这正是「昨天登录过、今天歌单就用不了」的根因。本测试分成两个进程：
 *   phase1：造一个会话级票据 Cookie，跑加固，确认它变成了持久 Cookie；
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
const NAME = 'pacmtoken';
const VALUE = 'TEST-TICKET-abcdefghijklmnop-0123456789';

const say = (m = '') => console.log(m);
let failed = 0;
const ok = (m) => say('  [PASS] ' + m);
const bad = (m) => {
  failed++;
  say('  [FAIL] ' + m);
};

const pick = async (sess) => (await fullCookies(sess)).find((c) => c.name === NAME);

app.whenReady().then(async () => {
  const sess = session.defaultSession;
  say(`=== 登录票据加固验证（phase${PHASE}）===\n`);

  if (PHASE === 1) {
    // 造一个会话级票据，模拟咪咕登录后下发的 Cookie
    await sess.cookies.set({
      url: 'https://music.migu.cn/',
      name: NAME,
      value: VALUE,
      domain: '.migu.cn',
      path: '/',
      secure: true,
      httpOnly: true,
    });

    const before = await pick(sess);
    if (!before) return done('没写进去测试 Cookie');
    if (before.expirationDate) bad('测试前提不成立：造出来的不是会话 Cookie');
    else ok('测试前提成立：造出了一个会话级 Cookie（无 Expires）');

    const r = await persistLoginTickets(sess, 30);
    say('      加固结果 ' + JSON.stringify(r));
    if (r.extended >= 1) ok(`加固了 ${r.extended} 个票据`);
    else bad('加固没有生效');

    const after = await pick(sess);
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
  } else {
    const c = await pick(sess);
    if (!c) {
      bad('重启后票据不见了 —— 加固没起到跨重启保留的作用');
    } else {
      ok(`重启后票据仍在（值是当初写入的：${c.value === VALUE ? '一致' : '不一致！'}）`);
      if (c.expirationDate) ok(`依然是持久 Cookie，剩余约 ${Math.round((c.expirationDate * 1000 - Date.now()) / 86400000)} 天`);
      else bad('重启后退化成了会话 Cookie');
    }
  }

  done();
});

function done(err) {
  if (err) bad(err);
  say('\n=== ' + (failed ? failed + ' 项失败' : '通过') + ' ===');
  app.exit(failed ? 1 : 0);
}
