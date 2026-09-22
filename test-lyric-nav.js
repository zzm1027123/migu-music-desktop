/**
 * 「切导航时自动收起歌词界面」验证
 *
 * 歌词抽屉是独立于视图的浮层（position:fixed，从侧栏右边铺到窗口右边），
 * 换页面时如果不关，它会一直盖在新页面上。
 *
 * 运行：electron test-lyric-nav.js
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const REAL_UD = process.env.MIGU_TEST_UD || path.join(__dirname, 'dist', '咪咕音乐', 'resources', 'app', '.userdata');
const TEST_UD = path.join(__dirname, '.userdata-lyricnav');
if (!fs.existsSync(TEST_UD) && fs.existsSync(REAL_UD)) fs.cpSync(REAL_UD, TEST_UD, { recursive: true });
app.setPath('userData', fs.existsSync(TEST_UD) ? TEST_UD : path.join(__dirname, '.userdata'));

const { registerIpc } = require('./src/ipc');
const logger = require('./src/logger');
logger.init(app.getPath('userData'));

const OUT = path.join(__dirname, 'test-lyric-nav-output.txt');
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
  getSettings: () => ({}),
  setSettings: (p) => p,
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

  /** 抽屉当前是否打开 */
  const drawerOpen = () => js(`document.getElementById('lyricDrawer').classList.contains('open')`);
  /** 歌词按钮是否高亮 */
  const btnActive = () => js(`document.getElementById('lyricBtn').classList.contains('active')`);
  const openDrawer = async () => {
    await js(`(()=>{const d=document.getElementById('lyricDrawer');
      if(!d.classList.contains('open')) document.getElementById('lyricBtn').click(); return 1})()`);
    await wait(500);
  };

  try {
    say('=== 切导航自动收起歌词界面 ===\n');
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    await wait(6500);

    say('[1] 歌词抽屉能正常打开（前置条件）');
    await openDrawer();
    if (await drawerOpen()) ok('点了歌词按钮，抽屉打开了');
    else bad('抽屉没能打开，后续无从验证');
    if (await btnActive()) ok('歌词按钮同步高亮');
    else bad('歌词按钮没有高亮');

    const navs = [
      ['home', '发现音乐'],
      ['ranks', '排行榜'],
      ['mymusic', '我的音乐'],
    ];

    for (const [view, label] of navs) {
      say(`\n[2] 打开歌词 → 点「${label}」`);
      await openDrawer();
      if (!(await drawerOpen())) {
        bad('前置失败：抽屉没打开');
        continue;
      }
      await js(`document.querySelector('.nav-item[data-view="${view}"]').click()`);
      await wait(3500);

      const stillOpen = await drawerOpen();
      const active = await btnActive();
      if (!stillOpen) ok(`点「${label}」后抽屉自动收起了`);
      else bad(`点「${label}」后歌词界面还盖着`);

      if (!active) ok('歌词按钮的高亮也一起清了');
      else bad('按钮还亮着，状态不同步');

      const curView = await js(`document.querySelector('.nav-item.active') ? document.querySelector('.nav-item.active').dataset.view : ''`);
      if (curView === view) ok(`视图确实切到了「${label}」`);
      else bad(`视图没切过去，当前高亮的是 ${curView}`);
    }

    say('\n[3] 「搜索结果」：没关键词时不该误关歌词');
    await js(`(()=>{document.getElementById('searchInput').value='';return 1})()`);
    await openDrawer();
    await js(`document.querySelector('.nav-item[data-view="search"]').click()`);
    await wait(1200);
    const toastText = await js(`document.getElementById('toast').textContent`);
    if (/输入关键词/.test(toastText)) ok('给了提示：' + toastText);
    else bad('没提示要输入关键词');
    if (await drawerOpen()) ok('因为并没有换页面，歌词保持打开（没有误关）');
    else bad('没换页面却把歌词关了');

    say('\n[4] 「搜索结果」：有关键词时应当收起');
    await js(`(()=>{document.getElementById('searchInput').value='周杰伦';return 1})()`);
    await openDrawer();
    await js(`document.querySelector('.nav-item[data-view="search"]').click()`);
    await wait(6000);
    if (!(await drawerOpen())) ok('点「搜索结果」后抽屉收起了');
    else bad('搜索时歌词界面还盖着');
    const rows = await js(`document.querySelectorAll('#searchList .song-row').length`);
    if (rows > 0) ok(`搜索结果正常渲染了 ${rows} 行`);
    else bad('搜索结果没出来');
  } catch (e) {
    bad('异常 ' + (e && e.stack ? e.stack : e));
  }

  say('\n=== ' + (failed ? failed + ' 项失败' : '切导航收起歌词验证通过') + ' ===');
  try {
    win.destroy();
  } catch {}
  app.exit(failed ? 1 : 0);
});
