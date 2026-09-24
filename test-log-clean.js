/**
 * 日志清理验证：按保留天数删除旧日志、不误删当前日志、设置面板的清理控件
 * 运行：electron test-log-clean.js
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const TEST_UD = path.join(__dirname, '.userdata-logclean');
fs.rmSync(TEST_UD, { recursive: true, force: true });
fs.mkdirSync(TEST_UD, { recursive: true });
app.setPath('userData', TEST_UD);

const logger = require('./src/logger');
const { registerIpc } = require('./src/ipc');

const OUT = path.join(__dirname, 'test-log-clean-output.txt');
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

/** 造一个「N 天前」的假日志 */
function makeFakeLog(daysAgo, name) {
  const p = path.join(logger.getDir(), name);
  fs.writeFileSync(p, 'x'.repeat(2048));
  const t = (Date.now() - daysAgo * 86400000) / 1000;
  fs.utimesSync(p, t, t);
  return p;
}

logger.init(TEST_UD);

registerIpc({
  getAuthState: () => ({ loggedIn: false, nickname: '', avatar: '', userId: '' }),
  login: async () => ({ ok: true }),
  logout: async () => ({ ok: true }),
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
    say('=== 日志清理验证 ===\n');

    // 3 个假日志：2 天前 / 10 天前 / 40 天前（外加当前正在写的这个）
    makeFakeLog(2, 'migu-20260101-000001.log');
    makeFakeLog(10, 'migu-20260101-000002.log');
    makeFakeLog(40, 'migu-20260101-000003.log');
    const currentFile = logger.getFile();

    say('[1] 清理前');
    let st = logger.stats();
    say(`      共 ${st.count} 个文件，${(st.bytes / 1024).toFixed(1)}KB`);
    if (st.count === 4) ok('统计到 4 个日志文件（3 个假 + 1 个当前）');
    else bad('统计数量不对：' + st.count);

    say('\n[2] 清理 7 天前');
    let r = logger.cleanOlderThan(7);
    say(`      删除 ${r.removed} 个，释放 ${(r.freed / 1024).toFixed(1)}KB`);
    if (r.removed === 2) ok('删掉了 10 天前和 40 天前两个文件');
    else bad('应删 2 个，实际 ' + r.removed);
    st = logger.stats();
    if (st.count === 2) ok('剩余 2 个文件（2 天前的 + 当前）');
    else bad('剩余数量不对：' + st.count);
    if (fs.existsSync(currentFile)) ok('当前正在写的日志没有被删掉');
    else bad('当前日志被误删了！');

    say('\n[3] 清理 30 天前');
    makeFakeLog(40, 'migu-20260101-000004.log');
    r = logger.cleanOlderThan(30);
    say(`      删除 ${r.removed} 个，释放 ${(r.freed / 1024).toFixed(1)}KB`);
    if (r.removed === 1) ok('只删掉了 40 天前那一个');
    else bad('应删 1 个，实际 ' + r.removed);
    if (fs.existsSync(path.join(logger.getDir(), 'migu-20260101-000001.log')))
      ok('2 天前的日志仍在（30 天保留期内）');
    else bad('2 天前的日志被误删');

    say('\n[4] 传 0 表示不清理');
    r = logger.cleanOlderThan(0);
    if (r.removed === 0) ok('保留期设为 0 时不做任何删除');
    else bad('不应删除任何文件');

    // ---- UI ----
    say('\n[5] 设置面板控件');
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    await wait(5000);
    await win.webContents.executeJavaScript(`(()=>{document.getElementById('settingsBtn').click();return 1})()`, true);
    await wait(1500);

    const ui = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({
           hasSelect: !!document.getElementById('logRetention'),
           hasBtn: !!document.getElementById('cleanLogBtn'),
           retention: (document.getElementById('logRetention') || {}).value,
           stats: (document.getElementById('logStatsText') || {}).textContent || ''
         })`,
        true
      )
    );
    say('      ' + JSON.stringify(ui));
    if (ui.hasSelect && ui.hasBtn) ok('设置里有「保留期」下拉和「立即清理」按钮');
    else bad('清理控件缺失');
    if (ui.stats.includes('个文件')) ok('显示日志占用：' + ui.stats);
    else bad('未显示占用统计：' + ui.stats);

    // 造一批 40 天前的日志，然后用界面按钮清理
    for (let i = 0; i < 3; i++) makeFakeLog(40, `migu-20251201-00001${i}.log`);
    const beforeCount = logger.stats().count;

    await win.webContents.executeJavaScript(
      `(()=>{const s=document.getElementById('logRetention');s.value='30';s.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`,
      true
    );
    await wait(600);
    const cleaned = await win.webContents.executeJavaScript(`window.migu.logClean(30)`, true);
    await wait(600);
    const afterCount = logger.stats().count;
    say(`      点击前 ${beforeCount} 个 -> 清理返回 ${JSON.stringify(cleaned)} -> 点击后 ${afterCount} 个`);
    if (afterCount === beforeCount - 3) ok('界面按钮按 30 天保留期清掉了 3 个旧日志');
    else bad(`清理结果不符：${beforeCount} -> ${afterCount}`);

    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, 'screenshot-log-clean.png'), img.toPNG());
    say('      截图：screenshot-log-clean.png');
  } catch (e) {
    bad('异常 ' + (e && e.stack ? e.stack : e));
  }

  say('\n=== ' + (failed ? failed + ' 项失败' : '日志清理验证通过') + ' ===');
  try {
    win.destroy();
  } catch {}
  app.exit(failed ? 1 : 0);
});
