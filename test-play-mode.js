/**
 * 播放模式图标的验证
 *
 * 起因：随机播放和列表循环用了同一个「环绕箭头」，光看图标分不出来。
 * 期望：三种模式各自的图标互不相同，随机播放用的是交叉箭头。
 *
 * 运行：electron test-play-mode.js
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const { prepareUserData } = require('./test-util');
app.setPath('userData', prepareUserData('.userdata-mode'));

const { registerIpc } = require('./src/ipc');
const logger = require('./src/logger');
logger.init(app.getPath('userData'));

const OUT = path.join(__dirname, 'test-mode-output.txt');
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

  /** 当前模式图标的关键信息 */
  const iconNow = () =>
    js(`(()=>{const svg=document.getElementById('modeIcon');
      const btn=document.getElementById('modeBtn');
      const p=svg?svg.querySelector('path'):null;
      const d=p?p.getAttribute('d'):'';
      return JSON.stringify({
        html: svg ? svg.innerHTML : '',
        paths: svg ? svg.querySelectorAll('path').length : 0,
        texts: svg ? svg.querySelectorAll('text').length : 0,
        subpaths: (d.match(/[Mm]/g) || []).length,
        title: btn ? btn.title : ''
      })})()`);

  try {
    say('=== 播放模式图标验证 ===\n');
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    await wait(6500);

    say('[1] 默认是列表循环');
    const list0 = JSON.parse(await iconNow());
    say('      提示：' + list0.title + '，path 数：' + list0.paths);
    if (/列表循环/.test(list0.title)) ok('按钮提示写明当前模式：' + list0.title);
    else bad('按钮提示不对：' + list0.title);
    if (list0.paths === 1 && list0.texts === 0) ok('列表循环 = 单个箭头，没有数字');
    else bad(`列表循环图标结构异常：path=${list0.paths} text=${list0.texts}`);

    say('\n[2] 点一下 → 单曲循环');
    await js(`document.getElementById('modeBtn').click()`);
    await wait(700);
    const single = JSON.parse(await iconNow());
    say('      提示：' + single.title + '，path 数：' + single.paths + '，text 数：' + single.texts);
    if (/单曲循环/.test(single.title)) ok('提示变成「单曲循环」');
    else bad('提示不对：' + single.title);
    if (single.texts === 1) ok('带一个数字标记（和列表循环区分开）');
    else bad('单曲循环没有数字标记');

    say('\n[3] 再点一下 → 随机播放');
    await js(`document.getElementById('modeBtn').click()`);
    await wait(700);
    const random = JSON.parse(await iconNow());
    say('      提示：' + random.title + '，path 数：' + random.paths);
    if (/随机播放/.test(random.title)) ok('提示变成「随机播放」');
    else bad('提示不对：' + random.title);

    // 此刻确实处于随机播放，截图确认新图标（放到这里而不是最后，避免中途被切回列表循环）
    try {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      await wait(800);
      fs.writeFileSync(path.join(__dirname, 'screenshot-mode-random.png'), (await win.webContents.capturePage()).toPNG());
      say('      截图：screenshot-mode-random.png');
      const crop = await win.webContents.capturePage({ x: 900, y: 650, width: 320, height: 104 });
      fs.writeFileSync(path.join(__dirname, 'screenshot-mode-crop.png'), crop.toPNG());
      say('      截图：screenshot-mode-crop.png（播放条右侧）');
    } catch (e) {
      say('      （截图跳过：' + ((e && e.message) || e) + '）');
    }

    say('\n[4] 三个图标必须两两不同（正是这次要修的问题）');
    const sameAsList = random.html === list0.html;
    const sameAsSingle = random.html === single.html;
    if (!sameAsList) ok('随机播放的图标 ≠ 列表循环的图标（问题已修复）');
    else bad('随机播放和列表循环还是同一个图标');
    if (!sameAsSingle) ok('随机播放的图标 ≠ 单曲循环的图标');
    else bad('随机播放和单曲循环撞图标了');
    if (list0.html !== single.html) ok('列表循环与单曲循环也各不相同');
    else bad('列表循环和单曲循环撞图标了');

    say('\n[5] 随机播放应当是多段的交叉箭头');
    // 交叉箭头是「一个 <path>、多段子路径」的画法，所以数 d 里的起点命令而不是 path 元素个数
    say(`      列表循环子路径数=${list0.subpaths}，随机播放子路径数=${random.subpaths}`);
    if (random.subpaths > list0.subpaths) {
      ok(`随机图标段数（${random.subpaths}）多于环绕箭头（${list0.subpaths}），是交叉箭头的画法`);
    } else {
      bad(`随机图标只有 ${random.subpaths} 段子路径，不比环绕箭头复杂，不像交叉箭头`);
    }
    if (random.texts === 0) ok('随机图标不带数字');
    else bad('随机图标混进了数字');
    if (!random.html.includes('M7 7h10v3l4-4-4-4v3H5v6h2z')) ok('确实没有复用环绕箭头的路径');
    else bad('随机图标里还有环绕箭头那段路径');

    say('\n[6] 转一圈应回到列表循环');
    await js(`document.getElementById('modeBtn').click()`);
    await wait(700);
    const back = JSON.parse(await iconNow());
    if (back.html === list0.html && /列表循环/.test(back.title)) ok('三个模式循环切换正常');
    else bad('循环切换后没有回到列表循环');
  } catch (e) {
    bad('异常 ' + (e && e.stack ? e.stack : e));
  }

  say('\n=== ' + (failed ? failed + ' 项失败' : '播放模式图标验证通过') + ' ===');
  try {
    win.destroy();
  } catch {}
  app.exit(failed ? 1 : 0);
});
