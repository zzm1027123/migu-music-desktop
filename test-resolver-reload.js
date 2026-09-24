/**
 * 页面重载后 SDK 变量丢失的回归测试
 *
 * 起因：真实报错「读取歌单失败：Cannot read properties of undefined (reading 'get')」。
 * 原因是 pacmtoken 更新会触发解析器重载页面，而重载带走了 window.__miguHttp，
 * 但 ready 标志还是 true —— 于是后续请求全打在了一个没有 SDK 的页面上。
 * 只有「token 值真的变了」时才重载，所以表现为偶发。
 *
 * 期望：重载后调用应当能自动重新探测 SDK 并成功，而不是把 undefined 甩给用户。
 *
 * 运行：electron test-resolver-reload.js
 */
const path = require('path');
const fs = require('fs');
const { app, session } = require('electron');

const TEST_UD = path.join(__dirname, '.userdata-reload');
fs.mkdirSync(TEST_UD, { recursive: true });
app.setPath('userData', TEST_UD);

const resolver = require('./src/resolver');
const logger = require('./src/logger');
logger.init(TEST_UD);

const OUT = path.join(__dirname, 'test-reload-output.txt');
fs.writeFileSync(OUT, '');
const say = (m = '') => {
  fs.appendFileSync(OUT, m + '\n');
  console.log(m);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const ok = (m) => say('  [PASS] ' + m);
const bad = (m) => {
  failed++;
  say('  [FAIL] ' + m);
};

const setPac = (value) =>
  session.defaultSession.cookies.set({
    url: 'https://music.migu.cn/',
    name: 'pacmtoken',
    value,
    domain: '.migu.cn',
    path: '/',
    secure: true,
    httpOnly: true,
    expirationDate: Math.floor(Date.now() / 1000) + 86400,
  });

/** 这个错误就是本次要消灭的 */
const isSdkLostError = (err) => /Cannot read propert|__miguHttp/.test(String(err || ''));

app.whenReady().then(async () => {
  try {
    say('=== 页面重载后 SDK 变量丢失 回归测试 ===\n');

    say('[1] 先用一个 pacmtoken 让解析器起来（首次会重载一次）');
    await setPac('PAC-FIRST-abcdefghijklmnop-0123456789');
    const r1 = await resolver.webCall('/pc/user/home-page/v2.0');
    say('      返回：' + JSON.stringify(r1).slice(0, 120));
    if (!isSdkLostError(r1.err)) ok('首次调用没有 SDK 丢失错误');
    else bad('首次调用就报 SDK 丢失：' + r1.err);
    if (r1.res) ok('确实拿到了服务端响应（说明 SDK 可用）');
    else bad('没拿到响应：' + (r1.err || '（无 err）'));

    say('\n[2] 改掉 pacmtoken 再同步 —— 这会触发页面重载（就是出问题的时机）');
    await setPac('PAC-SECOND-abcdefghijklmnop-0123456789');
    const sync = await resolver.syncPacToken();
    say('      syncPacToken 返回：' + sync);
    if (sync === 'set') ok('识别出值变了并写入了 localStorage（页面已重载）');
    else bad('预期 set，实际 ' + sync);

    say('\n[3] 重载之后立刻调用 —— 这正是之前会报 undefined 的地方');
    const r2 = await resolver.webCall('/pc/user/home-page/v2.0');
    say('      返回：' + JSON.stringify(r2).slice(0, 120));
    if (!isSdkLostError(r2.err)) ok('没有出现「Cannot read properties of undefined」');
    else bad('仍然报 SDK 丢失：' + r2.err);
    if (r2.res) ok('重载后依然拿到了服务端响应（SDK 被重新探测到了）');
    else bad('重载后拿不到响应：' + (r2.err || '（无 err）'));

    say('\n[4] 连打几次，确认不是碰巧');
    let lost = 0;
    let got = 0;
    for (let i = 0; i < 4; i++) {
      const r = await resolver.webCall('/pc/user/home-page/v2.0');
      if (isSdkLostError(r.err)) lost++;
      if (r.res) got++;
      await wait(300);
    }
    say(`      4 次调用：拿到响应 ${got} 次，SDK 丢失 ${lost} 次`);
    if (lost === 0) ok('连打 4 次都没有 SDK 丢失');
    else bad(`还有 ${lost} 次 SDK 丢失`);
    if (got >= 1) ok('解析器整体可用');

    say('\n[5] 保活那种「不重载」的同步也不该出问题');
    await setPac('PAC-THIRD-abcdefghijklmnop-0123456789');
    const sync2 = await resolver.syncPacToken({ reload: false });
    say('      syncPacToken({reload:false}) 返回：' + sync2);
    if (sync2 === 'set') ok('写入了 localStorage 但没有重载页面');
    else bad('预期 set，实际 ' + sync2);
    const r3 = await resolver.webCall('/pc/user/home-page/v2.0');
    if (!isSdkLostError(r3.err) && r3.res) ok('不重载的同步之后调用依然正常');
    else bad('不重载的同步之后调用异常：' + JSON.stringify(r3).slice(0, 120));
  } catch (e) {
    bad('异常 ' + (e && e.stack ? e.stack : e));
  }

  say('\n=== ' + (failed ? failed + ' 项失败' : '重载回归测试通过') + ' ===');
  resolver.destroy();
  app.exit(failed ? 1 : 0);
});
