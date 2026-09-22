/**
 * 「把歌曲移出歌单」功能验证
 *
 * 为避免动到用户的真实歌单，测试全程在一个临时新建的歌单里进行，
 * 结束后把整个歌单删掉。覆盖：
 *   1) 临时歌单的创建 / 加歌
 *   2) 界面上的「移出」按钮确实渲染出来
 *   3) 点按钮真的把歌移出，且列表就地刷新
 *   4) 收尾删除临时歌单
 *
 * 运行：electron test-remove.js
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const REAL_UD = process.env.MIGU_TEST_UD || path.join(__dirname, 'dist', '咪咕音乐', 'resources', 'app', '.userdata');
const TEST_UD = path.join(__dirname, '.userdata-remove');
if (!fs.existsSync(TEST_UD) && fs.existsSync(REAL_UD)) fs.cpSync(REAL_UD, TEST_UD, { recursive: true });
app.setPath('userData', fs.existsSync(TEST_UD) ? TEST_UD : path.join(__dirname, '.userdata'));

const { registerIpc } = require('./src/ipc');
const resolver = require('./src/resolver');
const playlist = require('./src/playlist');
const api = require('./src/migu-api');
const logger = require('./src/logger');
logger.init(app.getPath('userData'));

const OUT = path.join(__dirname, 'test-remove-output.txt');
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

const TEST_TITLE = '__移出功能测试歌单__';

registerIpc({
  getAuthState: () => ({ loggedIn: true, nickname: '', avatar: '', userId: '' }),
  login: async () => ({ ok: true }),
  logout: async () => ({ ok: true }),
  confirmLogin: async () => ({ ok: true }),
  getSettings: () => ({}),
  setSettings: (p) => p,
});

/** 新建歌单，返回 musicListId */
async function createPlaylist(title) {
  const r = await resolver.webCall('/pc/open/api/music-list/add/v2.0', { title, channel: '23', type: 'self_build' }, 'post');
  const res = (r && r.res) || {};
  if (res.code !== '000000') return { ok: false, error: `${res.code} ${res.info || r.err}` };
  const mine = await playlist.getMyPlaylists();
  const found = (mine.created || []).find((p) => p.title === title);
  return found ? { ok: true, id: found.id } : { ok: false, error: '歌单建好了但没在列表里找到' };
}

