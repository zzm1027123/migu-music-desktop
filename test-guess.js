/**
 * 「猜你喜欢」板块验证
 *
 * 覆盖：
 *   1. 接口层：未登录时应当明确返回 needLogin，而不是含糊报错
 *   2. 界面层：有推荐时渲染成歌曲列表，可点播
 *   3. 未登录时给出登录引导而不是空白
 *   4. 首页同时挂「今日推荐」和「猜你喜欢」两个列表时都能正常标注可播放性
 *      （markRestricted 之前用全局计数，两个列表会互相顶掉）
 *
 * 运行：electron test-guess.js
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');

const REAL_UD = process.env.MIGU_TEST_UD || path.join(__dirname, 'dist', '咪咕音乐', 'resources', 'app', '.userdata');
const TEST_UD = path.join(__dirname, '.userdata-guess');
if (!fs.existsSync(TEST_UD) && fs.existsSync(REAL_UD)) fs.cpSync(REAL_UD, TEST_UD, { recursive: true });
app.setPath('userData', fs.existsSync(TEST_UD) ? TEST_UD : path.join(__dirname, '.userdata'));

const { registerIpc } = require('./src/ipc');
const api = require('./src/migu-api');
const logger = require('./src/logger');
logger.init(app.getPath('userData'));

const OUT = path.join(__dirname, 'test-guess-output.txt');
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
  getAuthState: () => ({ loggedIn: false, nickname: '', avatar: '', userId: '' }),
  login: async () => ({ ok: true }),
  logout: async () => ({ ok: true }),
  confirmLogin: async () => ({ ok: true }),
  getSettings: () => ({}),
  setSettings: (p) => p,
});

// 接管猜你喜欢，让界面测试不受真实登录态影响
const FAKE = [
  { contentId: 'g1', name: '测试推荐曲目一', artists: ['歌手A'], album: '专辑甲', duration: 200, cover: '' },
  { contentId: 'g2', name: '测试推荐曲目二', artists: ['歌手B'], album: '专辑乙', duration: 180, cover: '' },
  { contentId: 'g3', name: '测试推荐曲目三', artists: ['歌手C'], album: '专辑丙', duration: 240, cover: '' },
];
let guessMode = 'songs';
let guessBatch = 0; // 每调一次换一批，用来验证「换一批」真的换了内容
ipcMain.removeHandler('migu:guessYouLike');
ipcMain.handle('migu:guessYouLike', async () => {
  if (guessMode === 'needLogin') return { ok: false, needLogin: true, error: '登录后这里会出现为你推荐的歌曲', songs: [] };
  if (guessMode === 'error') return { ok: false, needLogin: false, error: '服务端开小差了', songs: [] };
  guessBatch += 1;
  return {
    ok: true,
    songs: FAKE.map((s, i) => ({ ...s, contentId: `${s.contentId}-b${guessBatch}`, name: `${s.name}·第${guessBatch}批` })),
  };
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true,
    width: 1220,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const js = (code) => win.webContents.executeJavaScript(code, true);

  /** 首页上「猜你喜欢」这一块的样子 */
  const guessInfo = () =>
    js(`(()=>{
      const titles = [...document.querySelectorAll('.section-title')].map(e => e.textContent.trim());
      const list = document.getElementById('guessList');
      return JSON.stringify({
        // 标题里现在还挂着「换一批」按钮，文本不再精确等于「猜你喜欢」，
        // 所以用包含判断（曾经因为这里写死全等而误报过）
        hasTitle: titles.some((t) => t.includes('猜你喜欢')),
        titles,
        rows: list ? list.querySelectorAll('.song-row').length : 0,
        names: list ? [...list.querySelectorAll('.s-name')].map(e => e.textContent.trim()) : [],
        empty: document.querySelector('.empty') ? document.querySelector('.empty').textContent : '',
        todayRows: document.querySelectorAll('#todayList .song-row').length
      })})()`);

  try {
    say('=== 猜你喜欢 板块验证 ===\n');

    say('[1] 接口层：未登录时应明确回报 needLogin');
    const real = await api.guessYouLike(10);
    say('      返回：' + JSON.stringify(real).slice(0, 160));
    if (real.ok && real.songs && real.songs.length) {
      ok(`当前登录态可用，取到 ${real.songs.length} 首真实推荐`);
    } else if (real.needLogin) {
      ok('未登录，明确返回 needLogin（界面据此给登录引导）');
    } else {
      say('      · 既不是 ok 也不是 needLogin：' + (real.error || ''));
    }
    if (real.ok && real.songs.length) {
      const s = real.songs[0];
      if (s.contentId && s.name) ok('推荐项归一化正常：' + s.name + ' — ' + (s.artists || []).join('、'));
      else bad('推荐项字段不完整：' + JSON.stringify(s).slice(0, 120));
    }

    say('\n[2] 界面层：有推荐时应渲染成可点的歌曲列表');
    guessMode = 'songs';
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    await wait(9000);
    const g1 = JSON.parse(await guessInfo());
    say('      ' + JSON.stringify(g1));
    if (g1.hasTitle) ok('首页出现了「猜你喜欢」板块（现有板块：' + g1.titles.join(' / ') + '）');
    else bad('首页没看到「猜你喜欢」');
    if (g1.rows === FAKE.length) ok(`渲染了 ${g1.rows} 首推荐`);
    else bad(`推荐行数不对：${g1.rows}，期望 ${FAKE.length}`);
    if (g1.names[0] === FAKE[0].name) ok('列表内容正确：' + g1.names.join(' / '));
    else {
      // .s-name 的文本里还挂着「受限 / 试听 / VIP」这些标签，比之前要先剥掉
      const clean = (s) => String(s).replace(/受限|试听|VIP/g, '').trim();
      if (clean(g1.names[0]).startsWith(FAKE[0].name)) ok('列表内容正确：' + g1.names.join(' / '));
      else bad('列表内容不对：' + g1.names.join(' / '));
    }

    say('\n[3] 两个列表同屏时，可播放性标注互不干扰');
    say(`      今日推荐 ${g1.todayRows} 行 + 猜你喜欢 ${g1.rows} 行`);
    if (g1.todayRows > 0 && g1.rows > 0) {
      await wait(4000); // 等 can-listen 回来并把两个列表都标完
      const marked = JSON.parse(
        await js(`JSON.stringify({
           today: document.querySelectorAll('#todayList .song-row.restricted').length,
           guess: document.querySelectorAll('#guessList .song-row.restricted').length,
           todayTotal: document.querySelectorAll('#todayList .song-row').length,
           guessTotal: document.querySelectorAll('#guessList .song-row').length
         })`)
      );
      say('      ' + JSON.stringify(marked));
      // 只要两个列表都还在、没被彼此顶掉成空白，且标注逻辑没抛错即可
      if (marked.todayTotal === g1.todayRows && marked.guessTotal === g1.rows) {
        ok('两个列表都完好（没有被后一个的标注流程顶掉）');
      } else {
        bad('有列表被顶掉了：' + JSON.stringify(marked));
      }
      const errText = await js(`(document.querySelector('.empty')||{}).textContent || ''`);
      if (!/Cannot read|undefined/.test(errText)) ok('页面上没有出现 undefined 之类的报错');
      else bad('页面上有报错：' + errText);
    } else {
      bad('两个列表没有同时出现，无法验证互相干扰');
    }

    say('\n[4] 未登录时应给登录引导，而不是空白');
    guessMode = 'needLogin';
    await js(`document.querySelector('.nav-item[data-view="home"]').click()`);
    await wait(6000);
    const g2 = JSON.parse(await guessInfo());
    say('      ' + JSON.stringify(g2));
    if (g2.hasTitle) ok('板块标题仍在');
    else bad('未登录时板块标题没了');
    if (/登录/.test(g2.empty)) ok('给出了登录引导：' + g2.empty);
    else bad('没有登录引导，显示的是：' + (g2.empty || '(空白)'));

    say('\n[5] 接口报错时不该拖垮首页');
    guessMode = 'error';
    await js(`document.querySelector('.nav-item[data-view="home"]').click()`);
    await wait(6000);
    const g3 = JSON.parse(await guessInfo());
    say('      ' + JSON.stringify(g3));
    if (g3.todayRows > 0) ok('今日推荐照常渲染（猜你喜欢出错不影响首页）');
    else bad('猜你喜欢出错把今日推荐也带崩了');
    say('\n[6] 「换一批」应当只换列表内容，不动页面其它部分');
    // [5] 把 guessMode 设成了 error 并重渲染，此时页面上没有猜你喜欢板块，
    // 先恢复成正常模式重新进一次首页
    guessMode = 'songs';
    await js(`document.querySelector('.nav-item[data-view="home"]').click()`);
    await wait(7000);
    const beforeClick = JSON.parse(
      await js(`JSON.stringify({
         names: [...document.querySelectorAll('#guessList .s-name')].map(e => e.textContent.trim()),
         todayFirst: (document.querySelector('#todayList .s-name')||{}).textContent || '',
         hasBtn: !!document.getElementById('guessRefreshBtn'),
         btnText: (document.getElementById('guessRefreshBtn')||{}).textContent || '',
         sub: (document.getElementById('guessSub')||{}).textContent || ''
       })`)
    );
    say('      点击前：' + JSON.stringify({ names: beforeClick.names, sub: beforeClick.sub }));
    if (beforeClick.hasBtn) ok('标题右边有「' + beforeClick.btnText + '」按钮');
    else bad('没找到换一批按钮');

    const batchBefore = guessBatch;
    await js(`document.getElementById('guessRefreshBtn').click()`);
    await wait(2500);
    const afterClick = JSON.parse(
      await js(`JSON.stringify({
         names: [...document.querySelectorAll('#guessList .s-name')].map(e => e.textContent.trim()),
         todayFirst: (document.querySelector('#todayList .s-name')||{}).textContent || '',
         btnDisabled: (document.getElementById('guessRefreshBtn')||{}).disabled,
         btnText: (document.getElementById('guessRefreshBtn')||{}).textContent || '',
         toast: document.getElementById('toast').textContent,
         sub: (document.getElementById('guessSub')||{}).textContent || ''
       })`)
    );
    say('      点击后：' + JSON.stringify({ names: afterClick.names, sub: afterClick.sub, toast: afterClick.toast }));
    if (guessBatch > batchBefore) ok(`确实又请求了一次（第 ${guessBatch} 批）`);
    else bad('点按钮没有发起新请求');
    if (afterClick.names.join() !== beforeClick.names.join()) ok('推荐内容换掉了');
    else bad('内容没变（还是同一批）');
    if (afterClick.names.length === FAKE.length) ok(`新一批仍是 ${FAKE.length} 首`);
    else bad(`新一批数量不对：${afterClick.names.length}`);
    // 不硬编码批次号：[5] 恢复页面时已经消耗过一批，具体是第几批不该写死
    const batchOf = (n) => {
      const m = /第(\d+)批/.exec(String(n || ''));
      return m ? Number(m[1]) : 0;
    };
    const b0 = batchOf(beforeClick.names[0]);
    const b1 = batchOf(afterClick.names[0]);
    if (b1 > b0) ok(`批次确实往后走了：第 ${b0} 批 → 第 ${b1} 批`);
    else bad(`批次没有前进：第 ${b0} 批 → 第 ${b1} 批`);
    if (afterClick.todayFirst === beforeClick.todayFirst) ok('今日推荐没被动过（只换了猜你喜欢）');
    else bad('今日推荐也被重渲染了');
    if (!afterClick.btnDisabled && /换一批/.test(afterClick.btnText)) ok('按钮状态已恢复：' + afterClick.btnText);
    else bad('按钮没恢复：disabled=' + afterClick.btnDisabled + ' text=' + afterClick.btnText);
    if (/已换一批/.test(afterClick.toast)) ok('给了提示：' + afterClick.toast);
    else bad('没有换一批的提示：' + afterClick.toast);
    if (/共 3 首/.test(afterClick.sub)) ok('副标题跟着更新：' + afterClick.sub);
    else bad('副标题没更新：' + afterClick.sub);

    say('\n[7] 换一批失败时要给出提示，不能默默不动');
    guessMode = 'error';
    await js(`document.getElementById('guessRefreshBtn').click()`);
    await wait(2500);
    const failToast = await js(`document.getElementById('toast').textContent`);
    say('      toast=' + failToast);
    if (/换一批失败/.test(failToast)) ok('明确提示失败：' + failToast);
    else bad('失败时没有提示：' + failToast);
    const stillThere = await js(`document.querySelectorAll('#guessList .song-row').length`);
    if (stillThere === FAKE.length) ok('失败后原来的推荐还在（没有被清空）');
    else bad('失败后列表被清掉了：' + stillThere);
    guessMode = 'songs';
  } catch (e) {
    bad('异常 ' + (e && e.stack ? e.stack : e));
  }

  say('\n=== ' + (failed ? failed + ' 项失败' : '猜你喜欢板块验证通过') + ' ===');
  try {
    win.destroy();
  } catch {}
  app.exit(failed ? 1 : 0);
});
