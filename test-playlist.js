/**
 * 歌单功能验证：读取我的歌单、加入歌单接口、弹窗渲染
 * 注意：为不改动用户的歌单数据，添加测试刻意选用「已经在我喜欢里」的歌曲，接口幂等返回「重复」。
 * 运行：electron test-playlist.js
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const { prepareUserData } = require('./test-util');
app.setPath('userData', prepareUserData('.userdata-playlist'));

const { registerIpc } = require('./src/ipc');
const logger = require('./src/logger');
logger.init(app.getPath('userData'));

const OUT = path.join(__dirname, 'test-playlist-output.txt');
fs.writeFileSync(OUT, '');
const say = (m = '') => {
  fs.appendFileSync(OUT, m + '\n');
  console.log(m);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
let skipped = 0;
const ok = (m) => say('  [PASS] ' + m);
const bad = (m) => {
  failed++;
  say('  [FAIL] ' + m);
};
const skip = (m) => {
  skipped++;
  say('  [SKIP] ' + m);
};

registerIpc({
  getAuthState: () => ({ loggedIn: true, nickname: '', avatar: '', userId: '' }),
  login: async () => ({ ok: true }),
  logout: async () => ({ ok: true }),
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
    say('=== 歌单功能验证 ===\n');

    const playlist = require('./src/playlist');
    const api = require('./src/migu-api');

    say('[1] 读取我的歌单');
    const mine = await playlist.getMyPlaylists();
    let loggedIn = true;
    if (mine.needLogin) {
      loggedIn = false;
      skip('当前未登录（或登录已过期）—— 歌单功能必须登录后才能验证');
      say('      接口已把服务端的「参数校验失败」翻译成 needLogin，界面会显示「重新登录」引导');
    } else if (!mine.ok) {
      bad('读取失败：' + mine.error);
    } else {
      ok(`我喜欢的 ${mine.favoriteCount} 首；自建歌单 ${mine.created.length} 个；收藏歌单 ${mine.collected.length} 个`);
      for (const p of mine.created.slice(0, 8)) say(`      · ${p.title}（${p.count} 首）id=${p.id}`);
      if (mine.created.length || mine.favoriteCount) ok('确实抓到了你的歌单数据');
      else bad('没有拿到任何歌单');
    }

    // 找一首已经在我喜欢里的歌，用它做幂等添加测试
    say('\n[2] 查找一首已在「我喜欢」里的歌（用于幂等测试）');
    const s = await api.search('周杰伦', 1, 30);
    const ids = (s.songs || []).map((x) => x.contentId).filter(Boolean);
    const chk = await playlist.checkInPlaylists(ids);
    const favIds = Object.keys(chk.favMap || {}).filter((k) => chk.favMap[k]);
    say(`      检查 ${ids.length} 首，其中 ${favIds.length} 首已在我喜欢里`);
    if (favIds.length) ok('已定位到可做幂等测试的歌曲');
    else say('      · 这批歌都不在「我喜欢」里，将跳过写接口测试');

    if (favIds.length) {
      say('\n[3] 加入歌单接口（幂等：加入到「我喜欢」）');
      const r = await playlist.addSongs('', [favIds[0]]);
      say('      ' + JSON.stringify(r));
      if (r.ok) ok(`接口调用成功（成功 ${r.successNum}，重复 ${r.repeated}）— 数据未变更`);
      else bad('添加接口失败：' + r.error);
    }

    say('\n[4] 界面弹窗');
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    await wait(6000);
    await win.webContents.executeJavaScript(
      `(()=>{const i=document.getElementById('searchInput'); i.value='周杰伦';
         document.getElementById('searchBtn').click(); return 1})()`,
      true
    );
    await wait(6000);

    const hasBtn = await win.webContents.executeJavaScript(
      `document.querySelectorAll('#searchList .song-row .add-pl').length`,
      true
    );
    if (hasBtn > 0) ok(`歌曲行上出现了「加入歌单」按钮（${hasBtn} 个）`);
    else bad('歌曲行没有加入歌单按钮');

    await win.webContents.executeJavaScript(
      `(()=>{document.querySelector('#searchList .song-row .add-pl').click(); return 1})()`,
      true
    );
    await wait(4000);

    const panel = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({
           open: document.getElementById('playlistMask').classList.contains('show'),
           song: (document.getElementById('plSong')||{}).textContent || '',
           items: [...document.querySelectorAll('#plList .pl-item')].map(e => ({
             title: e.querySelector('b').textContent,
             sub: e.querySelector('span') ? e.querySelector('span').textContent : ''
           }))
         })`,
        true
      )
    );
    say('      ' + JSON.stringify(panel));
    if (panel.open) ok('点按钮后弹出歌单选择框');
    else bad('弹窗没有出现');
    if (panel.items.length) ok(`弹窗里列出了 ${panel.items.length} 个歌单：${panel.items.map((x) => x.title).join(' / ')}`);
    else if (!loggedIn) skip('未登录时弹窗不列歌单是预期行为（面板里已提示需重新登录）');
    else bad('弹窗里没有歌单');

    say('\n[5] 未登录时「我的音乐」页的引导');
    await win.webContents.executeJavaScript(
      `(()=>{document.querySelector('.nav-item[data-view="mymusic"]').click();return 1})()`,
      true
    );
    await wait(6000);
    const mm = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({
           empty: document.querySelector('.empty') ? document.querySelector('.empty').textContent : '',
           relogin: document.getElementById('mmLogin') ? document.getElementById('mmLogin').textContent : ''
         })`,
        true
      )
    );
    say('      ' + JSON.stringify(mm));
    if (mm.relogin) {
      ok(`未登录/失效时给出「${mm.relogin}」按钮，提示语：${mm.empty}`);
      if (/参数校验|299999/.test(mm.empty)) bad('又把服务端的晦涩报错直接显示出来了');
    } else if (!loggedIn) {
      bad('未登录时缺少重新登录入口：' + mm.empty);
    }

    // 截图只是留证：某些桌面状态下会拿不到画面（Current display surface not
    // available for capture），不该因此把功能判定成失败
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, 'screenshot-playlist.png'), img.toPNG());
      say('      截图：screenshot-playlist.png');
    } catch (e) {
      say('      （截图跳过：' + ((e && e.message) || e) + '）');
    }
  } catch (e) {
    bad('异常 ' + (e && e.stack ? e.stack : e));
  }

  say('\n=== ' + (failed ? failed + ' 项失败' : '歌单功能验证通过') + (skipped ? `（${skipped} 项因未登录跳过）` : '') + ' ===');
  try {
    win.destroy();
  } catch {}
  app.exit(failed ? 1 : 0);
});