/** 删除歌单 */
async function deletePlaylist(id) {
  const r = await resolver.webCall('/pc/v1.0/user/deleteMusicList.do', { channel: '23', id: String(id) });
  const res = (r && r.res) || {};
  return { ok: res.code === '000000', error: `${res.code} ${res.info || r.err}` };
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

  let testId = '';

  try {
    say('=== 移出歌单功能验证 ===\n');

    say('[1] 准备临时歌单');
    const created = await createPlaylist(TEST_TITLE);
    if (!created.ok) {
      bad('建测试歌单失败：' + created.error);
      throw new Error('无法继续');
    }
    testId = created.id;
    ok(`临时歌单已创建 id=${testId}`);

    say('\n[2] 往里放 3 首歌');
    const s = await api.search('周杰伦', 1, 30);
    const picks = (s.songs || []).filter((x) => x.contentId).slice(0, 3);
    if (picks.length < 3) throw new Error('搜索结果不足 3 首');
    const added = await playlist.addSongs(testId, picks.map((x) => x.contentId));
    say('      ' + JSON.stringify(added));
    await wait(1500);

    let list = await playlist.getPlaylistSongs(testId, 1, 20);
    if (list.ok && list.total === 3) ok(`歌单里现在有 ${list.total} 首`);
    else bad(`歌单里应有 3 首，实际 ${list.total}`);
    // 记下移出前的 id 集合：歌单里的排序是服务端定的，不能假设它等于搜索结果的顺序
    const idsBefore = (list.songs || []).map((x) => x.contentId);

    say('\n[3] 界面上打开这个歌单');
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    await wait(6000);
    await win.webContents.executeJavaScript(
      `(()=>{document.querySelector('.nav-item[data-view="mymusic"]').click();return 1})()`,
      true
    );
    await wait(7000);

    const cardFound = await win.webContents.executeJavaScript(
      `(()=>{const c=[...document.querySelectorAll('.pl-card')].find(x=>x.dataset.title===${JSON.stringify(
        TEST_TITLE
      )});
         if(!c) return false; c.querySelector('.c-name').click(); return true})()`,
      true
    );
    if (cardFound) ok('找到并点开了临时歌单');
    else bad('我的音乐里没找到临时歌单卡片');
    await wait(7000);

    const before = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({
           rows: document.querySelectorAll('#plSongList .song-row').length,
           removeBtns: document.querySelectorAll('#plSongList .remove-pl').length,
           removableClass: !!document.querySelector('#plSongList.removable'),
           first: (document.querySelector('#plSongList .s-name')||{}).textContent || ''
         })`,
        true
      )
    );
    say('      ' + JSON.stringify(before));
    if (before.rows === 3) ok('列表渲染了 3 行');
    else bad(`列表应渲染 3 行，实际 ${before.rows}`);
    if (before.removeBtns === 3) ok('每行都有「移出」按钮');
    else bad(`「移出」按钮应有 3 个，实际 ${before.removeBtns}`);
    if (before.removableClass) ok('列表带 removable 标记（列宽已适配两个按钮）');
    else bad('列表缺少 removable 标记');

    // 悬停到第一行，让操作按钮显形后截图，确认两个按钮没有把列挤坏。
    // 截图只是附带的观感检查，失败了不能影响功能断言。
    try {
      await win.webContents.executeJavaScript(
        `(()=>{
           const st=document.createElement('style');
           st.textContent='.s-act{opacity:1 !important}';
           document.head.appendChild(st);
           return 1})()`,
        true
      );
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      await wait(1000);
      const shot1 = await win.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, 'screenshot-remove-before.png'), shot1.toPNG());
      say('      截图：screenshot-remove-before.png');
    } catch (e) {
      say('      （截图跳过：' + ((e && e.message) || e) + '）');
    }

    say('\n[4] 点第一行的「移出」按钮');
    await win.webContents.executeJavaScript(
      `(()=>{document.querySelector('#plSongList .remove-pl').click();return 1})()`,
      true
    );
    await wait(6000);

    const after = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({
           rows: document.querySelectorAll('#plSongList .song-row').length,
           toast: document.getElementById('toast').textContent,
           lastRow: (()=>{const r=[...document.querySelectorAll('#plSongList .song-row')].pop();
             return r ? r.querySelector('.s-name').textContent.trim() : ''})()
         })`,
        true
      )
    );
    say('      ' + JSON.stringify(after));
    if (after.rows === 2) ok('列表就地刷新成 2 行');
    else bad(`移出后应剩 2 行，实际 ${after.rows}`);
    if (/移出/.test(after.toast)) ok('给出了移出提示：' + after.toast);
    else bad('没有移出提示，toast=' + after.toast);

    try {
      const shot2 = await win.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, 'screenshot-remove-after.png'), shot2.toPNG());
      say('      截图：screenshot-remove-after.png');
    } catch (e) {
      say('      （截图跳过：' + ((e && e.message) || e) + '）');
    }

    say('\n[5] 用接口独立复核');
    const verify = await playlist.getPlaylistSongs(testId, 1, 20);
    if (verify.ok && verify.total === 2) ok(`服务端确认歌单剩 ${verify.total} 首`);
    else bad(`服务端应为 2 首，实际 ${verify.total}`);
    const idsAfter = (verify.songs || []).map((x) => x.contentId);
    const gone = idsBefore.filter((id) => !idsAfter.includes(id));
    if (gone.length === 1) {
      const name = (picks.find((p) => p.contentId === gone[0]) || {}).name || gone[0];
      ok(`恰好少了一首：《${name}》，其余歌曲未受影响`);
      if (after.toast.includes(`已把《${name}》移出`)) ok('提示里报的歌名与实际移出的歌一致');
      else bad(`提示歌名对不上：${after.toast}`);
    } else {
      bad(`应恰好少 1 首，实际少了 ${gone.length} 首`);
    }
    const noLeftover = idsAfter.every((id) => idsBefore.includes(id));
    if (noLeftover) ok('没有误伤其它歌曲');
    else bad('有原本不在歌单里的歌曲混进来了');
  } catch (e) {
    if (!/无法继续/.test(String(e && e.message))) bad('异常 ' + (e && e.stack ? e.stack : e));
  }

  // ---- 「我喜欢的」走的是另一条分支（不传歌单 id），单独验一次，全程可逆 ----
  let favProbe = '';
  try {
    say('\n[7] 「我喜欢的」的移出（不传歌单 id 的分支）');
    const s2 = await api.search('告白气球', 1, 30);
    const cands = (s2.songs || []).filter((x) => x.contentId).slice(0, 30);
    const chk = await playlist.checkInPlaylists(cands.map((x) => x.contentId));
    const notFav = cands.find((x) => chk.favMap[x.contentId] === false);
    if (!notFav) {
      say('      · 没找到确定不在「我喜欢的」里的歌，跳过');
    } else {
      favProbe = notFav.contentId;
      const addR = await playlist.addSongs('', [favProbe]);
      await wait(1500);
      let c = await playlist.checkInPlaylists([favProbe]);
      if (addR.ok && c.favMap[favProbe] === true) ok(`《${notFav.name}》已临时加入「我喜欢的」`);
      else bad('临时加入「我喜欢的」失败，跳过该项');

      if (c.favMap[favProbe] === true) {
        const rmR = await playlist.removeSongs('', [favProbe]);
        say('      ' + JSON.stringify(rmR));
        await wait(1500);
        c = await playlist.checkInPlaylists([favProbe]);
        if (rmR.ok && c.favMap[favProbe] === false) {
          ok('用空 id 也能从「我喜欢的」移出，且状态已确认');
          favProbe = '';
        } else {
          bad('移出「我喜欢的」没生效');
        }
      }
    }
  } catch (e) {
    bad('「我喜欢的」分支异常 ' + ((e && e.message) || e));
  }

  // ---- 收尾：一定要把临时歌单删掉 ----
  if (testId) {
    say('\n[6] 收尾：删除临时歌单');
    const del = await deletePlaylist(testId);
    await wait(1500);
    const mine = await playlist.getMyPlaylists();
    const still = (mine.created || []).some((p) => p.id === testId || p.title === TEST_TITLE);
    if (del.ok && !still) ok('临时歌单已删除，没有留下垃圾数据');
    else bad('临时歌单未能删除，需要手动清理：id=' + testId);
  }
  if (favProbe) {
    say('\n[8] 收尾：把临时加进「我喜欢的」的歌清掉');
    await playlist.removeSongs('', [favProbe]);
    await wait(1200);
    const c = await playlist.checkInPlaylists([favProbe]);
    if (c.favMap[favProbe] === false) ok('已恢复原状');
    else bad('「我喜欢的」里残留了一首歌，请手动清理：' + favProbe);
  }

  say('\n=== ' + (failed ? failed + ' 项失败' : '移出歌单功能验证通过') + ' ===');
  resolver.destroy();
  try {
    win.destroy();
  } catch {}
  app.exit(failed ? 1 : 0);
});
