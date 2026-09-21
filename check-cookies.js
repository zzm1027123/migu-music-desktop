/**
 * 只读诊断：列出指定 userData 目录里现存的 Cookie 与登录票据。
 * 用法：
 *   set MIGU_USER_DATA=D:\path\to\.userdata
 *   electron check-cookies.js
 * 不带环境变量时检查开发目录下的 ./.userdata
 */
const path = require('path');
const { app, session } = require('electron');

app.setPath('userData', process.env.MIGU_USER_DATA || path.join(__dirname, '.userdata'));

const LOGIN_TICKETS = ['idmpauth', 'pacmtoken', 'mg_auth_sid', 'migu-utoken-sessionid', 'migu-utoken'];

app.whenReady().then(async () => {
  const cookies = await session.defaultSession.cookies.get({});
  const list = cookies.map((c) => ({ name: c.name, domain: c.domain, len: (c.value || '').length }));

  console.log('userData =', app.getPath('userData'));
  console.log('COOKIE_COUNT =', cookies.length);
  for (const c of list) console.log(`  ${String(c.name).padEnd(46)} ${String(c.domain).padEnd(20)} len=${c.len}`);

  const alive = list.filter((c) => LOGIN_TICKETS.includes(c.name));
  console.log('LOGIN_TICKETS =', JSON.stringify(alive));
  console.log(alive.length ? '=> 存在登录票据，客户端应能自动认回登录态' : '=> 没有登录票据，需重新登录');
  app.exit(0);
});
