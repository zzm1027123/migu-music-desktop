/**
 * 登录窗口验证：electron login-check.js
 * 打开登录窗口 → 自动点开登录框 → 截图并检查登录表单是否就绪。
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const USER_DATA = path.join(__dirname, '.userdata');
fs.mkdirSync(USER_DATA, { recursive: true });
app.setPath('userData', USER_DATA);

const LOGIN_URL = 'https://music.migu.cn/v5/#/musicLibrary';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = path.join(__dirname, 'login-check-output.txt');
fs.writeFileSync(LOG, '');
const say = (m) => {
  fs.appendFileSync(LOG, m + '\n');
  console.log(m);
};

const CLICK_JS = `(() => {
  try {
    const els = document.querySelectorAll('div,span,a,button');
    for (const el of els) {
      if (el.children.length) continue;
      if ((el.innerText || '').trim() === '登录' && el.offsetParent !== null) { el.click(); return 'clicked'; }
    }
    return 'no-login-entry';
  } catch (e) { return 'err:' + e.message; }
})()`;

app.whenReady().then(async () => {
  let failed = 0;
  const win = new BrowserWindow({
    width: 480,
    height: 700,
    show: true,
    title: '登录咪咕音乐',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  try {
    say('=== 登录窗口验证 ===\n');
    await win.loadURL(LOGIN_URL);
    await wait(3000);
    say('[1] 登录页加载：' + (win.webContents.getTitle() || '(无标题)'));

    const clicked = await win.webContents.executeJavaScript(CLICK_JS, true);
    say('[2] 自动点击登录入口：' + clicked);
    if (clicked !== 'clicked') failed++;

    await wait(5000);

    // 统计子框架（登录表单在 passport.migu.cn 的 iframe 中）
    const frames = [];
    const walk = (f) => {
      frames.push(f.url);
      (f.frames || []).forEach(walk);
    };
    walk(win.webContents.mainFrame);
    say('[3] 页面框架：\n      ' + frames.join('\n      '));

    const hasPassport = frames.some((u) => u.includes('passport.migu.cn'));
    if (hasPassport) say('[4] 通行证登录页已加载 ✓');
    else {
      say('[4] 未检测到 passport 登录页 ✗');
      failed++;
    }

    // 在登录 iframe 内查找输入框
    let formInfo = 'n/a';
    for (const f of win.webContents.mainFrame.frames) {
      if (!f.url.includes('passport.migu.cn')) continue;
      try {
        formInfo = await f.executeJavaScript(
          `(() => {
             const inputs = Array.from(document.querySelectorAll('input')).map(i => i.placeholder || i.type || i.name);
             const tabs = Array.from(document.querySelectorAll('li,div[class*="tab"]')).map(e => (e.innerText||'').trim()).filter(t => t && t.length < 12).slice(0, 6);
             return JSON.stringify({ inputs, tabs, title: document.title });
           })()`,
          true
        );
      } catch (e) {
        formInfo = 'err:' + e.message;
      }
      break;
    }
    say('[5] 登录表单元素：' + formInfo);
    if (formInfo.includes('手机号') || formInfo.includes('tel') || formInfo.includes('password')) say('      表单可用 ✓');
    else {
      say('      未识别到表单元素 ✗');
      failed++;
    }

    const png = path.join(__dirname, 'screenshot-login.png');
    const img = await win.webContents.capturePage();
    fs.writeFileSync(png, img.toPNG());
    say('[6] 截图：screenshot-login.png');
  } catch (e) {
    say('异常：' + (e && e.stack ? e.stack : e));
    failed++;
  }

  say('\n=== ' + (failed ? failed + ' 项失败' : '登录窗口验证通过') + ' ===');
  app.exit(failed ? 1 : 0);
});
