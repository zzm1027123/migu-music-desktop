/**
 * 「不能播放的歌曲标灰」功能验证
 *
 * 用真实的受限歌曲来验（用户的「我喜欢的」里有 8 首放不了）。
 * 期望：不能播的行加 .restricted（变灰）+「受限」标签，
 *       能播的行必须保持原样，不能误伤。
 *
 * 运行：electron test-playable.js
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const { prepareUserData } = require('./test-util');
app.setPath('userData', prepareUserData('.userdata-playable'));

const { registerIpc } = require('./src/ipc');
const resolver = require('./src/resolver');
const playlist = require('./src/playlist');
const logger = require('./src/logger');
logger.init(app.getPath('userData'));

const OUT = path.join(__dirname, 'test-playable-output.txt');
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
const skip = (m) => say('  [SKIP] ' + m);

const FAV_ID = '231413439';

registerIpc({
  getAuthState: () => ({ loggedIn: true, nickname: '测试用户', avatar: '', userId: '' }),
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
    say('=== 「不能播放标灰」功能验证 ===\n');

    say('[1] 先用接口算出第 1 页「应该」有哪些歌是放不了的');
    const page = await playlist.getPlaylistSongs(FAV_ID, 1, 20);
    if (!page.ok) throw new Error('读取歌单失败：' + page.error);
    const songs = page.songs || [];
    const map = await resolver.canListen(songs.map((s) => s.contentId));
    const expectRestricted = songs.filter((s) => map[s.contentId] && !map[s.contentId].canListen);
    const expectPlayable = songs.filter((s) => map[s.contentId] && map[s.contentId].canListen);
    say(`      第 1 页 ${songs.length} 首：预期受限 ${expectRestricted.length} 首，可播 ${expectPlayable.length} 首`);
    for (const s of expectRestricted) say(`      ✗ ${s.name} — ${(s.artists || []).join('、')}`);
    if (!expectRestricted.length) {
      skip('这一页没有受限歌曲，无法验证标灰（换一页或换账号才看得到）');
      throw new Error('__no_sample__');
    }
    ok('拿到了真实的受限样本');

    say('\n[2] 界面上打开「我喜欢的」第 1 页');
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    await wait(6000);
    await win.webContents.executeJavaScript(
      `(()=>{document.querySelector('.nav-item[data-view="mymusic"]').click();return 1})()`,
      true
    );
    await wait(7000);
    const clicked = await win.webContents.executeJavaScript(
      `(()=>{const c=document.querySelector('.pl-card[data-fav="1"]');
         if(!c) return false; c.querySelector('.c-name').click(); return true})()`,
      true
    );
    if (clicked) ok('进入了「我喜欢的」');
    else bad('没找到「我喜欢的」卡片');
    await wait(9000); // 等 can-listen 回来并完成标注

    // 把鼠标挪开：.restricted:hover 会提亮，停在某行上会干扰读数
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: 4 });
    await wait(400);

    const ui = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({
           rows: document.querySelectorAll('#plSongList .song-row').length,
           restricted: [...document.querySelectorAll('#plSongList .song-row.restricted')].map(r => ({
             name: r.querySelector('.s-name').textContent.replace('受限','').trim(),
             opacity: getComputedStyle(r).opacity,
             tag: r.querySelector('.tag-lock') ? r.querySelector('.tag-lock').textContent : '',
             title: r.getAttribute('title') || '',
             color: getComputedStyle(r.querySelector('.s-name')).color,
             coverFilter: getComputedStyle(r.querySelector('.s-cover')).filter
           })),
           allNames: [...document.querySelectorAll('#plSongList .song-row')].map(r =>
             r.querySelector('.s-name').textContent.replace('受限','').replace('试听','').trim())
         })`,
        true
      )
    );
    say('      ' + JSON.stringify(ui.restricted, null, 1).replace(/\n\s*/g, ' '));
    say(`      列表共 ${ui.rows} 行，标灰 ${ui.restricted.length} 行`);

    say('\n[3] 核对标注是否正确');
    if (ui.restricted.length === expectRestricted.length) {
      ok(`标灰行数与预期一致（${ui.restricted.length} 行）`);
    } else {
      bad(`标灰 ${ui.restricted.length} 行，预期 ${expectRestricted.length} 行`);
    }

    const uiNames = ui.restricted.map((r) => r.name);
    const missing = expectRestricted.filter((s) => !uiNames.some((n) => n.startsWith(s.name.slice(0, 8))));
    if (!missing.length) ok('每一首该灰的都灰了');
    else bad('漏标了：' + missing.map((s) => s.name).join('、'));

    const wrongly = expectPlayable.filter((s) => uiNames.some((n) => n.startsWith(s.name.slice(0, 8))));
    if (!wrongly.length) ok('没有误伤能播的歌');
    else bad('误标了能播的歌：' + wrongly.map((s) => s.name).join('、'));

    say('\n[4] 视觉是否真的变灰');
    const hasRows = ui.restricted.length > 0;
    const opacities = [...new Set(ui.restricted.map((r) => r.opacity))];
    if (hasRows && ui.restricted.every((r) => Number(r.opacity) < 1)) {
      ok(`受限行透明度 = ${opacities.join('/')}（确实变灰了）`);
    } else {
      bad('受限行没有变灰' + (hasRows ? '，透明度仍是 ' + opacities.join('/') : '（一行都没有）'));
    }
    if (hasRows && ui.restricted.every((r) => r.tag === '受限')) ok('都带「受限」标签');
    else bad('有受限行缺少「受限」标签');

    const withTitle = hasRows && ui.restricted.every((r) => r.title && r.title.length > 2);
    if (withTitle) ok('都有悬停说明：' + ui.restricted[0].title);
    else bad('缺少悬停说明');

    const playableStyle = JSON.parse(
      await win.webContents.executeJavaScript(
        `(()=>{const names=${JSON.stringify(expectPlayable.map((s) => s.name))};
           const rows=[...document.querySelectorAll('#plSongList .song-row')];
           const r=rows.find(x=>names.some(n=>x.querySelector('.s-name').textContent.trim().startsWith(n.slice(0,8))));
           return r ? JSON.stringify({
             opacity: getComputedStyle(r).opacity,
             color: getComputedStyle(r.querySelector('.s-name')).color,
             grayscale: getComputedStyle(r.querySelector('.s-cover')).filter
           }) : 'null'})()`,
        true
      )
    );
    if (playableStyle && playableStyle.opacity === '1') ok('可播放的行不透明（和灰行对比明显）');
    else bad('可播行透明度异常：' + (playableStyle && playableStyle.opacity));

    if (playableStyle && hasRows && ui.restricted[0].color !== playableStyle.color) {
      ok(`受限行歌名颜色更灰：${ui.restricted[0].color} vs 可播 ${playableStyle.color}`);
    } else {
      bad('受限行的文字颜色和可播行一样，没有真正变灰');
    }

    const coverGrey = hasRows && ui.restricted.every((r) => String(r.coverFilter).includes('grayscale'));
    if (coverGrey) ok('封面也去了色：' + ui.restricted[0].coverFilter);
    else bad('封面没有去色：' + (ui.restricted[0] && ui.restricted[0].coverFilter));

    try {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      await wait(700);
      fs.writeFileSync(path.join(__dirname, 'screenshot-restricted.png'), (await win.webContents.capturePage()).toPNG());
      say('      截图：screenshot-restricted.png');
    } catch (e) {
      say('      （截图跳过：' + ((e && e.message) || e) + '）');
    }
  } catch (e) {
    if (!/__no_sample__/.test(String(e && e.message))) bad('异常 ' + (e && e.stack ? e.stack : e));
  }

  say('\n=== ' + (failed ? failed + ' 项失败' : '标灰功能验证通过') + ' ===');
  resolver.destroy();
  try {
    win.destroy();
  } catch {}
  app.exit(failed ? 1 : 0);
});
