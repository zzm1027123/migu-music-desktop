/**
 * 「新建歌单」功能验证
 *
 * 覆盖：接口建歌单、重名报错、界面上新建卡片与弹窗、「加入歌单」里的新建并加入。
 * 所有测试歌单在结束时删除，不留下垃圾数据。
 *
 * 运行：electron test-create-playlist.js
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const { prepareUserData } = require('./test-util');
app.setPath('userData', prepareUserData('.userdata-create'));

const { registerIpc } = require('./src/ipc');
const resolver = require('./src/resolver');
const playlist = require('./src/playlist');
const api = require('./src/migu-api');
const logger = require('./src/logger');
logger.init(app.getPath('userData'));

const OUT = path.join(__dirname, 'test-create-output.txt');
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

const STAMP = String(Date.now()).slice(-6);
const NAME_API = `__新建接口_${STAMP}`;
const NAME_UI = `__新建界面_${STAMP}`;
const created = []; // 需要清理的歌单 id

registerIpc({
  getAuthState: () => ({ loggedIn: true, nickname: '', avatar: '', userId: '' }),
  login: async () => ({ ok: true }),
  logout: async () => ({ ok: true }),
  getSettings: () => ({}),
  setSettings: (p) => p,
});

async function deletePlaylist(id) {
  const r = await resolver.webCall('/pc/v1.0/user/deleteMusicList.do', { channel: '23', id: String(id) });
  return ((r && r.res && r.res.code) || '') === '000000';
}

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
    say('=== 新建歌单功能验证 ===\n');

    say('[1] 用接口新建歌单');
    const a = await playlist.createPlaylist(NAME_API);
    say('      ' + JSON.stringify(a));
    if (a.ok) ok(`建好了「${NAME_API}」 id=${a.id || '（接口未回 id）'}`);
    else bad('新建失败：' + a.error);
    if (a.id) created.push(a.id);

    await wait(1200);
    let mine = await playlist.getMyPlaylists();
    const found = (mine.created || []).find((p) => p.title === NAME_API);
    if (found) {
      ok('它出现在了「我的歌单」列表里');
      if (!a.id) created.push(found.id);
    } else {
      bad('新建后没在列表里找到它');
    }

    say('\n[2] 重名应该被拒绝');
    const dup = await playlist.createPlaylist(NAME_API);
    say('      ' + JSON.stringify(dup));
    if (!dup.ok && /同名/.test(dup.error || '')) ok('重名时给出了看得懂的提示：' + dup.error);
    else if (!dup.ok) say('      · 被拒绝了，但提示是：' + dup.error);
    else bad('重名竟然建成功了');

    say('\n[3] 空名字应该被拦下');
    const empty = await playlist.createPlaylist('   ');
    if (!empty.ok && /不能为空/.test(empty.error || '')) ok('空名字被本地拦下，没有白发一次请求');
    else bad('空名字没被拦住：' + JSON.stringify(empty));

    say('\n[4] 界面上的「新建歌单」入口');
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    await wait(6000);
    await win.webContents.executeJavaScript(
      `(()=>{document.querySelector('.nav-item[data-view="mymusic"]').click();return 1})()`,
      true
    );
    await wait(7000);

    const entry = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({
           hasCard: !!document.querySelector('.pl-card.pl-new'),
           label: (()=>{const c=document.querySelector('.pl-card.pl-new');
             return c ? c.querySelector('.c-name').textContent : ''})()
         })`,
        true
      )
    );
    say('      ' + JSON.stringify(entry));
    if (entry.hasCard) ok(`「我的歌单」里有新建入口：${entry.label}`);
    else bad('界面上没有新建歌单的入口');

    say('\n[5] 点入口 → 弹窗 → 创建');
    await win.webContents.executeJavaScript(
      `(()=>{document.querySelector('.pl-card.pl-new').click();return 1})()`,
      true
    );
    await wait(800);
    const dlg = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({
           open: document.getElementById('newPlMask').classList.contains('show'),
           hint: document.getElementById('newPlHint').textContent,
           hasInput: !!document.getElementById('newPlName'),
           focused: document.activeElement && document.activeElement.id === 'newPlName'
         })`,
        true
      )
    );
    say('      ' + JSON.stringify(dlg));
    if (dlg.open) ok('弹窗打开了');
    else bad('弹窗没出现');
    if (dlg.hasInput) ok('有名字输入框，提示语：' + dlg.hint);
    else bad('没有输入框');
    if (dlg.focused) ok('输入框自动获得焦点（可以直接打字）');
    else say('      · 输入框没有自动聚焦');

    // 先把名字填上，趁弹窗开着截一张图
    await win.webContents.executeJavaScript(
      `(()=>{document.getElementById('newPlName').value=${JSON.stringify(NAME_UI)};return 1})()`,
      true
    );
    await wait(500);
    try {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      await wait(700);
      const shot = await win.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, 'screenshot-new-playlist.png'), shot.toPNG());
      say('      截图：screenshot-new-playlist.png');
    } catch (e) {
      say('      （截图跳过：' + ((e && e.message) || e) + '）');
    }

    await win.webContents.executeJavaScript(
      `(()=>{document.getElementById('newPlOk').click();return 1})()`,
      true
    );
    await wait(6000);

    const after = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({
           closed: !document.getElementById('newPlMask').classList.contains('show'),
           toast: document.getElementById('toast').textContent,
           titles: [...document.querySelectorAll('.pl-card')].map(c => c.dataset.title)
         })`,
        true
      )
    );
    say('      toast=' + after.toast);
    say('      卡片=' + JSON.stringify(after.titles));
    if (after.closed) ok('创建后弹窗自动关闭');
    else bad('弹窗没关闭');
    if (/已创建/.test(after.toast)) ok('提示：' + after.toast);
    else bad('没有创建成功提示：' + after.toast);
    if (after.titles.includes(NAME_UI)) ok('新歌单立刻出现在列表里（页面已刷新）');
    else bad('列表里没看到新歌单');
    if (after.titles.includes(NAME_API)) ok('之前用接口建的那个也在列表里');
    else bad('列表少了先前建的歌单');

    const uiOne = (await playlist.getMyPlaylists()).created.find((p) => p.title === NAME_UI);
    if (uiOne) created.push(uiOne.id);

    say('\n[6] 「加入歌单」弹窗里的「新建并加入」');
    const s = await api.search('周杰伦', 1, 20);
    const song = (s.songs || [])[0];
    if (!song) {
      bad('搜索没结果，跳过这一项');
    } else {
      await win.webContents.executeJavaScript(
        `(()=>{const i=document.getElementById('searchInput'); i.value='周杰伦';
           document.getElementById('searchBtn').click(); return 1})()`,
        true
      );
      await wait(6000);
      await win.webContents.executeJavaScript(
        `(()=>{document.querySelector('#searchList .song-row .add-pl').click(); return 1})()`,
        true
      );
      await wait(4000);

      const hasNewItem = await win.webContents.executeJavaScript(
        `!!document.querySelector('#plList .pl-new-item')`,
        true
      );
      if (hasNewItem) ok('弹窗底部有「＋ 新建歌单并加入」');
      else bad('弹窗里没有新建入口');

      if (hasNewItem) {
        await win.webContents.executeJavaScript(
          `(()=>{document.querySelector('#plList .pl-new-item').click(); return 1})()`,
          true
        );
        await wait(900);
        const combo = JSON.parse(
          await win.webContents.executeJavaScript(
            `JSON.stringify({
               pickerClosed: !document.getElementById('playlistMask').classList.contains('show'),
               newOpen: document.getElementById('newPlMask').classList.contains('show'),
               hint: document.getElementById('newPlHint').textContent
             })`,
            true
          )
        );
        say('      ' + JSON.stringify(combo));
        if (combo.pickerClosed && combo.newOpen) ok('自动切到新建弹窗，并提示会把这歌加进去');
        else bad('弹窗切换不对');
        say('      提示语：' + combo.hint);
      }
    }
    // 这一项只验证入口与切换，不真的建第三个歌单（避免多留数据）
  } catch (e) {
    bad('异常 ' + (e && e.stack ? e.stack : e));
  }

  // ---- 收尾 ----
  say('\n[7] 收尾：删除测试歌单');
  for (const id of [...new Set(created.filter(Boolean))]) {
    await deletePlaylist(id);
    await wait(900);
  }
  await wait(1200);
  const left = (await playlist.getMyPlaylists()).created.filter((p) =>
    [NAME_API, NAME_UI].includes(p.title)
  );
  if (!left.length) ok(`已清理 ${[...new Set(created)].length} 个测试歌单，没有残留`);
  else bad('还有残留，需手动清理：' + left.map((p) => `${p.title}(${p.id})`).join(', '));

  say('\n=== ' + (failed ? failed + ' 项失败' : '新建歌单功能验证通过') + ' ===');
  resolver.destroy();
  try {
    win.destroy();
  } catch {}
  app.exit(failed ? 1 : 0);
});
