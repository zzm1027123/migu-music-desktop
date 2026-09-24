/**
 * 歌单播放队列验证：
 *  - 点歌后整个歌单是否进入播放列表（随机播放才能覆盖全部）
 *  - 「播放全部」按钮
 * 运行：electron test-playlist-queue.js
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const { prepareUserData } = require('./test-util');
app.setPath('userData', prepareUserData('.userdata-plq'));

const { registerIpc } = require('./src/ipc');
const logger = require('./src/logger');
logger.init(app.getPath('userData'));

const OUT = path.join(__dirname, 'test-plq-output.txt');
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

const session = require('electron').session;
registerIpc({
  getAuthState: async () => {
    const c = await session.defaultSession.cookies.get({});
    return {
      loggedIn: c.some((x) => ['pacmtoken', 'idmpauth', 'mg_auth_sid'].includes(x.name)),
      nickname: '测试用户',
      avatar: '',
      userId: '',
    };
  },
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
    say('=== 歌单播放队列验证 ===\n');
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    await wait(6500);

    say('[1] 进入「我喜欢的」歌单');
    await win.webContents.executeJavaScript(
      `(()=>{document.querySelector('.nav-item[data-view="mymusic"]').click();return 1})()`,
      true
    );
    await wait(7000);
    await win.webContents.executeJavaScript(
      `(()=>{const c=[...document.querySelectorAll('.pl-card')].find(x=>x.dataset.fav==='1');
         c.querySelector('.c-name').click();return 1})()`,
      true
    );
    await wait(8000);

    const pageInfo = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({
           rows: document.querySelectorAll('#plSongList .song-row').length,
           hasPlayAll: !!document.getElementById('playAllBtn'),
           playAllText: (document.getElementById('playAllBtn')||{}).textContent || '',
           queueBefore: (document.getElementById('queueCount')||{}).textContent || '0'
         })`,
        true
      )
    );
    say('      ' + JSON.stringify(pageInfo));
    if (pageInfo.rows === 20) ok('当前页显示 20 首');
    else bad('当前页数量异常：' + pageInfo.rows);
    if (pageInfo.hasPlayAll) ok('有「播放全部」按钮：' + pageInfo.playAllText);
    else bad('缺少播放全部按钮');
    // 歌单会一直变长，按钮上的总数就是权威值，别写死数字
    const totalSongs = Number((pageInfo.playAllText.match(/(\d+)\s*首/) || [])[1] || 0);

    say('\n[2] 点第 1 页第 1 首能播的歌（队列应被补全为整个歌单）');
    await win.webContents.executeJavaScript(
      `(()=>{const rows=[...document.querySelectorAll('#plSongList .song-row')];
         // 歌单开头可能是受限曲目（点了也不会出声），挑第一首能播的
         const r=rows.find(x=>!x.classList.contains('restricted')) || rows[0];
         r.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); return 1})()`,
      true
    );
    await wait(4000);
    const mid = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({
           now: document.getElementById('nowName').textContent,
           playing: !document.getElementById('audio').paused,
           queue: (document.getElementById('queueCount')||{}).textContent || '0'
         })`,
        true
      )
    );
    say('      4 秒后：' + JSON.stringify(mid));
    if (mid.playing) ok('已经开始播放：' + mid.now);
    else bad('没有开始播放');

    await wait(12000); // 等后台补全
    const after = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({
           queue: (document.getElementById('queueCount')||{}).textContent || '0',
           queueItems: document.querySelectorAll('#queueList .queue-item').length,
           toast: document.getElementById('toast').textContent
         })`,
        true
      )
    );
    say('      补全后：' + JSON.stringify(after));
    if (Number(after.queue) > 20) ok(`播放列表已补全为 ${after.queue} 首（不再是 20）`);
    else bad('播放列表仍是当前页数量：' + after.queue);
    if (Number(after.queue) === 201) ok('正好是整个歌单的 201 首');
    else say('      · 队列数量为 ' + after.queue + '（歌单可能已变动）');

    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, 'screenshot-pl-queue.png'), img.toPNG());
    say('      截图：screenshot-pl-queue.png');

    say('\n[3] 切到随机播放，验证能跳到后面的歌');
    await win.webContents.executeJavaScript(
      `(()=>{document.getElementById('modeBtn').click();return 1})()`,
      true
    );
    await wait(600);
    // 切到 random（list -> single -> random）
    await win.webContents.executeJavaScript(
      `(()=>{document.getElementById('modeBtn').click();return 1})()`,
      true
    );
    await wait(800);
    const mode = await win.webContents.executeJavaScript(`document.getElementById('toast').textContent`, true);
    say('      模式：' + mode);

    // 连续下一首若干次，看是否出现 > 第 20 首的歌（用队列里播放中的下标判断）
    const hits = [];
    for (let i = 0; i < 12; i++) {
      await win.webContents.executeJavaScript(
        `(()=>{document.getElementById('nextBtn').click();return 1})()`,
        true
      );
      await wait(2500);
      const idx = await win.webContents.executeJavaScript(
        `(()=>{const el=document.querySelector('#queueList .queue-item.playing .qi-idx');
           const items=[...document.querySelectorAll('#queueList .queue-item')];
           return items.findIndex(x=>x.classList.contains('playing'))})()`,
        true
      );
      hits.push(idx);
    }
    say('      随机到的队列下标：' + JSON.stringify(hits));
    const beyond = hits.filter((x) => x >= 20).length;
    if (beyond > 0) ok(`随机播放跳到了第 20 首之后（${beyond}/12 次），说明覆盖了整个歌单`);
    else bad('随机播放始终在前 20 首内：' + JSON.stringify(hits));

    say('\n[4] 「播放全部」按钮');
    await win.webContents.executeJavaScript(
      `(()=>{document.getElementById('playAllBtn').click();return 1})()`,
      true
    );
    await wait(15000);
    const all = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({
           now: document.getElementById('nowName').textContent,
           queue: (document.getElementById('queueCount')||{}).textContent || '0',
           playing: !document.getElementById('audio').paused
         })`,
        true
      )
    );
    say('      ' + JSON.stringify(all));
    if (Number(all.queue) === totalSongs && all.playing)
      ok(`播放全部：队列 ${totalSongs} 首并已开始播放`);
    else bad(`播放全部异常（期望队列 ${totalSongs} 首）：` + JSON.stringify(all));
  } catch (e) {
    bad('异常 ' + (e && e.stack ? e.stack : e));
  }

  say('\n=== ' + (failed ? failed + ' 项失败' : '歌单播放队列验证通过') + ' ===');
  try {
    win.destroy();
  } catch {}
  app.exit(failed ? 1 : 0);
});
