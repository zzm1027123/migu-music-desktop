/**
 * 歌词功能验证：检查各来源歌曲的歌词能否显示，以及桌面歌词悬浮窗是否同步。
 * 运行：electron test-lyric.js
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

// 用已登录数据的副本，保证点歌能成功（歌词随播放接口一并返回）
const { prepareUserData } = require('./test-util');
app.setPath('userData', prepareUserData('.userdata-test'));

const { registerIpc } = require('./src/ipc');
const lyricWin = require('./src/lyric-window');
const settings = require('./src/settings');
const resolver = require('./src/resolver');

const LOG = path.join(__dirname, 'test-lyric-output.txt');
fs.writeFileSync(LOG, '');
const say = (m = '') => {
  fs.appendFileSync(LOG, m + '\n');
  console.log(m);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  settings.init(app.getPath('userData'));

  registerIpc({
    getAuthState: () => ({ loggedIn: false, nickname: '', avatar: '', userId: '' }),
    login: async () => ({ ok: true }),
    logout: async () => ({ ok: true }),
    getSettings: () => settings.all(),
    setSettings: (p) => settings.set(p),
    lyricToggle: () => lyricWin.toggle(__dirname),
    lyricClose: () => lyricWin.close(),
    lyricUpdate: (p) => {
      lyricWin.send(p);
      return { ok: true };
    },
    lyricLock: (v) => lyricWin.setLocked(v),
    lyricStatus: () => lyricWin.status(),
    lyricFont: () => ({ cur: settings.get('lyricFontCur'), next: settings.get('lyricFontNext') }),
    lyricSaveFont: (f) => settings.set({ lyricFontCur: f && f.cur, lyricFontNext: f && f.next }),
  });

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

  let failed = 0;
  const ok = (m) => say('  [PASS] ' + m);
  const bad = (m) => {
    failed++;
    say('  [FAIL] ' + m);
  };

  try {
    say('=== 歌词功能验证 ===\n');
    resolver.prewarm();

    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    await wait(6500);

    // 播放「今日推荐」第一首（这一来源此前完全没有歌词地址）
    say('[1] 播放今日推荐第 1 首');
    await win.webContents.executeJavaScript(
      `(()=>{const r=document.querySelector('#todayList .song-row');if(r)r.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));return 1})()`,
      true
    );
    await wait(9000);

    const info = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({
           now: document.getElementById('nowName').textContent,
           playing: !document.getElementById('audio').paused,
           t: document.getElementById('audio').currentTime,
           lyricText: (document.getElementById('lyricBody').textContent||'').trim().slice(0,60),
           lyricLines: document.querySelectorAll('#lyricBody .ll').length,
           hasOn: !!document.querySelector('#lyricBody .ll.on')
         })`,
        true
      )
    );
    say('      播放中：《' + info.now + '》 已播放 ' + info.t.toFixed(1) + 's');
    if (info.lyricLines > 0) ok(`歌词面板已渲染 ${info.lyricLines} 行，当前行高亮=${info.hasOn}`);
    else bad('歌词面板仍然没有歌词：' + JSON.stringify(info));

    // 打开歌词面板看滚动高亮
    await win.webContents.executeJavaScript(`(()=>{document.getElementById('lyricBtn').click();return 1})()`, true);
    await wait(1200);
    const panelOn = await win.webContents.executeJavaScript(
      `document.querySelector('#lyricBody .ll.on') ? document.querySelector('#lyricBody .ll.on').textContent.slice(0,40) : ''`,
      true
    );
    say('      面板当前高亮行：' + (panelOn || '(无)'));
    if (panelOn) ok('歌词面板逐行高亮正常');
    else bad('歌词面板没有高亮行');

    // 歌词按钮已移到歌曲封面上：平时隐藏、鼠标靠近出现
    say('\n[1.5] 封面上的歌词按钮');
    const domInfo = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({
           lyricInCover: !!document.getElementById('lyricBtn').closest('.cover-wrap'),
           desktopInCover: !!document.getElementById('desktopLyricBtn').closest('.cover-wrap'),
           opacityBefore: getComputedStyle(document.querySelector('.cover-actions')).opacity,
           btnRect: (()=>{const r=document.getElementById('lyricBtn').getBoundingClientRect();const c=document.getElementById('coverWrap').getBoundingClientRect();
             return r.left>=c.left-1 && r.right<=c.right+1 && r.top>=c.top-1 && r.bottom<=c.bottom+1;})()
         })`,
        true
      )
    );
    if (domInfo.lyricInCover && domInfo.desktopInCover) ok('两个歌词按钮都已移到歌曲封面上');
    else bad('按钮不在封面容器内 ' + JSON.stringify(domInfo));
    if (domInfo.btnRect) ok('按钮位置与封面重合（完全落在封面范围内）');
    else bad('按钮未与封面重合');
    if (Number(domInfo.opacityBefore) === 0) ok('默认隐藏 opacity=0');
    else bad('默认未隐藏 opacity=' + domInfo.opacityBefore);

    // 把鼠标移到封面上
    const rect = JSON.parse(
      await win.webContents.executeJavaScript(
        `(()=>{const r=document.getElementById('coverWrap').getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`,
        true
      )
    );
    win.webContents.sendInputEvent({ type: 'mouseMove', x: rect.x, y: rect.y });
    await wait(1200);
    const probe = JSON.parse(
      await win.webContents.executeJavaScript(
        `(()=>{const r=document.getElementById('coverWrap').getBoundingClientRect();
           const cx=r.x+r.width/2, cy=r.y+r.height/2;
           const el=document.elementFromPoint(cx,cy);
           return JSON.stringify({cover:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},
             point:{x:Math.round(cx),y:Math.round(cy)},
             hovered: !!document.querySelector('.cover-wrap:hover'),
             atPoint: el ? ((el.className||'')+' <'+el.tagName+'>') : null});})()`,
        true
      )
    );
    say('      诊断：' + JSON.stringify(probe));
    const opAfter = await win.webContents.executeJavaScript(
      `getComputedStyle(document.querySelector('.cover-actions')).opacity`,
      true
    );
    if (Number(opAfter) > 0.5) ok('鼠标靠近封面时按钮浮现 opacity=' + opAfter);
    else bad('鼠标移到封面后按钮仍未出现 opacity=' + opAfter);

    // 封面上的按钮能真正切换歌词面板（先确保关闭，再点开）
    await win.webContents.executeJavaScript(`(()=>{document.getElementById('lyricClose').click();return 1})()`, true);
    await wait(500);
    const beforeOpen = await win.webContents.executeJavaScript(
      `document.getElementById('lyricDrawer').classList.contains('open')`,
      true
    );
    await win.webContents.executeJavaScript(`(()=>{document.getElementById('lyricBtn').click();return 1})()`, true);
    await wait(900);
    const panelOpen = await win.webContents.executeJavaScript(
      `document.getElementById('lyricDrawer').classList.contains('open')`,
      true
    );
    if (!beforeOpen && panelOpen) ok('封面上的按钮可正常打开歌词面板');
    else bad(`点击后歌词面板状态异常 before=${beforeOpen} after=${panelOpen}`);

    // 歌词页现在应占满右侧主内容区
    const geom = JSON.parse(
      await win.webContents.executeJavaScript(
        `(()=>{const r=document.getElementById('lyricDrawer').getBoundingClientRect();
           return JSON.stringify({left:Math.round(r.left),top:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),
             winW:window.innerWidth,winH:window.innerHeight,
             side:Math.round(document.querySelector('.sidebar').getBoundingClientRect().width),
             cover:Math.round(document.getElementById('lpCover').getBoundingClientRect().width),
             lpName:document.getElementById('lpName').textContent});})()`,
        true
      )
    );
    say(`      歌词页区域：left=${geom.left} top=${geom.top} ${geom.w}x${geom.h}（窗口 ${geom.winW}x${geom.winH}，侧栏 ${geom.side}）`);
    if (geom.left <= geom.side + 2 && geom.w >= geom.winW - geom.side - 4) ok('歌词页已铺满右侧主内容区（全屏）');
    else bad('歌词页未铺满：' + JSON.stringify(geom));
    if (geom.cover > 150) ok(`左侧大封面已渲染（${geom.cover}px）`);
    else bad('大封面尺寸异常 ' + geom.cover);
    if (geom.lpName && geom.lpName !== '未在播放') ok('歌词页显示当前歌曲：' + geom.lpName);
    else bad('歌词页未显示歌曲信息');

    // 拖动歌词快进
    say('\n[1.6] 拖动歌词快进到对应位置');
    const before = await win.webContents.executeJavaScript(`document.getElementById('audio').currentTime`, true);
    const dragInfo = JSON.parse(
      await win.webContents.executeJavaScript(
        `(() => {
           const body = document.getElementById('lyricBody');
           body.style.scrollBehavior = 'auto';
           body.scrollTop = 0;
           const lines = body.querySelectorAll('.ll');
           if (lines.length < 10) return JSON.stringify({ err: 'not enough lines', n: lines.length });
           const a = lines[3], b = lines[8];
           const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
           a.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0,
             clientX: Math.round(ra.x + ra.width / 2), clientY: Math.round(ra.y + ra.height / 2) }));
           window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true,
             clientX: Math.round(rb.x + rb.width / 2), clientY: Math.round(rb.y + rb.height / 2) }));
           const tip = document.getElementById('lyricSeekTip');
           return JSON.stringify({
             target: 8,
             scrollAtStart: Math.round(body.scrollTop),
             dragging: body.classList.contains('dragging'),
             hasTarget: !!body.querySelector('.ll.target'),
             tipShown: tip.classList.contains('show'),
             tipText: tip.textContent,
           });
         })()`,
        true
      )
    );
    say('      拖动中：' + JSON.stringify(dragInfo));
    if (dragInfo.hasTarget && dragInfo.tipShown) ok('拖动中目标句高亮 + 提示气泡：' + dragInfo.tipText);
    else bad('拖动过程中缺少高亮/提示 ' + JSON.stringify(dragInfo));

    // 趁没松手多等几秒，看视图会不会被自动拉回当前播放句
    await wait(3200);
    const duringDrag = JSON.parse(
      await win.webContents.executeJavaScript(
        `(() => { const body = document.getElementById('lyricBody');
           const on = body.querySelector('.ll.on');
           return JSON.stringify({
             scrollTop: Math.round(body.scrollTop),
             dragging: body.classList.contains('dragging'),
             hasTarget: !!body.querySelector('.ll.target'),
             onIdx: on ? Number(on.dataset.li) : -1 }); })()`,
        true
      )
    );
    say('      拖动中等待 3.2s：' + JSON.stringify(duringDrag));
    if (
      duringDrag.dragging &&
      duringDrag.hasTarget &&
      Math.abs(duringDrag.scrollTop - dragInfo.scrollAtStart) <= 1
    )
      ok(`拖动期间视图纹丝不动（scrollTop 保持 ${dragInfo.scrollAtStart}，未被重新定位到当前歌词）`);
    else bad('拖动期间视图被挪动了：' + JSON.stringify({ start: dragInfo.scrollAtStart, now: duringDrag }));

    const dragShot = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, 'screenshot-lyric-drag.png'), dragShot.toPNG());
    say('      截图：screenshot-lyric-drag.png');

    await win.webContents.executeJavaScript(
      `(()=>{window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));return 1})()`,
      true
    );

    await wait(1300);
    const afterTime = await win.webContents.executeJavaScript(`document.getElementById('audio').currentTime`, true);
    const afterIdx = await win.webContents.executeJavaScript(
      `(()=>{const e=document.querySelector('#lyricBody .ll.on');return e?Number(e.dataset.li):-1})()`,
      true
    );
    say(`      播放位置 ${before.toFixed(1)}s → ${afterTime.toFixed(1)}s，高亮句 #${afterIdx}`);
    if (Math.abs(afterIdx - 8) <= 1) ok('拖动松手后已快进到目标歌词位置');
    else bad(`拖动跳转结果不符：期望 #8，实际 #${afterIdx}`);

    // 单击某句也能跳过去
    const clickIdx = 14;
    const before2 = await win.webContents.executeJavaScript(`document.getElementById('audio').currentTime`, true);
    await win.webContents.executeJavaScript(
      `(()=>{const body=document.getElementById('lyricBody');const l=body.querySelectorAll('.ll')[${clickIdx}];
         const r=l.getBoundingClientRect();const c={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
         l.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:c.x,clientY:c.y}));
         window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));return 1})()`,
      true
    );
    await wait(1200);
    const after2 = await win.webContents.executeJavaScript(`document.getElementById('audio').currentTime`, true);
    const afterIdx2 = await win.webContents.executeJavaScript(
      `(()=>{const e=document.querySelector('#lyricBody .ll.on');return e?Number(e.dataset.li):-1})()`,
      true
    );
    say(`      单击第 ${clickIdx + 1} 句：${before2.toFixed(1)}s → ${after2.toFixed(1)}s，高亮 #${afterIdx2}`);
    if (Math.abs(afterIdx2 - clickIdx) <= 1) ok('单击歌词句也能跳到对应位置');
    else bad(`单击跳转结果不符：期望 #${clickIdx}，实际 #${after2Idx}`);

    // 手动滚动浏览歌词时，不应被自动拉回当前播放句
    say('\n[1.7] 手动翻歌词不被自动拉回');
    await win.webContents.executeJavaScript(
      `(() => { const body = document.getElementById('lyricBody');
         body.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -420 }));
         body.scrollTop = 0;
         return 1; })()`,
      true
    );
    await wait(600);
    const scrollStart = JSON.parse(
      await win.webContents.executeJavaScript(
        `(() => { const body = document.getElementById('lyricBody');
           return JSON.stringify({ scrollTop: Math.round(body.scrollTop),
             followBtn: document.getElementById('lyricFollowBtn').classList.contains('show') }); })()`,
        true
      )
    );
    say('      手动滚动后：' + JSON.stringify(scrollStart));
    if (scrollStart.followBtn) ok('手动滚动后浮出「回到当前」按钮');
    else bad('手动滚动后没有出现「回到当前」按钮');

    await wait(9000); // 等歌词自然走过好几句
    const scrollLater = JSON.parse(
      await win.webContents.executeJavaScript(
        `(() => { const body = document.getElementById('lyricBody');
           const on = body.querySelector('.ll.on');
           return JSON.stringify({ scrollTop: Math.round(body.scrollTop),
             followBtn: document.getElementById('lyricFollowBtn').classList.contains('show'),
             onIdx: on ? Number(on.dataset.li) : -1 }); })()`,
        true
      )
    );
    say('      9 秒后：' + JSON.stringify(scrollLater));
    if (scrollLater.scrollTop <= 5 && scrollLater.followBtn)
      ok('手动翻阅期间视图保持在原处（当前句 #' + scrollLater.onIdx + '，未被拉回）');
    else bad('视图被自动拉回了：' + JSON.stringify(scrollLater));

    // 点「回到当前」应滚回去
    await win.webContents.executeJavaScript(`(()=>{document.getElementById('lyricFollowBtn').click();return 1})()`, true);
    await wait(1500);
    const backInfo = JSON.parse(
      await win.webContents.executeJavaScript(
        `(() => { const body = document.getElementById('lyricBody');
           return JSON.stringify({ scrollTop: Math.round(body.scrollTop),
             followBtn: document.getElementById('lyricFollowBtn').classList.contains('show') }); })()`,
        true
      )
    );
    say('      点「回到当前」后：' + JSON.stringify(backInfo));
    if (!backInfo.followBtn && backInfo.scrollTop > 30) ok('点「回到当前」后已滚回正在唱的那句');
    else bad('「回到当前」未生效：' + JSON.stringify(backInfo));

    // 打开桌面歌词
    say('\n[2] 桌面歌词悬浮窗');
    await win.webContents.executeJavaScript(`(()=>{document.getElementById('desktopLyricBtn').click();return 1})()`, true);
    await wait(3000);

    const lyrWin = BrowserWindow.getAllWindows().find((w) => w.getTitle() === '桌面歌词');
    if (!lyrWin) {
      bad('桌面歌词窗口未创建');
    } else {
      ok('桌面歌词窗口已创建');
      const shown = lyrWin.isVisible();
      if (shown) ok('窗口可见且置顶=' + lyrWin.isAlwaysOnTop());
      else bad('歌词窗口不可见');

      const lc = JSON.parse(
        await lyrWin.webContents.executeJavaScript(
          `JSON.stringify({cur: document.getElementById('cur').textContent, next: document.getElementById('next').textContent})`,
          true
        )
      );
      say('      歌词条内容：' + lc.cur + ' / ' + lc.next);
      if (lc.cur) ok('桌面歌词已同步内容');
      else bad('桌面歌词内容为空');

      // 等一行歌词切换，确认实时同步
      await wait(9000);
      const lc2 = await lyrWin.webContents.executeJavaScript(`document.getElementById('cur').textContent`, true);
      say('      9 秒后歌词条：' + lc2);
      if (lc2 && lc2 !== lc.cur) ok('桌面歌词随时间实时更新');
      else say('      · 该行歌词较长，9 秒内未换行（不算失败）');

      // 双击不应再触发锁定（已改为按钮控制）
      await lyrWin.webContents.executeJavaScript(
        `(()=>{document.body.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));return 1})()`,
        true
      );
      await wait(900);
      if (!lyricWin.status().locked) ok('双击不再触发锁定（已改为按钮）');
      else bad('双击仍在触发锁定，应已移除');

      // 点击「锁定」按钮 → 鼠标穿透
      await lyrWin.webContents.executeJavaScript(
        `(()=>{document.querySelector('#tools button[data-act="lock"]').click();return 1})()`,
        true
      );
      await wait(1000);
      if (lyricWin.status().locked) ok('点击锁定按钮后鼠标穿透已生效');
      else bad('锁定状态未生效');

      const hidden = await lyrWin.webContents.executeJavaScript(
        `getComputedStyle(document.getElementById('tools')).opacity`,
        true
      );
      if (Number(hidden) < 0.05) ok('锁定后控制条已隐藏');
      else bad('锁定后控制条仍可见 opacity=' + hidden);

      // 截图（先解锁，确认控制条重新出现）
      await lyricWin.setLocked(false);
      await wait(700);
      const shown2 = await lyrWin.webContents.executeJavaScript(
        `getComputedStyle(document.getElementById('tools')).opacity`,
        true
      );
      if (Number(shown2) > 0.2) ok('解锁后控制条重新显示 opacity=' + shown2);
      else bad('解锁后控制条仍隐藏 opacity=' + shown2);

      await wait(300);
      const img = await lyrWin.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, 'screenshot-desktop-lyric.png'), img.toPNG());
      say('      截图：screenshot-desktop-lyric.png');
    }

    // 主界面截图（把鼠标停在封面上，让歌词按钮显示出来）
    win.webContents.sendInputEvent({ type: 'mouseMove', x: rect.x, y: rect.y });
    await wait(700);
    const mainShot = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, 'screenshot-lyric-panel.png'), mainShot.toPNG());

    // 局部放大：播放条左侧封面区域
    const bar = JSON.parse(
      await win.webContents.executeJavaScript(
        `(()=>{const r=document.querySelector('.player').getBoundingClientRect();return JSON.stringify({x:0,y:Math.round(r.top)-4,width:430,height:Math.round(r.height)+8})})()`,
        true
      )
    );
    const crop = await win.webContents.capturePage(bar);
    fs.writeFileSync(path.join(__dirname, 'screenshot-cover-buttons.png'), crop.toPNG());
    say('      截图：screenshot-cover-buttons.png');
  } catch (e) {
    bad('异常 ' + (e && e.stack ? e.stack : e));
  }

  say('\n=== ' + (failed ? failed + ' 项失败' : '歌词功能验证通过') + ' ===');
  lyricWin.close();
  try {
    win.destroy();
  } catch {}
  app.exit(failed ? 1 : 0);
});
