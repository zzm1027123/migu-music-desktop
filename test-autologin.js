/**
 * 自动登录诊断 v2：走真实登录路径
 *
 * 真实用户在 music.migu.cn 上点「登录」，表单是嵌在 passport.migu.cn 的 iframe 里的；
 * 登录完成后由**父页面**完成业务登录（种下 pacmtoken 等）。
 *
 * 直接开 passport 页面填表虽然能提交成功，但那条回调链走不完 ——
 * 只拿得到 LTToken，业务请求照样被拒（这正是「登录成功但下次启动又是未登录」的根源）。
 *
 * 运行：electron test-autologin.js
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, session } = require('electron');

const { prepareUserData } = require('./test-util');
app.setPath('userData', prepareUserData('.userdata-autologin'));

const credentials = require('./src/credentials');
const LOGIN_DIR = path.join(app.getPath('userData'), 'login');
const LOGIN_URL = 'https://music.migu.cn/v5/#/musicLibrary';

const OUT = path.join(__dirname, 'test-autologin-output.txt');
fs.writeFileSync(OUT, '');
const say = (m = '') => {
  fs.appendFileSync(OUT, m + '\n');
  console.log(m);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在音乐库页面上点「登录」入口 */
const CLICK_ENTRY_JS = `(() => {
  try {
    for (const el of document.querySelectorAll('div,span,a,button,li')) {
      if (el.children.length) continue;
      if ((el.innerText || '').trim() === '登录' && el.offsetParent !== null) { el.click(); return 'clicked'; }
    }
    return 'no-entry';
  } catch (e) { return 'err:' + e.message; }
})()`;

/** 在 passport iframe 内部填表（这些选择器只在这个 frame 里存在） */
const FILL_JS = (username, password) => `(() => {
  const out = { switched: '', user: false, pass: false, agreed: false, captcha: false };
  for (const el of document.querySelectorAll('button,a,div,span,li,label')) {
    if (el.children.length) continue;
    if ((el.innerText || '').trim() === '密码登录' && el.offsetParent !== null) { el.click(); out.switched = 'clicked'; break; }
  }
  const setVal = (el, v) => {
    if (!el) return false;
    try {
      const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      d.set.call(el, v);
    } catch (e) { el.value = v; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  out.user = setVal(document.getElementById('J_AccountPsd'), ${JSON.stringify(username)});
  out.pass = setVal(document.getElementById('J_PasswordPsd'), ${JSON.stringify(password)});
  const cap = document.getElementById('J_ImgCodePsd');
  out.captcha = !!(cap && cap.offsetParent !== null);
  for (const b of document.querySelectorAll('input.J_mobileIsReadPrivacy')) {
    if (b.checked) { out.agreed = true; break; }
    const wrap = b.closest('label') || b.parentElement;
    if (!/同意|协议/.test(wrap ? wrap.innerText || '' : '')) continue;
    try { (wrap || b).click(); } catch (e) {}
    if (!b.checked) { try { b.click(); } catch (e) {} }
    if (b.checked) { out.agreed = true; break; }
  }
  return JSON.stringify(out);
})()`;

const SUBMIT_JS = `(() => {
  const acc = document.getElementById('J_AccountPsd');
  const form = acc ? acc.closest('form') : null;
  const btn = form ? form.querySelector('button[type="submit"],input[type="submit"]') : null;
  if (btn && btn.offsetParent !== null) { btn.click(); return 'clicked-button'; }
  const any = document.querySelector('input[type="submit"],button[type="submit"]');
  if (any && any.offsetParent !== null) { any.click(); return 'clicked-any'; }
  if (form) { form.submit(); return 'form-submit'; }
  return 'no-submit';
})()`;

/** 找出 passport 的 frame */
function passportFrame(win) {
  const walk = (f, acc = []) => {
    acc.push(f);
    (f.frames || []).forEach((x) => walk(x, acc));
    return acc;
  };
  return walk(win.webContents.mainFrame).find((f) => f.url.includes('passport.migu.cn'));
}

app.whenReady().then(async () => {
  const cred = credentials.load(LOGIN_DIR);
  if (!cred) {
    say('没有读到保存的账号密码');
    app.exit(1);
    return;
  }
  say('账号：' + cred.username);

  const w = new BrowserWindow({
    show: true,
    width: 900,
    height: 760,
    title: '自动登录诊断 v2',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  const cookieSnap = async (tag) => {
    const cs = await session.defaultSession.cookies.get({});
    const l = cs.filter((c) => /auth|token|sid/i.test(c.name)).map((c) => `${c.name}(${c.value.length})`);
    say(`      [${tag}] cookies: ` + (l.join(', ') || '(无)'));
  };

  try {
    say('\n=== [1] 打开音乐库首页 ===');
    await w.loadURL(LOGIN_URL);
    await wait(6000);
    say('      url: ' + w.webContents.getURL());
    await cookieSnap('初始');

    say('\n=== [2] 点击「登录」入口 ===');
    const clicked = await w.webContents.executeJavaScript(CLICK_ENTRY_JS, true);
    say('      ' + clicked);
    await wait(6000);
    say('      主页面 url: ' + w.webContents.getURL());

    const frames = [];
    const walk = (f) => {
      frames.push(f.url);
      (f.frames || []).forEach(walk);
    };
    walk(w.webContents.mainFrame);
    say('      frames:');
    frames.forEach((u) => say('        ' + u));

    const pf = passportFrame(w);
    if (!pf) {
      say('\n!! 没有找到 passport iframe，无法继续');
      const img0 = await w.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, 'screenshot-autologin.png'), img0.toPNG());
      app.exit(1);
      return;
    }
    say('      ✓ 找到 passport frame');

    say('\n=== [3] 在 iframe 内填表 ===');
    const filled = await pf.executeJavaScript(FILL_JS(cred.username, cred.password), true);
    say('      ' + filled);
    await wait(800);

    say('\n=== [4] 提交 ===');
    const how = await pf.executeJavaScript(SUBMIT_JS, true);
    say('      ' + how);

    for (let i = 1; i <= 8; i++) {
      await wait(3000);
      say(`\n=== [5.${i}] 提交后 ${i * 3}s ===`);
      say('      主页面 url: ' + w.webContents.getURL());
      const pf2 = passportFrame(w);
      say('      passport frame: ' + (pf2 ? pf2.url.slice(0, 90) : '（已消失）'));
      await cookieSnap('t+' + i * 3 + 's');
    }

    try {
      const img = await w.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, 'screenshot-autologin.png'), img.toPNG());
      say('\n截图：screenshot-autologin.png');
    } catch (e) {
      say('\n（截图跳过：' + ((e && e.message) || e) + '）');
    }
  } catch (e) {
    say('异常：' + (e && e.stack ? e.stack : e));
  }

  try {
    w.destroy();
  } catch {}
  app.exit(0);
});
