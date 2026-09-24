/**
 * 「清除缓存」验证
 *
 * 覆盖：设置面板的入口与占用显示、确认框的取消/确定两条分支、缓存确实被清掉，
 * 以及最要紧的一点 —— 清缓存绝不能碰到登录态。
 *
 * 两个坑，测试必须绕开，否则会误报：
 *  1. 页面一加载就会自己产生十几 MB 真实缓存，所以「占用总量」不能当判据 ——
 *     改用测试自己造的假缓存文件在不在；
 *  2. 页面运行时应用自己会刷新 Cookie 与 localStorage 里的登录令牌，
 *     所以登录态基线必须在页面加载**之后**记录，否则对比的是「加载前 vs 清理后」。
 *
 * 运行：electron test-cache.js
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { app, BrowserWindow } = require('electron');

// 用带登录态的副本跑，这样才能真正验证「清缓存不掉登录」
const { prepareUserData } = require('./test-util');
const UD = prepareUserData('.userdata-cache');
app.setPath('userData', UD);

const cache = require('./src/cache');
const { registerIpc } = require('./src/ipc');

const OUT = path.join(__dirname, 'test-cache-output.txt');
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

/** 清缓存绝不该碰到的文件/目录 —— 动了任何一个就等于掉登录 */
const KEEP = [
  'Network/Cookies',
  'Local Storage/leveldb',
  'Local State',
  'login/auth.json',
  'login/pacmtoken.bak',
  'settings.json',
];

/**
 * 造一点假缓存，用来验证清理确实动了它们。
 * GPUCache / Dawn* 会被运行中的 Chromium 立刻锁住、写不进去，这很正常 ——
 * 它们本身就有 Chromium 生成的缓存，照样参与统计与清理。
 */
function makeFakeCache(rel, sizeKB) {
  const p = path.join(UD, rel);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x'.repeat(sizeKB * 1024));
    return true;
  } catch {
    return false;
  }
}

/**
 * 文件或目录的内容摘要：前后不一致就说明被动过。
 * Cookie 这类 SQLite 文件在 Chromium 运行时是打不开的，这时退化成用文件大小比对 ——
 * 只要清理没碰它，大小就不会变。
 */
function digest(rel) {
  const p = path.join(UD, rel);
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      const files = fs.readdirSync(p).sort();
      if (!files.length) return null;
      const h = crypto.createHash('sha1');
      for (const f of files) {
        h.update(f);
        const fp = path.join(p, f);
        try {
          h.update(fs.readFileSync(fp));
        } catch {
          try {
            h.update('size:' + fs.statSync(fp).size);
          } catch {
            h.update('gone');
          }
        }
      }
      return h.digest('hex');
    }
    try {
      return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    } catch {
      return 'size:' + st.size; // 被占用读不到，用大小兜底
    }
  } catch {
    return null;
  }
}

