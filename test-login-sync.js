/**
 * 「登录刚完成、服务端会话还没生效」的处理验证
 *
 * 现象（来自真实日志）：
 *   09:17:55.628  登录成功
 *   09:17:55.780  [歌单] 未登录或登录已过期    ← 0.15 秒后就报失效
 *   09:18:09.575  [歌单] 读取到自建歌单 ...     ← 14 秒后自愈
 *
 * 期望：这种「刚登录不久」的扑空不要直接甩「登录已失效」给用户，
 *       而是显示正在同步并自动重试；真正登录过期时才给重新登录入口。
 *
 * 运行：electron test-login-sync.js
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');

const REAL_UD = process.env.MIGU_TEST_UD || path.join(__dirname, 'dist', '咪咕音乐', 'resources', 'app', '.userdata');
const TEST_UD = path.join(__dirname, '.userdata-sync');
if (!fs.existsSync(TEST_UD) && fs.existsSync(REAL_UD)) fs.cpSync(REAL_UD, TEST_UD, { recursive: true });
app.setPath('userData', fs.existsSync(TEST_UD) ? TEST_UD : path.join(__dirname, '.userdata'));

const { registerIpc } = require('./src/ipc');
const logger = require('./src/logger');
logger.init(app.getPath('userData'));

const OUT = path.join(__dirname, 'test-sync-output.txt');
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

// 可变的登录态：测试中途会改 since 来模拟「早就登录了」和「刚刚登录」
const auth = { loggedIn: true, nickname: '测试用户', avatar: '', userId: '', since: Date.now() };

registerIpc({
  getAuthState: () => ({ ...auth }),
  login: async () => ({ ok: true }),
  logout: async () => ({ ok: true }),
  confirmLogin: async () => ({ ok: true }),
  getSettings: () => ({}),
  setSettings: (p) => p,
});

// 接管 playlist:mine，让它前几次故意失败，模拟服务端会话尚未生效
const STATS = { calls: 0, failFirst: 0, alwaysFail: false };
ipcMain.removeHandler('playlist:mine');
ipcMain.handle('playlist:mine', async () => {
  STATS.calls += 1;
  if (STATS.alwaysFail || STATS.calls <= STATS.failFirst) {
    return { ok: false, needLogin: true, error: '登录状态已失效，请重新登录' };
  }
  return {
    ok: true,
    created: [{ id: '236419999', title: '测试歌单', count: 3, cover: '', owner: '' }],
    collected: [],
    favoriteCount: 243,
    favoriteId: '231413439',
  };
});

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

  /** 「我的音乐」页当前显示成什么样 */
  const pageState = () =>
    js(`(()=>{
      const t = document.querySelector('.page-title');
      const loading = document.querySelector('.loading');
      const empty = document.querySelector('.empty');
      return JSON.stringify({
        title: t ? t.textContent : '',
        loading: loading ? loading.textContent.replace(/\\s+/g,' ').trim() : '',
        empty: empty ? empty.textContent : '',
        hasRelogin: !!document.getElementById('mmLogin'),
        cards: document.querySelectorAll('.pl-card').length
      })})()`);

  try {
    say('=== 登录会话同步验证 ===\n');
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    await wait(6500);

    say('[1] 刚登录完就拉歌单（服务端还没生效）不该直接报失效');
    auth.since = Date.now();
    STATS.calls = 0;
    STATS.failFirst = 2; // 前两次扑空，第三次才成功
    STATS.alwaysFail = false;

    await js(`document.querySelector('.nav-item[data-view="mymusic"]').click()`);
    await wait(1500);
    const midway = JSON.parse(await pageState());
    say('      中途：' + JSON.stringify(midway));
    if (/正在同步/.test(midway.loading)) ok('先显示「正在同步你的歌单…」而不是报错');
    else bad('没有进入同步提示，看到的是：' + (midway.loading || midway.empty || midway.title));
    if (!midway.hasRelogin) ok('没有立刻甩出「重新登录」按钮');
    else bad('一上来就给了重新登录入口');

    say('\n[2] 等重试跑完，应当自动恢复');
    await wait(7000);
    const settled = JSON.parse(await pageState());
    say('      ' + JSON.stringify(settled));
    if (settled.cards > 0) ok(`重试后歌单正常出来了（${settled.cards} 张卡片）`);
    else bad('重试完仍然没有歌单：' + JSON.stringify(settled));
    if (/我喜欢的/.test(settled.title) || settled.cards >= 2) ok('显示的是正常的「我的音乐」页面');
    else bad('页面状态不对：' + settled.title);
    if (STATS.calls >= 3) ok(`一共请求了 ${STATS.calls} 次（前两次扑空后成功）`);
    else bad(`只请求了 ${STATS.calls} 次，重试没跑起来`);

    say('\n[3] 真正登录过期时，还是要明确报失效 + 给重新登录入口');
    auth.since = Date.now() - 3 * 3600 * 1000; // 3 小时前登录的，早过了同步窗口
    STATS.calls = 0;
    STATS.failFirst = 0;
    STATS.alwaysFail = true;

    await js(`document.querySelector('.nav-item[data-view="home"]').click()`);
    await wait(2500);
    await js(`document.querySelector('.nav-item[data-view="mymusic"]').click()`);
    await wait(2500);
    const expired = JSON.parse(await pageState());
    say('      ' + JSON.stringify(expired));
    if (/登录状态已失效/.test(expired.empty)) ok('明确提示登录已失效：' + expired.empty);
    else bad('提示不对：' + (expired.empty || expired.loading));
    if (expired.hasRelogin) ok('给出了「重新登录」按钮');
    else bad('缺少重新登录入口');
    if (STATS.calls === 1) ok('没有无谓重试，一次就给出结论');
    else bad(`不该重试却请求了 ${STATS.calls} 次`);

    say('\n[4] 重试期间离开页面应当停下，别在后台一直打接口');
    auth.since = Date.now();
    STATS.calls = 0;
    STATS.failFirst = 99; // 一直失败
    STATS.alwaysFail = false;
    await js(`document.querySelector('.nav-item[data-view="mymusic"]').click()`);
    await wait(1200);
    await js(`document.querySelector('.nav-item[data-view="home"]').click()`); // 立刻切走
    await wait(1500);
    const callsAtLeave = STATS.calls;
    await wait(5000);
    say(`      切走后请求次数：${callsAtLeave} → ${STATS.calls}`);
    if (STATS.calls <= callsAtLeave) ok('离开页面后不再继续重试');
    else bad(`离开页面后仍重试了 ${STATS.calls - callsAtLeave} 次`);
  } catch (e) {
    bad('异常 ' + (e && e.stack ? e.stack : e));
  }

  say('\n=== ' + (failed ? failed + ' 项失败' : '登录会话同步验证通过') + ' ===');
  try {
    win.destroy();
  } catch {}
  app.exit(failed ? 1 : 0);
});
