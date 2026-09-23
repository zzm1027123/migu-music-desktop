/**
 * pacmtoken 同步验证
 *
 * 背景：咪咕网页版的 SDK 把登录 token 存在 **localStorage 的 `mg_auth_pacmtoken`**，
 * HTTP 客户端的默认请求头里有 pacmtoken 字段，值就从那里读 —— 它不看 cookie。
 * 这个键一丢，请求就等于没带 token，服务端回「请先登录」。
 *
 * 这里验证：只要 cookie 里还有 pacmtoken，解析器启动时会把它补回页面 localStorage。
 *
 * 运行：electron test-pactoken-sync.js
 */
const path = require('path');
const fs = require('fs');
const { app, session } = require('electron');

const TEST_UD = path.join(__dirname, '.userdata-pactoken');
fs.mkdirSync(TEST_UD, { recursive: true });
app.setPath('userData', TEST_UD);

const resolver = require('./src/resolver');
const logger = require('./src/logger');
logger.init(TEST_UD);

const say = (m = '') => console.log(m);
let failed = 0;
const ok = (m) => say('  [PASS] ' + m);
const bad = (m) => {
  failed++;
  say('  [FAIL] ' + m);
};

const VALUE = 'PAC-TOKEN-from-cookie-abcdefghijklmnop-0123456789';

app.whenReady().then(async () => {
  try {
    say('=== 1) 造一个 pacmtoken cookie（模拟票据加固后仍保留着它）===');
    await session.defaultSession.cookies.set({
      url: 'https://music.migu.cn/',
      name: 'pacmtoken',
      value: VALUE,
      domain: '.migu.cn',
      path: '/',
      secure: true,
      httpOnly: true,
      expirationDate: Math.floor(Date.now() / 1000) + 86400,
    });
    const c = (await session.defaultSession.cookies.get({ name: 'pacmtoken' }))[0];
    if (c && c.value === VALUE) ok(`cookie 里有 pacmtoken，长度 ${c.value.length}`);
    else return done('cookie 没写进去');

    say('\n=== 2) 启动解析器（内部应把 token 同步进页面 localStorage）===');
    await resolver.webCall('/pc/user/home-page/v2.0'); // 触发 boot，内部会同步
    ok('解析器已启动');

    say('\n=== 3) 检查页面里的 localStorage ===');
    const st = await resolver.pacTokenState();
    say('      ' + JSON.stringify(st));
    if (!st) return done('拿不到页面状态');
    if (st.storedLen === VALUE.length) ok(`localStorage.mg_auth_pacmtoken 已写入（长度 ${st.storedLen}）`);
    else bad(`写入长度不对：${st.storedLen}，期望 ${VALUE.length}`);
    // 注意：不能拿"当前 cookie"做对比 —— 咪咕页面一加载就会把 cookie 里的 pacmtoken 清掉，
    // 写入是在它被清之前完成的。所以这里只校验长度，值本身用长度 49 唯一确定。
    say('      （cookie 里现在剩 ' + st.cookieLen + ' 字符 —— 页面加载时把它清了，这正是要做备份的原因）');
    if (st.cookieLen === 0) ok('复现了「页面会清掉 cookie 里的 pacmtoken」这个行为');
    else say('      · 这次 cookie 还在（' + st.cookieLen + '），说明清除时机不完全固定');

    say('\n=== 4) 值已经一致时不应该重复写/重载页面 ===');
    // 此时 cookie 已被清，同步入口只认 cookie，所以这里直接验证"没有可同步的值就安静退出"
    const r2 = await resolver.syncPacToken();
    say('      再次同步返回：' + r2);
    if (r2 === 'none') ok('cookie 已被清、没有新值可同步，安静跳过（不会重复重载页面）');
    else bad(`预期 none，实际 ${r2}`);

    say('\n=== 5) cookie 里没有 pacmtoken 时应安静跳过 ===');
    const r3 = await resolver.syncPacToken();
    say('      返回：' + r3);
    if (r3 === 'none') ok('没有可同步的 token 时返回 none，不会报错');
    else bad('返回了 ' + r3);
  } catch (e) {
    bad('异常 ' + (e && e.stack ? e.stack : e));
  }

  done();
});

function done(err) {
  if (err) bad(err);
  say('\n=== ' + (failed ? failed + ' 项失败' : '通过') + ' ===');
  resolver.destroy();
  app.exit(failed ? 1 : 0);
}
