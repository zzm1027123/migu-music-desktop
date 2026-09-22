/**
 * 只读诊断：列出指定 userData 目录里现存的 Cookie 与登录票据。
 *
 * 重点看 expires 那一列：
 *   - 「会话级(重启即失效)」= 这种 Cookie 在客户端退出时会被 Chromium 丢掉，
 *     是「登录过又莫名失效、歌单用不了」的直接原因；
 *   - 具体日期 = 已被 src/login-tickets.js 加固成持久 Cookie，能跨重启保留。
 *
 * 用法：
 *   set MIGU_USER_DATA=D:\path\to\.userdata
 *   electron check-cookies.js
 * 不带环境变量时检查开发目录下的 ./.userdata
 */
const path = require('path');
const { app, session } = require('electron');

app.setPath('userData', process.env.MIGU_USER_DATA || path.join(__dirname, '.userdata'));

const LOGIN_TICKETS = ['idmpauth', 'pacmtoken', 'mg_auth_sid', 'migu-utoken-sessionid', 'migu-utoken'];

function fmtExp(sec) {
  if (!sec) return '会话级(重启即失效)';
  return new Date(sec * 1000).toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
}

app.whenReady().then(async () => {
  const cookies = await session.defaultSession.cookies.get({});

  console.log('userData =', app.getPath('userData'));
  console.log('COOKIE_COUNT =', cookies.length);
  console.log('');
  for (const c of cookies) {
    const isTicket = LOGIN_TICKETS.includes(c.name);
    console.log(
      `  ${isTicket ? '*' : ' '} ${String(c.name).padEnd(46)} ${String(c.domain).padEnd(20)} ` +
        `len=${String((c.value || '').length).padEnd(4)} expires=${fmtExp(c.expirationDate)}`
    );
  }

  const alive = cookies.filter((c) => LOGIN_TICKETS.includes(c.name));
  console.log('');
  console.log('LOGIN_TICKETS =', alive.length);
  if (!alive.length) {
    console.log('=> 没有登录票据，需要重新登录（歌单 / 收藏 / 加入歌单都会失效）');
  } else {
    const sessionOnly = alive.filter((c) => !c.expirationDate);
    console.log('=> 存在登录票据，客户端应能自动认回登录态');
    if (sessionOnly.length) {
      console.log(
        `   ！其中 ${sessionOnly.length} 个是会话级（${sessionOnly.map((c) => c.name).join(', ')}），` +
          '重启客户端就会丢 —— 正常情况下登录后应已被加固成持久 Cookie'
      );
    }
  }
  app.exit(0);
});
