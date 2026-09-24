/**
 * 「删除歌单」功能验证
 *
 * 覆盖：封面右上角 ✕ 的显示时机（只在鼠标放到封面上时出现）、
 * 系统歌单不可删、确认框的取消/确定两条分支、删除后列表刷新。
 * 测试全程只操作自己新建的临时歌单。
 *
 * 运行：electron test-delete-playlist.js
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const { prepareUserData } = require('./test-util');
app.setPath('userData', prepareUserData('.userdata-deletepl'));

const { registerIpc } = require('./src/ipc');
const resolver = require('./src/resolver');
const playlist = require('./src/playlist');
const logger = require('./src/logger');
logger.init(app.getPath('userData'));

const OUT = path.join(__dirname, 'test-delete-output.txt');
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

const NAME = `__删除测试_${String(Date.now()).slice(-6)}`;

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
  const js = (code) => win.webContents.executeJavaScript(code, true);
  /**
   * 把鼠标挪到某个坐标（用来触发 CSS :hover）。
   * sendInputEvent 用的是 CSS 像素，和 getBoundingClientRect 同一套坐标，不要乘 devicePixelRatio。
   */
  const moveMouse = async (x, y) => {
    const px = Math.round(x);
    const py = Math.round(y);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: px, y: py });
    await wait(90);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: px + 1, y: py + 1 });
    await wait(450);
  };

  let created = null;

  try {
    say('=== 删除歌单功能验证 ===\n');

    say('[1] 先建一个临时歌单');
    const c = await playlist.createPlaylist(NAME);
    if (!c.ok) {
      bad('建测试歌单失败：' + c.error);
      throw new Error('__stop__');
    }
    created = c.id;
    ok(`临时歌单已建：${NAME} (id=${created})`);

    say('\n[2] 打开「我的音乐」');
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    await wait(6000);
    await js(`(()=>{document.querySelector('.nav-item[data-view="mymusic"]').click();return 1})()`);
    await wait(7500);

    const info = JSON.parse(
      await js(
        `(()=>{const c=[...document.querySelectorAll('.pl-card')].find(x=>x.dataset.title===${JSON.stringify(NAME)});
           if(!c) return JSON.stringify({found:false});
           const cover=c.querySelector('.c-cover');
           const r=cover.getBoundingClientRect();
           return JSON.stringify({
             found:true,
             hasDel:!!c.querySelector('.c-del'),
             delTitle:(c.querySelector('.c-del')||{}).title||'',
             cx:r.x+r.width/2, cy:r.y+r.height/2,
             cardCx:r.x+r.width/2, cardCy:r.bottom+18
           })})()`
      )
    );
    if (!info.found) {
      bad('列表里没找到刚建的歌单');
      throw new Error('__stop__');
    }
    ok('找到了临时歌单卡片');
    if (info.hasDel) ok('封面上有删除按钮：' + info.delTitle);
    else bad('卡片上没有删除按钮');

    say('\n[3] 系统歌单「我喜欢的」不该有删除按钮');
    const favHasDel = await js(`!!document.querySelector('.pl-card[data-fav="1"] .c-del')`);
    if (!favHasDel) ok('「我喜欢的」没有删除按钮（系统歌单删不得）');
    else bad('「我喜欢的」上出现了删除按钮');

    say('\n[4] 把卡片滚到视口中间（否则它落在底部播放条下面，鼠标够不到）');
    const RECT = `(()=>{const c=[...document.querySelectorAll('.pl-card')].find(x=>x.dataset.title===${JSON.stringify(
      NAME
    )});
      const cr=c.querySelector('.c-cover').getBoundingClientRect();
      const nr=c.querySelector('.c-name').getBoundingClientRect();
      return JSON.stringify({
        cx: cr.x + cr.width/2, cy: cr.y + cr.height/2,
        nx: nr.x + nr.width/2, ny: nr.y + nr.height/2,
        coverBottom: cr.bottom, vh: window.innerHeight
      })})()`;
    await js(`(()=>{const c=[...document.querySelectorAll('.pl-card')].find(x=>x.dataset.title===${JSON.stringify(
      NAME
    )}); if(c) c.scrollIntoView({block:'center'}); return 1})()`);
    await wait(900);
    const rect = JSON.parse(await js(RECT));
    say('      ' + JSON.stringify(rect));
    if (rect.coverBottom < rect.vh - 90) ok('封面已完全避开底部播放条，可以真实悬停');
    else bad(`封面底部 ${Math.round(rect.coverBottom)} 仍在播放条区域内（视口高 ${rect.vh}）`);

    say('\n[5] 显示时机：鼠标不在封面上时应该看不见');
    await moveMouse(6, 6); // 挪到左上角
    const idle = await js(
      `getComputedStyle([...document.querySelectorAll('.pl-card')].find(x=>x.dataset.title===${JSON.stringify(
        NAME
      )}).querySelector('.c-del')).opacity`
    );
    if (Number(idle) === 0) ok(`鼠标离开时 ✕ 是隐藏的（opacity=${idle}）`);
    else bad(`鼠标不在封面上，✕ 却是可见的（opacity=${idle}）`);

    say('\n[6] 鼠标移到封面上，✕ 应该出现');
    await moveMouse(rect.cx, rect.cy);
    const diag = JSON.parse(
      await js(
        `(()=>{const c=[...document.querySelectorAll('.pl-card')].find(x=>x.dataset.title===${JSON.stringify(NAME)});
           return JSON.stringify({
             opacity: getComputedStyle(c.querySelector('.c-del')).opacity,
             hoverChain: [...document.querySelectorAll(':hover')].map(e=>e.className||e.tagName).slice(-4)
           })})()`
      )
    );
    say('      ' + JSON.stringify(diag));
    if (Number(diag.opacity) === 1) ok(`鼠标放到封面上后 ✕ 显示了（opacity=${diag.opacity}）`);
    else bad(`鼠标已在封面上，✕ 却没显示（opacity=${diag.opacity}，hover 链=${diag.hoverChain.join('>')}）`);

    say('\n[7] 鼠标移到歌名上（已离开封面），✕ 应该又藏起来');
    await moveMouse(rect.nx, rect.ny);
    const overName = await js(
      `getComputedStyle([...document.querySelectorAll('.pl-card')].find(x=>x.dataset.title===${JSON.stringify(
        NAME
      )}).querySelector('.c-del')).opacity`
    );
    if (Number(overName) === 0) ok(`鼠标在歌名上时 ✕ 是隐藏的（opacity=${overName}）`);
    else bad(`鼠标已离开封面，✕ 仍可见（opacity=${overName}）`);

    try {
      await moveMouse(rect.cx, rect.cy);
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      await wait(700);
      fs.writeFileSync(path.join(__dirname, 'screenshot-delete-playlist.png'), (await win.webContents.capturePage()).toPNG());
      say('      截图：screenshot-delete-playlist.png');
    } catch (e) {
      say('      （截图跳过：' + ((e && e.message) || e) + '）');
    }

    say('\n[8] 点 ✕ → 应该先弹确认框');
    await js(
      `(()=>{const c=[...document.querySelectorAll('.pl-card')].find(x=>x.dataset.title===${JSON.stringify(
        NAME
      )}); c.querySelector('.c-del').click(); return 1})()`
    );
    await wait(900);
    const dlg = JSON.parse(
      await js(
        `JSON.stringify({
           open: document.getElementById('confirmMask').classList.contains('show'),
           title: document.getElementById('confirmTitle').textContent,
           text: document.getElementById('confirmText').textContent,
           okText: document.getElementById('confirmOk').textContent
         })`
      )
    );
    say('      ' + JSON.stringify(dlg));
    if (dlg.open) ok('弹出了确认框：' + dlg.title + ' / 按钮「' + dlg.okText + '」');
    else bad('点 ✕ 后没有确认框，直接就删了');
    if (dlg.text.includes(NAME)) ok('确认文案里写清了是哪个歌单');
    else bad('确认文案没提到歌单名');

    say('\n[9] 先点「取消」——歌单必须还在');
    await js(`document.getElementById('confirmCancel').click()`);
    await wait(1200);
    const stillThere = await js(
      `!![...document.querySelectorAll('.pl-card')].find(x=>x.dataset.title===${JSON.stringify(NAME)})`
    );
    if (stillThere) ok('取消后歌单还在（没有误删）');
    else bad('点了取消，歌单却不见了');
    const apiStill = (await playlist.getMyPlaylists()).created.some((p) => p.id === created);
    if (apiStill) ok('服务端也确认歌单还在');
    else bad('服务端歌单已经没了');

    say('\n[10] 再点 ✕ 并确认——这次应该删掉');
    await js(
      `(()=>{const c=[...document.querySelectorAll('.pl-card')].find(x=>x.dataset.title===${JSON.stringify(
        NAME
      )}); c.querySelector('.c-del').click(); return 1})()`
    );
    await wait(900);
    await js(`document.getElementById('confirmOk').click()`);
    await wait(7000);

    const after = JSON.parse(
      await js(
        `JSON.stringify({
           gone: ![...document.querySelectorAll('.pl-card')].find(x=>x.dataset.title===${JSON.stringify(NAME)}),
           toast: document.getElementById('toast').textContent,
           maskClosed: !document.getElementById('confirmMask').classList.contains('show')
         })`
      )
    );
    say('      ' + JSON.stringify(after));
    if (after.gone) ok('歌单从列表里消失了');
    else bad('删除后歌单还在列表里');
    if (/已删除/.test(after.toast)) ok('提示：' + after.toast);
    else bad('没有删除成功提示：' + after.toast);
    if (after.maskClosed) ok('确认框自动关闭');

    const goneOnServer = !(await playlist.getMyPlaylists()).created.some((p) => p.id === created);
    if (goneOnServer) {
      ok('服务端确认已删除');
      created = null; // 已经删干净，收尾就不用再删
    } else {
      bad('服务端还有这个歌单');
    }
  } catch (e) {
    if (!/__stop__/.test(String(e && e.message))) bad('异常 ' + (e && e.stack ? e.stack : e));
  }

  if (created) {
    say('\n[11] 收尾：删除遗留的测试歌单');
    const r = await playlist.deletePlaylist(created);
    if (r.ok) ok('已清理');
    else bad('清理失败，需手动删除 id=' + created);
  }

  say('\n=== ' + (failed ? failed + ' 项失败' : '删除歌单功能验证通过') + ' ===');
  resolver.destroy();
  try {
    win.destroy();
  } catch {}
  app.exit(failed ? 1 : 0);
});