const kb = (b) => (b / 1024).toFixed(1) + ' KB';

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
    // ---------- 1. 设置面板入口 ----------
    say('[1] 设置面板里的入口');
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    await wait(6500);
    await win.webContents.executeJavaScript(
      `(()=>{document.getElementById('settingsBtn').click();return 1})()`,
      true
    );
    await wait(1500);

    const ui = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({
           hasBtn: !!document.getElementById('cleanCacheBtn'),
           label: (document.getElementById('cleanCacheBtn')||{}).textContent || '',
           stats: (document.getElementById('cacheStatsText')||{}).textContent || ''
         })`,
        true
      )
    );
    say('      ' + JSON.stringify(ui));
    if (ui.hasBtn) ok(`设置里有「${ui.label}」按钮`);
    else bad('设置里没有清除缓存按钮');
    if (/占用/.test(ui.stats)) ok('显示当前占用：' + ui.stats);
    else bad('没有显示缓存占用：' + ui.stats);

    // ---------- 2. 登录态基线（必须在页面加载完之后记） ----------
    say('\n[2] 记下登录态基线（页面已加载完，令牌刷新已发生）');
    await wait(2500); // 让解析器把 pacmtoken 写进 localStorage 的动作落定
    const base = KEEP.map((f) => [f, digest(f)]);
    const missing = base.filter(([, d]) => d === null).map(([f]) => f);
    if (missing.length) bad('测试副本里缺了这些登录态文件：' + missing.join(', '));
    else ok(`已记录 ${KEEP.length} 项：Cookie / 令牌 / 密钥 / 票据 / 设置`);

    // ---------- 3. 造缓存 ----------
    say('\n[3] 造出假缓存，验证统计');
    const made = [
      ['Cache/Cache_Data/f_000001', 400],
      ['Cache/Cache_Data/data_0', 200],
      ['Code Cache/js/index', 300],
      ['GPUCache/data_1', 120],
      ['DawnGraphiteCache/dawn', 60],
    ].filter(([rel, size]) => makeFakeCache(rel, size));

    // 这些文件就是「有没有真的清掉」的判据
    const fakePaths = made.map(([rel]) => path.join(UD, rel));
    const fakeAlive = () => fakePaths.filter((p) => fs.existsSync(p)).length;
    const httpFakes = made.filter(([rel]) => rel.startsWith('Cache/')).map(([rel]) => path.join(UD, rel));
    const codeFakes = made
      .filter(([rel]) => rel.startsWith('Code Cache/'))
      .map(([rel]) => path.join(UD, rel));

    const st = cache.stats();
    say(
      `      写入 ${made.length}/${5} 个假缓存文件，统计到 ${kb(st.bytes)}：` +
        st.items.map((i) => `${i.name} ${kb(i.bytes)}`).join(' / ')
    );
    if (fakePaths.length) ok(`假缓存文件就位（${fakePaths.length} 个）`);
    else bad('一个假缓存都没造出来，后续判断不可靠');
    if (st.bytes >= 500 * 1024) ok('缓存统计能算出占用');
    else bad('缓存统计偏小：' + st.bytes);
    if (st.items.length) ok('按目录列出占用：' + st.items.map((i) => i.name).join(', '));
    else bad('没有列出任何缓存目录');

    // ---------- 4. 取消分支 ----------
    say('\n[4] 点了清除后取消 —— 不该动任何东西');
    await win.webContents.executeJavaScript(
      `(()=>{document.getElementById('cleanCacheBtn').click();return 1})()`,
      true
    );
    await wait(600);
    const popped = await win.webContents.executeJavaScript(
      `document.getElementById('confirmMask').classList.contains('show')`,
      true
    );
    const confirmText = await win.webContents.executeJavaScript(
      `document.getElementById('confirmText').textContent`,
      true
    );
    if (popped) ok('弹出了确认框：' + confirmText.slice(0, 26) + '…');
    else bad('没有弹确认框');

    await win.webContents.executeJavaScript(
      `(()=>{document.getElementById('confirmCancel').click();return 1})()`,
      true
    );
    await wait(900);
    if (fakeAlive() === fakePaths.length) ok(`取消后 ${fakePaths.length} 个缓存文件一个没少`);
    else bad(`取消却删掉了缓存：只剩 ${fakeAlive()}/${fakePaths.length}`);

    // ---------- 5. 确认分支 ----------
    say('\n[5] 确认清除');
    const beforeClear = cache.stats();
    await win.webContents.executeJavaScript(
      `(()=>{document.getElementById('cleanCacheBtn').click();return 1})()`,
      true
    );
    await wait(600);
    await win.webContents.executeJavaScript(
      `(()=>{document.getElementById('confirmOk').click();return 1})()`,
      true
    );
    await wait(2500);

    const after = cache.stats();
    const toast = await win.webContents.executeJavaScript(
      `document.getElementById('toast').textContent`,
      true
    );
    const aliveRest = fakePaths.filter((p) => fs.existsSync(p));
    say(
      `      占用 ${kb(beforeClear.bytes)} -> ${kb(after.bytes)}，` +
        `假缓存剩 ${aliveRest.length}/${fakePaths.length}` +
        (aliveRest.length ? `（${aliveRest.map((p) => path.basename(p)).join(', ')}）` : '') +
        `，提示：${toast}`
    );
    // HTTP 缓存走 clearCache()，一定清得掉；代码缓存目录常被 Chromium 锁住，
    // 删不掉时只要如实报了「使用中」就算正确
    const aliveHttp = httpFakes.filter((p) => fs.existsSync(p));
    const aliveCode = codeFakes.filter((p) => fs.existsSync(p));
    if (!aliveHttp.length) ok(`${httpFakes.length} 个 HTTP 缓存文件已清掉`);
    else bad(`还有 ${aliveHttp.length} 个 HTTP 缓存文件没清掉`);
    if (!aliveCode.length) ok('代码缓存文件也已清掉');
    else if (/使用中/.test(toast))
      ok(`代码缓存目录被占用删不掉（残留 ${aliveCode.length} 个），已如实提示「使用中」`);
    else bad('代码缓存没清掉，而且没有如实说明');

    if (after.bytes < beforeClear.bytes) ok(`占用确实下降（少了 ${kb(beforeClear.bytes - after.bytes)}）`);
    else bad('占用没有下降');
    // 剩下的残留必须是被运行中的 Chromium 锁住的那种，而且已经如实告诉了用户
    if (!aliveRest.length) ok('所有假缓存文件都已清掉');
    else if (/使用中/.test(toast)) ok(`残留 ${aliveRest.length} 个在被占用的目录里，已如实提示`);
    else bad('有缓存文件残留，却没有如实说明');
    if (/缓存/.test(toast)) ok('弹出结果提示：' + toast);
    else bad('没有结果提示');
    if (/登录/.test(confirmText)) ok('确认框里说明了不会影响登录');
    else bad('确认框没说明对登录的影响');

    // ---------- 6. 最关键：登录态 ----------
    say('\n[6] 最关键：登录态必须原样保留');
    const changed = base.filter(([f, d]) => digest(f) !== d).map(([f]) => f);
    if (!changed.length) ok(`${KEEP.length} 项登录态/设置内容完全未变（含 Cookie 与登录令牌）`);
    else bad('清缓存动到了不该动的东西：' + changed.join(', '));

    // ---------- 7. 连清两次 ----------
    say('\n[7] 连清两次不该出问题');
    const again = await win.webContents.executeJavaScript(`window.migu.cacheClear()`, true);
    if (again && again.ok)
      ok('第二次清理也正常返回' + (again.pending > 0 ? `（残留 ${kb(again.pending)}，使用中的属正常）` : ''));
    else bad('第二次清理异常：' + JSON.stringify(again));

    // 截图失败不该算功能失败
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, 'screenshot-cache.png'), img.toPNG());
      say('      截图：screenshot-cache.png');
    } catch (e) {
      say('      （截图跳过：' + ((e && e.message) || e) + '）');
    }
  } catch (e) {
    bad('异常 ' + (e && e.stack ? e.stack : e));
  }

  say('\n=== ' + (failed ? failed + ' 项失败' : '清除缓存验证通过') + ' ===');
  try {
    win.destroy();
  } catch {}
  app.exit(failed ? 1 : 0);
});
