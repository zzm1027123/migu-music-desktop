/**
 * 浅色模式验证
 *
 * 覆盖：设置里的切换按钮、切换后实际生效（不只是挂个属性）、持久化、
 * 重新加载后仍记得、切回深色不残留，以及深色模式的原有外观没有被破坏。
 *
 * 运行：electron test-theme.js
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const REAL_UD = process.env.MIGU_TEST_UD || path.join(__dirname, 'dist', '咪咕音乐', 'resources', 'app', '.userdata');
const TEST_UD = path.join(__dirname, '.userdata-theme');
if (!fs.existsSync(TEST_UD) && fs.existsSync(REAL_UD)) fs.cpSync(REAL_UD, TEST_UD, { recursive: true });
app.setPath('userData', fs.existsSync(TEST_UD) ? TEST_UD : path.join(__dirname, '.userdata'));

const { registerIpc } = require('./src/ipc');
const settings = require('./src/settings');
const logger = require('./src/logger');
logger.init(app.getPath('userData'));

const OUT = path.join(__dirname, 'test-theme-output.txt');
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

registerIpc({
  getAuthState: () => ({ loggedIn: true, nickname: '测试用户', avatar: '', userId: '' }),
  login: async () => ({ ok: true }),
  logout: async () => ({ ok: true }),
  confirmLogin: async () => ({ ok: true }),
  getSettings: () => settings.all(),
  setSettings: (p) => settings.set(p),
});

// 深色下的基准色（就是重构前的原值）
const DARK = { bg: 'rgb(14, 16, 22)', text: 'rgb(232, 235, 245)' };
const LIGHT = { bg: 'rgb(244, 245, 249)', text: 'rgb(27, 31, 46)' };

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true,
    width: 1220,
    height: 820,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const js = (code) => win.webContents.executeJavaScript(code, true);

  /** 抓一组能反映主题是否真的生效的计算样式 */
  const snapshot = () =>
    js(`(()=>{
      const b = getComputedStyle(document.body);
      const bar = (sel) => { const el = document.querySelector(sel);
        return el ? (getComputedStyle(el).backgroundImage + '|' + getComputedStyle(el).backgroundColor) : 'n/a' };
      return JSON.stringify({
        theme: document.documentElement.dataset.theme || '(未设置)',
        bg: b.backgroundColor,
        text: b.color,
        topbar: bar('.topbar'),
        sidebar: bar('.sidebar'),
        player: bar('.player'),
        lineVar: getComputedStyle(document.documentElement).getPropertyValue('--line').trim(),
        stored: (()=>{ try { return localStorage.getItem('migu-theme') } catch(e){ return 'n/a' } })()
      })})()`);

  try {
    say('=== 浅色模式验证 ===\n');

    say('[1] 首次启动应为深色（保持原有外观）');
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    await wait(6500);
    const dark = JSON.parse(await snapshot());
    say('      ' + JSON.stringify(dark));
    if (dark.theme === '(未设置)') ok('HTML 上没有 data-theme，走 :root 默认（深色）');
    else bad('默认竟然带了 data-theme=' + dark.theme);
    if (dark.bg === DARK.bg) ok(`背景 ${dark.bg} 与重构前一致（深色没有回归）`);
    else bad(`背景变成了 ${dark.bg}，期望 ${DARK.bg}`);
    if (dark.text === DARK.text) ok(`文字色 ${dark.text} 与重构前一致`);
    else bad(`文字色变成了 ${dark.text}`);

    say('\n[2] 设置面板里应该有「界面主题」');
    await js(`document.getElementById('settingsBtn').click()`);
    await wait(1500);
    const panel = JSON.parse(
      await js(`(()=>{const s=document.getElementById('setTheme');
         return JSON.stringify({
           open: document.getElementById('settingsMask').classList.contains('show'),
           hasSelect: !!s,
           options: s ? [...s.options].map(o=>o.value+':'+o.textContent) : [],
           value: s ? s.value : ''
         })})()`)
    );
    say('      ' + JSON.stringify(panel));
    if (panel.open) ok('设置面板打开了');
    else bad('设置面板没打开');
    if (panel.hasSelect) ok('有主题下拉：' + panel.options.join(' / '));
    else bad('设置里没有主题切换控件');
    if (panel.value === 'dark') ok('当前显示「深色」');
    else bad('下拉当前值是 ' + panel.value);

    say('\n[3] 切到浅色');
    await js(`(()=>{const s=document.getElementById('setTheme'); s.value='light';
       s.dispatchEvent(new Event('change',{bubbles:true})); return 1})()`);
    await wait(1800);
    const light = JSON.parse(await snapshot());
    say('      ' + JSON.stringify(light));
    if (light.theme === 'light') ok('HTML 挂上了 data-theme="light"');
    else bad('data-theme 没生效：' + light.theme);
    if (light.bg === LIGHT.bg) ok(`背景真的变浅了：${light.bg}`);
    else bad(`背景没变，仍是 ${light.bg}`);
    if (light.text === LIGHT.text) ok(`文字变成深色：${light.text}`);
    else bad(`文字色没变：${light.text}`);
    if (light.topbar !== dark.topbar) ok('顶栏底色跟着换了');
    else bad('顶栏还是深色渐变，没跟着主题走');
    if (light.sidebar !== dark.sidebar) ok('侧栏底色跟着换了');
    else bad('侧栏没跟着主题走');
    if (light.player !== dark.player) ok('底部播放条底色跟着换了');
    else bad('播放条没跟着主题走');
    if (light.lineVar !== dark.lineVar) ok(`描边色也跟着换了（--line: ${dark.lineVar} → ${light.lineVar}）`);
    else bad('--line 没随主题变化');

    say('\n[4] 检查浅色下是否有"看不见"的地方');
    const contrast = JSON.parse(
      await js(`(()=>{
        const pick = (sel, prop) => { const el=document.querySelector(sel);
          return el ? getComputedStyle(el)[prop] : null };
        return JSON.stringify({
          navColor: pick('.nav-item','color'),
          navBg: pick('.nav-item','backgroundColor'),
          titleColor: pick('.page-title','color'),
          emptyColor: pick('.empty','color'),
          songName: pick('.s-name','color')
        })})()`)
    );
    say('      ' + JSON.stringify(contrast));
    // 浅色主题下，正文类文字不该是浅色（那样就等于看不见）
    const isLightColor = (c) => {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c || '');
      if (!m) return null;
      const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
      return (r * 299 + g * 587 + b * 114) / 1000 > 170; // 亮度高 = 浅色
    };
    const lightish = Object.entries(contrast).filter(
      ([k, v]) => !k.endsWith('Bg') && v && isLightColor(v)
    );
    if (!lightish.length) ok('可见文字都不是浅色，浅底上看得见');
    else bad('这些文字在浅色底上可能看不清：' + JSON.stringify(lightish));

    // 顺手把浅色界面截下来
    try {
      await js(`document.getElementById('settingsClose').click()`);
      await wait(600);
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      await wait(800);
      fs.writeFileSync(path.join(__dirname, 'screenshot-light.png'), (await win.webContents.capturePage()).toPNG());
      say('      截图：screenshot-light.png');
      await js(`document.getElementById('settingsBtn').click()`);
      await wait(1200);
      fs.writeFileSync(path.join(__dirname, 'screenshot-light-settings.png'), (await win.webContents.capturePage()).toPNG());
      say('      截图：screenshot-light-settings.png');
      await js(`document.getElementById('settingsClose').click()`);
      await wait(500);
    } catch (e) {
      say('      （截图跳过：' + ((e && e.message) || e) + '）');
    }

    say('\n[5] 设置要落盘（下次启动还记得）');
    if (light.stored === 'light') ok('localStorage 里存了 migu-theme=light（供启动时提前应用）');
    else bad('localStorage 没存：' + light.stored);
    const saved = settings.all();
    if (saved.theme === 'light') ok('settings.json 里 theme=light');
    else bad('设置没落盘，theme=' + saved.theme);

    say('\n[6] 重新加载页面（模拟下次启动）应仍是浅色');
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    await wait(6500);
    const reloaded = JSON.parse(await snapshot());
    say('      ' + JSON.stringify(reloaded));
    if (reloaded.theme === 'light' && reloaded.bg === LIGHT.bg) ok('重载后仍是浅色');
    else bad('重载后主题丢了：' + reloaded.theme + ' ' + reloaded.bg);

    say('\n[7] 切回深色不该有残留');
    await js(`document.getElementById('settingsBtn').click()`);
    await wait(1500);
    await js(`(()=>{const s=document.getElementById('setTheme'); s.value='dark';
       s.dispatchEvent(new Event('change',{bubbles:true})); return 1})()`);
    await wait(1800);
    const back = JSON.parse(await snapshot());
    say('      ' + JSON.stringify(back));
    if (back.theme === '(未设置)') ok('data-theme 被移除，回到 :root 默认');
    else bad('data-theme 残留：' + back.theme);
    if (back.bg === DARK.bg && back.text === DARK.text) ok('深色完全恢复，与最初一致');
    else bad(`深色没有完全恢复：${back.bg} / ${back.text}`);
    if (back.lineVar === dark.lineVar) ok('--line 也回到深色值');
    else bad('--line 没恢复');

    try {
      await js(`document.getElementById('settingsClose').click()`);
      await wait(600);
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      await wait(900);
      fs.writeFileSync(path.join(__dirname, 'screenshot-dark-check.png'), (await win.webContents.capturePage()).toPNG());
      say('      截图：screenshot-dark-check.png（确认深色外观没被这次重构改坏）');
    } catch (e) {
      say('      （截图跳过：' + ((e && e.message) || e) + '）');
    }
  } catch (e) {
    bad('异常 ' + (e && e.stack ? e.stack : e));
  }

  say('\n=== ' + (failed ? failed + ' 项失败' : '浅色模式验证通过') + ' ===');
  try {
    win.destroy();
  } catch {}
  app.exit(failed ? 1 : 0);
});
