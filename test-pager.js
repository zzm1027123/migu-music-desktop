/**
 * 分页验证：歌单 / 搜索 / 榜单 每页 50 首，翻页后序号连续
 * 运行：electron test-pager.js
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const REAL_UD = process.env.MIGU_TEST_UD || path.join(__dirname, 'dist', '咪咕音乐', 'resources', 'app', '.userdata');
const TEST_UD = path.join(__dirname, '.userdata-pager');
if (!fs.existsSync(TEST_UD) && fs.existsSync(REAL_UD)) {
  fs.cpSync(REAL_UD, TEST_UD, { recursive: true });
}
app.setPath('userData', fs.existsSync(TEST_UD) ? TEST_UD : path.join(__dirname, '.userdata'));

const { registerIpc } = require('./src/ipc');
const logger = require('./src/logger');
logger.init(app.getPath('userData'));

const OUT = path.join(__dirname, 'test-pager-output.txt');
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
    return { loggedIn: c.some((x) => ['pacmtoken', 'idmpauth', 'mg_auth_sid'].includes(x.name)), nickname: '测试用户', avatar: '', userId: '' };
  },
  login: async () => ({ ok: true }),
  logout: async () => ({ ok: true }),
  confirmLogin: async () => ({ ok: true }),
  getSettings: () => ({}),
  setSettings: (p) => p,
});

/** 读取当前列表页的快照 */
const SNAP = (listSel) => `JSON.stringify({
  rows: document.querySelectorAll('${listSel} .song-row').length,
  firstIdx: (()=>{const e=document.querySelector('${listSel} .song-row .s-idx');return e?e.textContent.trim():''})(),
  lastIdx: (()=>{const a=[...document.querySelectorAll('${listSel} .song-row .s-idx')];const e=a[a.length-1];return e?e.textContent.trim():''})(),
  firstName: (()=>{const e=document.querySelector('${listSel} .song-row .s-name');return e?e.textContent.trim():''})(),
  pager: !!document.querySelector('.pager'),
  pageBtns: [...document.querySelectorAll('.pager .pg-num')].map(e=>e.textContent),
  current: (()=>{const e=document.querySelector('.pager .pg-num.on');return e?e.textContent:''})(),
  totalText: (()=>{const e=document.querySelector('.pager .pg-total');return e?e.textContent:''})(),
  sub: (()=>{const e=document.querySelector('.page-sub');return e?e.textContent:''})()
})`;

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
    say('=== 分页验证 ===\n');
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    await wait(6500);

    // ---------- 歌单 ----------
    say('[1] 歌单分页（我喜欢的 201 首）');
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

    const p1 = JSON.parse(await win.webContents.executeJavaScript(SNAP('#plSongList'), true));
    say('      第1页：' + JSON.stringify(p1));
    if (p1.rows === 20) ok('第 1 页正好 20 首');
    else bad('第 1 页数量不是 20：' + p1.rows);
    if (p1.firstIdx === '1' && p1.lastIdx === '20') ok('序号 1 → 20');
    else bad(`序号异常：${p1.firstIdx} → ${p1.lastIdx}`);
    if (p1.pager && p1.pageBtns.includes('1') && p1.pageBtns.includes('11')) ok('分页控件出现（201 首 / 20 = 11 页）');
    else bad('分页控件异常：' + JSON.stringify(p1.pageBtns));
    if (/201/.test(p1.totalText)) ok('显示总数：' + p1.totalText);
    else bad('总数显示异常：' + p1.totalText);

    say('\n[2] 翻到第 2 页');
    await win.webContents.executeJavaScript(
      `(()=>{const b=[...document.querySelectorAll('.pager .pg-num')].find(e=>e.textContent==='2');
         b.click();return 1})()`,
      true
    );
    await wait(8000);
    const p2 = JSON.parse(await win.webContents.executeJavaScript(SNAP('#plSongList'), true));
    say('      第2页：' + JSON.stringify(p2));
    if (p2.rows === 20) ok('第 2 页 20 首');
    else bad('第 2 页数量异常：' + p2.rows);
    if (p2.firstIdx === '21' && p2.lastIdx === '40') ok('序号接着上页：21 → 40');
    else bad(`序号不连续：${p2.firstIdx} → ${p2.lastIdx}`);
    if (p2.current === '2') ok('页码高亮切到第 2 页');
    else bad('页码高亮异常：' + p2.current);

    say('\n[3] 跳到最后一页（201 首 -> 第 11 页应只有 1 首）');
    await win.webContents.executeJavaScript(
      `(()=>{const b=[...document.querySelectorAll('.pager .pg-num')].find(e=>e.textContent==='11');
         b.click();return 1})()`,
      true
    );
    await wait(8000);
    const p5 = JSON.parse(await win.webContents.executeJavaScript(SNAP('#plSongList'), true));
    say('      第11页：' + JSON.stringify(p5));
    if (p5.rows === 1 && p5.firstIdx === '201') ok('末页只剩 1 首，序号 201');
    else bad(`末页异常：${p5.rows} 首，序号 ${p5.firstIdx}`);

    say('\n[4] 下一页按钮在末页应禁用');
    const disabled = await win.webContents.executeJavaScript(
      `(()=>{const b=[...document.querySelectorAll('.pager .pg-btn')].find(e=>e.textContent.includes('下一页'));
         return b ? b.disabled : null})()`,
      true
    );
    if (disabled === true) ok('末页「下一页」已禁用');
    else bad('「下一页」未禁用：' + disabled);

    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, 'screenshot-pager.png'), img.toPNG());
    say('      截图：screenshot-pager.png');

    // ---------- 搜索 ----------
    say('\n[5] 搜索结果分页（咪咕搜索接口固定每页 20 条）');
    await win.webContents.executeJavaScript(
      `(()=>{const i=document.getElementById('searchInput'); i.value='周杰伦';
         document.getElementById('searchBtn').click(); return 1})()`,
      true
    );
    await wait(8000);
    const s1 = JSON.parse(await win.webContents.executeJavaScript(SNAP('#searchList'), true));
    say('      ' + JSON.stringify(s1));
    if (s1.rows === 20) ok('搜索结果每页 20 首（接口固定值）');
    else bad('搜索结果每页异常：' + s1.rows);
    if (s1.pager) ok('搜索结果有分页控件：' + s1.totalText);
    else bad('搜索结果缺少分页');

    say('\n[5b] 搜索翻到第 2 页');
    await win.webContents.executeJavaScript(
      `(()=>{const b=[...document.querySelectorAll('.pager .pg-num')].find(e=>e.textContent==='2');
         if(b) b.click(); return 1})()`,
      true
    );
    await wait(8000);
    const s2 = JSON.parse(await win.webContents.executeJavaScript(SNAP('#searchList'), true));
    say('      ' + JSON.stringify(s2));
    if (s2.firstIdx === '21') ok('搜索第 2 页序号从 21 开始');
    else bad('搜索翻页序号异常：' + s2.firstIdx);

    say('\n[6] 榜单分页');
    await win.webContents.executeJavaScript(
      `(()=>{document.querySelector('.nav-item[data-view="ranks"]').click();return 1})()`,
      true
    );
    await wait(6000);
    await win.webContents.executeJavaScript(
      `(()=>{document.querySelector('.grid .card').click();return 1})()`,
      true
    );
    await wait(8000);
    const r1 = JSON.parse(await win.webContents.executeJavaScript(SNAP('#rankList'), true));
    say('      ' + JSON.stringify(r1));
    if (r1.rows > 0 && r1.rows <= 20) ok(`榜单每页 ≤20 首（本页 ${r1.rows} 首，共 ${r1.totalText.replace(/.*共 /, '')}）`);
    else bad('榜单分页异常：' + r1.rows);
  } catch (e) {
    bad('异常 ' + (e && e.stack ? e.stack : e));
  }

  say('\n=== ' + (failed ? failed + ' 项失败' : '分页验证通过') + ' ===');
  try {
    win.destroy();
  } catch {}
  app.exit(failed ? 1 : 0);
});
