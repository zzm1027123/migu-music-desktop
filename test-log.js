/**
 * 日志功能验证：日志文件生成/写入、设置面板的「打开日志文件」按钮、真实调用 shell.openPath
 * 运行：electron test-log.js
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

// 独立的干净 userData，避免污染真实数据
const TEST_UD = path.join(__dirname, '.userdata-logtest');
fs.rmSync(TEST_UD, { recursive: true, force: true });
fs.mkdirSync(TEST_UD, { recursive: true });
app.setPath('userData', TEST_UD);

const logger = require('./src/logger');
const { registerIpc } = require('./src/ipc');

const OUT = path.join(__dirname, 'test-log-output.txt');
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

logger.init(TEST_UD);
logger.info('[测试] 这是一条测试日志');
logger.warn('[测试] 这是一条警告');
logger.error('[测试] 这是一条错误');
logger.playResolve(
  { name: '测试歌曲', artists: ['某人'] },
  { url: 'https://freetyst.nf.migu.cn/public/x/y.mp3?Key=secret&msisdn=123', tone: 'PQ', via: 'web-sdk' }
);

registerIpc({
  getAuthState: () => ({ loggedIn: false, nickname: '', avatar: '', userId: '' }),
  login: async () => ({ ok: true }),
  logout: async () => ({ ok: true }),
  confirmLogin: async () => ({ ok: true }),
  getSettings: () => ({}),
  setSettings: (p) => p,
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true,
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  try {
    say('=== 日志功能验证 ===\n');

    const logFile = logger.getFile();
    say('[1] 日志文件');
    say('      ' + logFile);
    if (logFile && fs.existsSync(logFile)) ok('日志文件已生成');
    else bad('日志文件不存在');

    const c0 = fs.readFileSync(logFile, 'utf8');
    if (c0.includes('这是一条测试日志') && c0.includes('这是一条警告') && c0.includes('这是一条错误'))
      ok('多级别日志可正常写入');
    else bad('日志内容不完整');

    if (c0.includes('freetyst.nf.migu.cn') && !c0.includes('Key=secret')) ok('URL 已脱敏（不带 Key/msisdn 参数）');
    else bad('日志里出现了未脱敏的音频 URL');

    // 打开界面 → 设置面板
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    await wait(5000);
    await win.webContents.executeJavaScript(`(()=>{document.getElementById('settingsBtn').click();return 1})()`, true);
    await wait(1300);

    say('\n[2] 设置面板');
    const panel = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({
           open: document.getElementById('settingsMask').classList.contains('show'),
           hasOpen: !!document.getElementById('openLogBtn'),
           hasDir: !!document.getElementById('openLogDirBtn'),
           label: (document.getElementById('logPathText') || {}).textContent || ''
         })`,
        true
      )
    );
    say('      ' + JSON.stringify(panel));
    if (panel.open && panel.hasOpen) ok('设置面板中已有「打开日志文件」按钮');
    else bad('「打开日志文件」按钮不存在');
    if (panel.label.includes('.log')) ok('面板显示当前日志文件名：' + panel.label);
    else say('      · 未显示文件名（' + panel.label + '）');

    say('\n[3] 点击按钮（真实调用 shell.openPath）');
    const r = await win.webContents.executeJavaScript(`window.migu.openLog()`, true);
    say('      -> ' + JSON.stringify(r));
    if (r && r.ok) ok('打开日志文件调用成功');
    else bad('打开日志失败：' + JSON.stringify(r));

    await wait(1500);
    const c1 = fs.readFileSync(logFile, 'utf8');
    if (c1.includes('已用系统默认程序打开日志文件')) ok('打开动作已记入日志');
    else bad('日志里没有打开记录');

    // 确保设置面板处于打开状态再截图
    await win.webContents.executeJavaScript(
      `(()=>{const m=document.getElementById('settingsMask');
         if(!m.classList.contains('show')) document.getElementById('settingsBtn').click();
         return 1})()`,
      true
    );
    await wait(900);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, 'screenshot-log-setting.png'), img.toPNG());
    say('      截图：screenshot-log-setting.png');
  } catch (e) {
    bad('异常 ' + (e && e.stack ? e.stack : e));
  }

  say('\n=== ' + (failed ? failed + ' 项失败' : '日志功能验证通过') + ' ===');
  try {
    win.destroy();
  } catch {}
  app.exit(failed ? 1 : 0);
});
