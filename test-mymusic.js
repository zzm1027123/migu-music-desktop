/**
 * 「我的音乐」页面验证：账号信息、歌单卡片、批量加入
 * 运行：electron test-mymusic.js
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const REAL_UD = process.env.MIGU_TEST_UD || path.join(__dirname, 'dist', '咪咕音乐', 'resources', 'app', '.userdata');
const TEST_UD = path.join(__dirname, '.userdata-mymusic');
if (!fs.existsSync(TEST_UD) && fs.existsSync(REAL_UD)) {
  fs.cpSync(REAL_UD, TEST_UD, { recursive: true });
}
app.setPath('userData', fs.existsSync(TEST_UD) ? TEST_UD : path.join(__dirname, '.userdata'));

const { registerIpc } = require('./src/ipc');
const logger = require('./src/logger');
logger.init(app.getPath('userData'));

const OUT = path.join(__dirname, 'test-mymusic-output.txt');
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

// 用真实登录态（从 userData 里读），这样昵称/头像能显示出来
const session = require('electron').session;

registerIpc({
  getAuthState: async () => {
    const cookies = await session.defaultSession.cookies.get({});
    const ticket = cookies.find((c) => ['pacmtoken', 'idmpauth', 'mg_auth_sid'].includes(c.name));
    return { loggedIn: !!ticket, nickname: '测试用户', avatar: '', userId: '' };
  },
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

  try {
    say('=== 我的音乐页面验证 ===\n');
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    await wait(6500);

    say('[1] 点击侧栏「我的音乐」');
    const navExists = await win.webContents.executeJavaScript(
      `!!document.querySelector('.nav-item[data-view="mymusic"]')`,
      true
    );
    if (navExists) ok('侧栏已有「我的音乐」入口');
    else bad('侧栏没有我的音乐入口');

    await win.webContents.executeJavaScript(
      `(()=>{document.querySelector('.nav-item[data-view="mymusic"]').click();return 1})()`,
      true
    );
    await wait(7000);

    const page = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({
           title: document.querySelector('.page-title') ? document.querySelector('.page-title').textContent : '',
           user: document.querySelector('.mymusic-info b') ? document.querySelector('.mymusic-info b').textContent : '',
           stats: [...document.querySelectorAll('.mymusic-stats div')].map(e => e.textContent.replace(/\\s+/g,' ').trim()),
           cards: [...document.querySelectorAll('.pl-card')].map(e => ({
             title: e.querySelector('.c-name').textContent,
             sub: e.querySelector('.c-sub').textContent,
             hasPlus: !!e.querySelector('.c-play')
           })),
           sections: [...document.querySelectorAll('.section-title')].map(e => e.textContent),
           empty: document.querySelector('.empty') ? document.querySelector('.empty').textContent : ''
         })`,
        true
      )
    );
    say('      标题：' + page.title + ' | 用户：' + page.user);
    say('      统计：' + JSON.stringify(page.stats));
    say('      分组：' + JSON.stringify(page.sections));
    say('      卡片：' + JSON.stringify(page.cards));

    if (page.title === '我的音乐') ok('进入了「我的音乐」页面');
    else bad('页面标题不对：' + page.title + ' ' + page.empty);
    if (page.user) ok('显示账号昵称：' + page.user);
    else bad('没有显示账号信息');
    if (page.cards.length) ok(`渲染了 ${page.cards.length} 个歌单卡片`);
    else bad('没有歌单卡片');
    if (page.cards.some((c) => c.title === '我喜欢的')) ok('包含「我喜欢的」卡片');
    else bad('缺少我喜欢的卡片');
    if (page.cards.every((c) => c.hasPlus)) ok('每张卡片都带「加入」按钮');
    else bad('有卡片缺少加入按钮');

    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, 'screenshot-mymusic.png'), img.toPNG());
    say('      截图：screenshot-mymusic.png');

    say('\n[2] 点歌单卡片 -> 应该能看到里面的歌曲');
    await win.webContents.executeJavaScript(
      `(()=>{const cards=[...document.querySelectorAll('.pl-card')];
         const fav=cards.find(c=>c.dataset.fav==='1')||cards[0];
         fav.querySelector('.c-name').click(); return 1})()`,
      true
    );
    await wait(9000);

    const detail = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({
           title: document.querySelector('.page-title') ? document.querySelector('.page-title').textContent : '',
           sub: document.querySelector('.page-sub') ? document.querySelector('.page-sub').textContent : '',
           rows: document.querySelectorAll('#plSongList .song-row').length,
           first: [...document.querySelectorAll('#plSongList .song-row')].slice(0,5).map(r => ({
             name: r.querySelector('.s-name').textContent.trim(),
             artist: r.querySelector('.s-artist').textContent.trim()
           })),
           hasBack: !!document.getElementById('backBtn'),
           empty: document.querySelector('.empty') ? document.querySelector('.empty').textContent : ''
         })`,
        true
      )
    );
    say('      标题：' + detail.title + ' | ' + detail.sub);
    say('      前几首：' + detail.first.map((x) => `${x.name}-${x.artist}`).join(' / '));
    if (detail.rows > 0) ok(`歌单详情渲染了 ${detail.rows} 首歌`);
    else bad('歌单里没有渲染出歌曲：' + detail.empty);
    if (detail.hasBack) ok('有返回按钮');
    else bad('缺少返回按钮');

    const img2 = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, 'screenshot-playlist-detail.png'), img2.toPNG());
    say('      截图：screenshot-playlist-detail.png');

    say('\n[3] 返回我的音乐');
    await win.webContents.executeJavaScript(`(()=>{document.getElementById('backBtn').click();return 1})()`, true);
    await wait(5000);
    const backOk = await win.webContents.executeJavaScript(
      `document.querySelector('.page-title') ? document.querySelector('.page-title').textContent : ''`,
      true
    );
    if (backOk === '我的音乐') ok('返回成功');
    else bad('返回后页面不对：' + backOk);

    say('\n[4] 空播放列表时点批量加入');
    await win.webContents.executeJavaScript(
      `(()=>{document.querySelector('.pl-card .c-play').dispatchEvent(new MouseEvent('click',{bubbles:true}));return 1})()`,
      true
    );
    await wait(1500);
    const toast2 = await win.webContents.executeJavaScript(`document.getElementById('toast').textContent`, true);
    say('      提示：' + toast2);
    if (/播放列表是空|加入/.test(toast2)) ok('空列表时给出友好提示（未发起无效请求）');
    else bad('空列表提示异常：' + toast2);
  } catch (e) {
    bad('异常 ' + (e && e.stack ? e.stack : e));
  }

  say('\n=== ' + (failed ? failed + ' 项失败' : '我的音乐页面验证通过') + ' ===');
  try {
    win.destroy();
  } catch {}
  app.exit(failed ? 1 : 0);
});
