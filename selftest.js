/**
 * 端到端自检：electron selftest.js
 * 依次验证 搜索 / 排行榜 / 榜单歌曲 / 取播放直链 / 界面加载，最后退出。
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const USER_DATA = path.join(__dirname, '.userdata');
fs.mkdirSync(USER_DATA, { recursive: true });
app.setPath('userData', USER_DATA);

// Windows 下 GUI 进程的 stdout 可能不连通，同时写入日志文件
const LOG_FILE = path.join(__dirname, 'selftest-output.txt');
try {
  fs.writeFileSync(LOG_FILE, '');
} catch {}
const _log = console.log.bind(console);
console.log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : require('util').inspect(x))).join(' ');
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
  _log(line);
};

const api = require('./src/migu-api');
const { registerIpc } = require('./src/ipc');

let failed = 0;
const ok = (m) => console.log('  [PASS] ' + m);
const bad = (m) => {
  failed++;
  console.log('  [FAIL] ' + m);
};

async function main() {
  // 复用与正式应用相同的 IPC 层（登录相关用桩实现）
  registerIpc({
    getAuthState: () => ({ loggedIn: false, nickname: '', avatar: '', userId: '' }),
    login: async () => ({ ok: true }),
    logout: async () => ({ ok: true }),
    confirmLogin: async () => ({ ok: true }),
  });

  console.log('=== 咪咕音乐客户端 自检 ===\n');

  console.log('[1] 搜索接口');
  let songs = [];
  try {
    const r = await api.search('晴天', 1, 10);
    songs = r.songs || [];
    if (songs.length) {
      ok(`搜索到 ${songs.length} 首`);
      console.log('      例：', songs[0].name, '-', songs[0].artists.join('/'), '| contentId=' + songs[0].contentId, '| cover=' + (songs[0].cover ? '有' : '无'));
    } else bad('搜索无结果');
  } catch (e) {
    bad('搜索异常 ' + e.message);
  }

  console.log('\n[2] 排行榜列表');
  let ranks = [];
  try {
    ranks = await api.rankIndex();
    if (ranks.length) ok(`${ranks.length} 个榜单，例：${ranks[0].name}`);
    else bad('榜单为空');
  } catch (e) {
    bad('榜单异常 ' + e.message);
  }

  console.log('\n[3] 榜单歌曲');
  let rankSongs = [];
  if (ranks.length) {
    try {
      const d = await api.rankSongs(ranks[0].rankId);
      rankSongs = d.songs || [];
      if (rankSongs.length) {
        ok(`《${d.title}》共 ${rankSongs.length} 首`);
        rankSongs.slice(0, 3).forEach((s, i) =>
          console.log(`      ${i + 1}. ${s.name} - ${s.artists.join('/')} ${s.vip ? '[VIP]' : ''} ${s.duration}s`)
        );
      } else bad('榜单歌曲为空');
    } catch (e) {
      bad('榜单歌曲异常 ' + e.message);
    }
  }

  console.log('\n[4] 今日推荐');
  try {
    const t = await api.todayRecommend();
    if (t.songs.length) ok(`${t.date} 推荐 ${t.songs.length} 首，例：${t.songs[0].name}`);
    else bad('今日推荐为空');
  } catch (e) {
    bad('今日推荐异常 ' + e.message);
  }

  console.log('\n[5] 播放直链解析');
  const pool = [...rankSongs, ...songs];
  let played = 0;
  for (const s of pool.slice(0, 12)) {
    try {
      const r = await api.songUrl(s, { tone: 'PQ' });
      if (r.url) {
        ok(`可播放：${s.name} - ${s.artists.join('/')} [${r.tone}]`);
        console.log('      ' + r.url.slice(0, 110) + '…');
        played++;
        if (played >= 3) break;
      } else {
        console.log(`      · 不可播（${s.name}）尝试过 ${r.tried.join(',')}`);
      }
    } catch (e) {
      console.log('      ! ' + s.name + ' 异常 ' + e.message);
    }
  }
  if (!played) bad('没有任何歌曲取到播放直链');

  console.log('\n[6] 歌词');
  try {
    const withLyric = [...songs, ...rankSongs].find((s) => s.lyricUrl);
    if (withLyric) {
      const lrc = await api.lyric(withLyric.lyricUrl);
      if (lrc && lrc.length > 10) ok(`歌词拉取成功 ${lrc.length} 字节`);
      else bad('歌词内容为空');
    } else console.log('      · 结果中没有带歌词地址的歌曲，跳过');
  } catch (e) {
    bad('歌词异常 ' + e.message);
  }

  console.log('\n[7] 界面渲染与在线播放');

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (win, name) => {
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, name), img.toPNG());
      console.log('      截图：' + name);
    } catch (e) {
      console.log('      截图失败 ' + e.message);
    }
  };

  await new Promise((resolve) => {
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
    const errors = [];
    win.webContents.on('console-message', (e) => {
      const lvl = e.level ?? '';
      if (String(lvl) === '3' || String(lvl) === 'error') errors.push(e.message || '');
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => errors.push('did-fail-load ' + code + ' ' + desc));

    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      try {
        win.destroy();
      } catch {}
      resolve();
    };

    win.webContents.once('did-finish-load', async () => {
      try {
        await wait(4500);
        const info = JSON.parse(
          await win.webContents.executeJavaScript(
            `JSON.stringify({nav:document.querySelectorAll('.nav-item').length,title:document.querySelector('.page-title')?document.querySelector('.page-title').textContent:'',rows:document.querySelectorAll('.song-row').length,cards:document.querySelectorAll('.card').length,empty:document.querySelector('.empty')?document.querySelector('.empty').textContent:''})`,
            true
          )
        );
        if (info.nav >= 3 && (info.rows > 0 || info.cards > 0))
          ok(`首页渲染正常：「${info.title}」歌曲行 ${info.rows} · 榜单卡片 ${info.cards}`);
        else bad('首页内容为空 ' + JSON.stringify(info));
        await shot(win, 'screenshot-home.png');

        // 通过界面搜索
        await win.webContents.executeJavaScript(
          `(()=>{document.getElementById('searchInput').value='茶汤';document.getElementById('searchBtn').click();return 1})()`,
          true
        );
        await wait(4000);
        const srows = await win.webContents.executeJavaScript(`document.querySelectorAll('#searchList .song-row').length`, true);
        if (srows > 0) ok(`搜索结果渲染 ${srows} 行`);
        else bad('搜索结果未渲染');

        // 双击第一首，走完整播放链路
        await win.webContents.executeJavaScript(
          `(()=>{const r=document.querySelector('#searchList .song-row');if(r)r.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));return 1})()`,
          true
        );
        await wait(5000);
        const st = JSON.parse(
          await win.webContents.executeJavaScript(
            `JSON.stringify({t:document.getElementById('audio').currentTime,hasSrc:!!document.getElementById('audio').src,now:document.getElementById('nowName').textContent,artist:document.getElementById('nowArtist').textContent,playing:!document.getElementById('audio').paused,dur:document.getElementById('audio').duration,err:document.getElementById('audio').error?document.getElementById('audio').error.code:null})`,
            true
          )
        );
        if (st.t > 0.5)
          ok(`界面播放成功：《${st.now}》- ${st.artist}，已播放 ${st.t.toFixed(1)}s / ${Math.round(st.dur || 0)}s，正在播放=${st.playing}`);
        else bad('界面点击后未出声 ' + JSON.stringify(st));
        await shot(win, 'screenshot-playing.png');

        // 序号 / ♪ 标记切换（回归：暂停后 ♪ 必须变回序号）
        const readIdx = () =>
          win.webContents.executeJavaScript(
            `(()=>{const e=document.querySelector('#searchList .song-row.playing .s-idx');return e?e.textContent.trim():'(none)'})()`,
            true
          );
        const idxPlaying = await readIdx();
        await win.webContents.executeJavaScript(`(()=>{document.getElementById('audio').pause();return 1})()`, true);
        await wait(900);
        const idxPaused = await readIdx();
        await win.webContents.executeJavaScript(`(()=>{document.getElementById('audio').play();return 1})()`, true);
        await wait(900);
        const idxResumed = await readIdx();
        const qIdx = await win.webContents.executeJavaScript(
          `(()=>{const e=document.querySelector('#queueList .queue-item.playing .qi-idx');return e?e.textContent.trim():'(none)'})()`,
          true
        );
        if (idxPlaying === '♪' && idxPaused === '1' && idxResumed === '♪' && qIdx === '♪')
          ok(`序号标记可正确来回切换：播放=${idxPlaying} → 暂停=${idxPaused} → 再播放=${idxResumed}（队列=${qIdx}）`);
        else
          bad(`序号标记切换异常：播放=${idxPlaying} 暂停=${idxPaused} 再播放=${idxResumed} 队列=${qIdx}`);

        // 回归：双击一首歌不应产生「播放失败」误报（曾因 click/dblclick 重复触发播放）
        await win.webContents.executeJavaScript(
          `(()=>{
             window.__toasts = [];
             const el = document.getElementById('toast');
             new MutationObserver(() => {
               const t = (el.textContent || '').trim();
               if (el.classList.contains('show') && t && window.__toasts[window.__toasts.length-1] !== t) {
                 window.__toasts.push(t);
               }
             }).observe(el, { attributes: true, childList: true, subtree: true, characterData: true });
             return 1;
           })()`,
          true
        );
        await win.webContents.executeJavaScript(
          `(()=>{
             const r = document.querySelectorAll('#searchList .song-row')[1];
             if (!r) return 0;
             r.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
             r.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
             r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
             return 1;
           })()`,
          true
        );
        await wait(8000);
        const dblInfo = JSON.parse(
          await win.webContents.executeJavaScript(
            `JSON.stringify({ toasts: window.__toasts || [], now: document.getElementById('nowName').textContent, t: document.getElementById('audio').currentTime, playing: !document.getElementById('audio').paused })`,
            true
          )
        );
        const badToast = (dblInfo.toasts || []).find((t) => /播放失败|加载失败/.test(t));
        if (!badToast && dblInfo.t > 0.5)
          ok(`双击播放无错误弹窗：《${dblInfo.now}》已播放 ${dblInfo.t.toFixed(1)}s，提示=${JSON.stringify(dblInfo.toasts)}`);
        else
          bad(`双击仍有误报：${JSON.stringify(dblInfo)}`);

        if (errors.length) bad('渲染层错误：' + errors.slice(0, 3).join(' | '));
        else ok('渲染层无 JS 错误');
      } catch (e) {
        bad('界面检查异常 ' + e.message);
      }
      done();
    });

    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    setTimeout(done, 60000);
  });

  console.log('\n=== 结果：' + (failed ? failed + ' 项失败' : '全部通过') + ' ===');
  app.exit(failed ? 1 : 0);
}

app.whenReady().then(() =>
  main().catch((e) => {
    console.error('自检崩溃：', e);
    app.exit(2);
  })
);
