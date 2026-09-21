/**
 * 会员歌曲端到端验证：使用真实登录态，在客户端界面里搜索并播放 VIP 歌曲。
 * 运行：electron verify-vip.js
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, session } = require('electron');

app.setPath('userData', process.env.MIGU_TEST_UD || path.join(__dirname, 'dist', '咪咕音乐', 'resources', 'app', '.userdata'));

const { registerIpc } = require('./src/ipc');
const resolver = require('./src/resolver');

const LOG = path.join(__dirname, 'verify-vip-output.txt');
fs.writeFileSync(LOG, '');
const say = (m = '') => {
  fs.appendFileSync(LOG, m + '\n');
  console.log(m);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

registerIpc({
  getAuthState: () => ({ loggedIn: true, nickname: '', avatar: '', userId: '' }),
  login: async () => ({ ok: true }),
  logout: async () => ({ ok: true }),
  confirmLogin: async () => ({ ok: true }),
});

app.whenReady().then(async () => {
  let failed = 0;
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
    say('=== 会员歌曲端到端验证 ===\n');
    const cookies = await session.defaultSession.cookies.get({});
    say(`[1] 登录 Cookie ${cookies.length} 个，登录票据=${cookies.some((c) => c.name === 'idmpauth' || c.name === 'pacmtoken') ? '有 ✓' : '无'}`);

    resolver.prewarm();
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    await wait(6000);

    // 搜索周杰伦《晴天》（VIP 曲目）
    await win.webContents.executeJavaScript(
      `(()=>{const i=document.getElementById('searchInput');i.value='晴天';document.getElementById('searchBtn').click();return 1})()`,
      true
    );
    await wait(5500);
    const rows = await win.webContents.executeJavaScript(`document.querySelectorAll('#searchList .song-row').length`, true);
    say(`[2] 搜索结果 ${rows} 行`);
    if (!rows) failed++;

    const first = await win.webContents.executeJavaScript(
      `(()=>{const r=document.querySelector('#searchList .song-row');return r?r.querySelector('.s-name').textContent.trim():''})()`,
      true
    );
    say(`[3] 第一首：${first}`);

    // 等待受限标记（can-listen）完成
    await wait(2500);
    const marks = await win.webContents.executeJavaScript(
      `JSON.stringify({restricted:document.querySelectorAll('#searchList .song-row.restricted').length, trial:document.querySelectorAll('#searchList .song-row.trial').length, total:document.querySelectorAll('#searchList .song-row').length})`,
      true
    );
    say(`[4] 受限标记：${marks}`);

    // 双击播放
    await win.webContents.executeJavaScript(
      `(()=>{const r=document.querySelector('#searchList .song-row');if(r)r.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));return 1})()`,
      true
    );
    await wait(7000);

    const st = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({t:document.getElementById('audio').currentTime,playing:!document.getElementById('audio').paused,now:document.getElementById('nowName').textContent,artist:document.getElementById('nowArtist').textContent,dur:document.getElementById('audio').duration,src:(document.getElementById('audio').src||'').slice(0,80),err:document.getElementById('audio').error?document.getElementById('audio').error.code:null})`,
        true
      )
    );
    say(`[5] 播放状态：${JSON.stringify(st)}`);
    if (st.t > 0.5) say(`      ✓ 会员歌曲播放成功：《${st.now}》- ${st.artist}，已播放 ${st.t.toFixed(1)}s / ${Math.round(st.dur || 0)}s`);
    else {
      say('      ✗ 会员歌曲未能出声');
      failed++;
    }

    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, 'screenshot-vip.png'), img.toPNG());
    say('[6] 截图：screenshot-vip.png');
  } catch (e) {
    say('异常：' + (e && e.stack ? e.stack : e));
    failed++;
  }

  say('\n=== ' + (failed ? failed + ' 项失败' : '会员歌曲验证通过') + ' ===');
  resolver.destroy();
  try {
    win.destroy();
  } catch {}
  app.exit(failed ? 1 : 0);
});
