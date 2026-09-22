/* 咪咕音乐 PC 客户端 —— 渲染层逻辑 */
'use strict';

const $ = (s) => document.querySelector(s);
const view = $('#view');
const audio = $('#audio');

/** 列表统一每页 20 首 */
const PAGE_SIZE = 20;

const state = {
  view: 'home',
  tone: 'PQ',
  mode: 'list', // list | single | random
  queue: [],
  qIndex: -1,
  current: null,
  playing: false,
  lyricLines: [],
  lyricIndex: -1,
  seeking: false,
  ranks: [],
  lastRank: null,
  failStreak: 0,
  playToken: 0, // 每次点歌自增；旧流程被取代后不再产生任何提示
  playEngineReady: false,
  currentSrcKey: '',
  desktopLyricOpen: false,
  dragging: false, // 是否正在拖动歌词选段
  follow: true, // 歌词是否自动跟随当前播放位置
};

/* ------------------------------------------------------------ 小工具 */

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

let toastTimer = null;
function toast(msg, ms = 2400) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

const loadingHtml = (t = '加载中…') => `<div class="loading"><div class="spinner"></div>${t}</div>`;
const emptyHtml = (t = '这里空空如也') => `<div class="empty">${t}</div>`;

const PLACEHOLDER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#232840"/><text x="40" y="46" font-size="26" text-anchor="middle" fill="#4b5476" font-family="sans-serif">♪</text></svg>`
  );

/* --------------------------------------------------------- 歌曲渲染 */

function songRowsHtml(songs, startIndex = 0, opts = {}) {
  const removable = !!opts.removable;
  return songs
    .map((s, i) => {
      const idx = startIndex + i;
      const isCur = state.current && s.contentId && s.contentId === state.current.contentId;
      const dur = s.duration ? fmtTime(s.duration) : '--:--';
      return `<div class="song-row${isCur ? ' playing' : ''}" data-i="${i}" data-n="${idx + 1}">
        <div class="s-idx">${isCur && state.playing ? '<span class="eq">♪</span>' : idx + 1}</div>
        <img class="s-cover" src="${esc(s.cover || PLACEHOLDER)}" onerror="this.src='${PLACEHOLDER}'" alt="">
        <div class="s-name">${esc(s.name)}${s.vip ? '<span class="tag-vip">VIP</span>' : ''}</div>
        <div class="s-artist">${esc((s.artists || []).join('、'))}</div>
        <div class="s-album">${esc(s.album || '')}</div>
        <div class="s-dur">${dur}</div>
        <div class="s-act">
          <button class="mini-act add-pl" title="加入歌单">
            <svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>
          </button>
          ${
            removable
              ? `<button class="mini-act remove-pl" title="从这个歌单移出">
            <svg viewBox="0 0 24 24"><path d="M5 11h14v2H5z"/></svg>
          </button>`
              : ''
          }
        </div>
      </div>`;
    })
    .join('');
}

let markToken = 0;

/**
 * 用官方 can-listen 接口批量标注受限曲目，
 * 让用户在点歌之前就知道哪些歌当前账号放不了。
 */
async function markRestricted(container, songs) {
  if (!window.migu.canListen) return;
  const ids = songs.map((s) => s.contentId).filter(Boolean).slice(0, 60);
  if (!ids.length) return;
  const token = ++markToken;
  let map = {};
  try {
    map = await window.migu.canListen(ids);
  } catch {
    return;
  }
  if (token !== markToken || !document.body.contains(container)) return;

  container.querySelectorAll('.song-row').forEach((row) => {
    const s = songs[Number(row.dataset.i)];
    if (!s) return;
    const info = map[s.contentId];
    if (!info) return;
    const nameEl = row.querySelector('.s-name');
    if (!info.canListen) {
      row.classList.add('restricted');
      row.title = '当前账号无法播放（会员 / 版权限制）';
      if (nameEl && !nameEl.querySelector('.tag-lock')) {
        const t = document.createElement('span');
        t.className = 'tag-lock';
        t.textContent = '受限';
        nameEl.appendChild(t);
      }
    } else if (info.limitLength) {
      row.classList.add('trial');
      row.title = '当前账号仅可试听片段';
      if (nameEl && !nameEl.querySelector('.tag-trial')) {
        const t = document.createElement('span');
        t.className = 'tag-trial';
        t.textContent = '试听';
        nameEl.appendChild(t);
      }
    }
  });
}

/** 绑定歌曲列表点击（事件委托）
 *  opts.onPlay 可覆盖默认播放行为（歌单页要在播放后补全整个歌单） */
function bindSongList(container, songs, opts = {}) {
  const doPlay = opts.onPlay || ((list, i) => playAt(list, i));
  container._songs = songs; // 行序号/播放标记要靠它反查歌曲
  container.querySelectorAll('.song-row').forEach((row) => {
    row.addEventListener('dblclick', () => {
      // 关键：双击时必须取消单击留下的延迟播放，
      // 否则会先后启动两条播放流程，后一条打断前一条的 play() 并弹出“播放失败”
      clearTimeout(row._t);
      doPlay(songs, Number(row.dataset.i));
    });
    row.addEventListener('click', (e) => {
      // 点的是行内小按钮就别触发播放
      if (e.target.closest && e.target.closest('.s-act')) return;
      if (e.detail !== 1) return; // 双击的第二下不重复触发
      clearTimeout(row._t);
      row._t = setTimeout(() => doPlay(songs, Number(row.dataset.i)), 220);
    });
    const addBtn = row.querySelector('.add-pl');
    if (addBtn) {
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const s = songs[Number(row.dataset.i)];
        if (s) openPlaylistPicker(s);
      });
    }
    const rmBtn = row.querySelector('.remove-pl');
    if (rmBtn && opts.onRemove) {
      rmBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const s = songs[Number(row.dataset.i)];
        if (s) opts.onRemove(s, songs);
      });
    }
  });
  markRestricted(container, songs);
}

/* ----------------------------------------------------------- 视图渲染 */

async function renderHome() {
  state.view = 'home';
  setNav('home');
  view.innerHTML = loadingHtml('正在加载推荐内容…');
  try {
    const [today, ranks] = await Promise.all([window.migu.today(), window.migu.ranks()]);
    state.ranks = ranks || [];

    let html = '';
    if (today.songs && today.songs.length) {
      html += `<div class="page-title">今日推荐</div>
        <div class="page-sub">${esc(today.date || '')} · 共 ${today.songs.length} 首 · 点击任意歌曲开始播放</div>`;
      html += `<div class="section-title">歌曲列表</div><div class="song-list" id="todayList">${songRowsHtml(today.songs)}</div>`;
    }

    if (state.ranks.length) {
      html += `<div class="section-title">排行榜</div><div class="grid" id="rankGrid">`;
      html += state.ranks
        .slice(0, 12)
        .map(
          (r) => `<div class="card" data-rank="${esc(r.rankId)}">
            <div class="c-cover"><img src="${esc(r.cover || PLACEHOLDER)}" onerror="this.src='${PLACEHOLDER}'" alt="">
              <div class="c-play"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
            </div>
            <div class="c-name">${esc(r.name)}</div>
            <div class="c-sub">${esc(r.group || '排行榜')}</div>
          </div>`
        )
        .join('');
      html += `</div>`;
    }

    view.innerHTML = html || emptyHtml('暂无推荐内容');

    const tl = $('#todayList');
    if (tl) bindSongList(tl, today.songs);

    view.querySelectorAll('.card[data-rank]').forEach((c) =>
      c.addEventListener('click', () => renderRankDetail(c.dataset.rank))
    );
  } catch (e) {
    view.innerHTML = emptyHtml('加载失败：' + esc(e.message));
  }
}

async function renderRanks() {
  state.view = 'ranks';
  setNav('ranks');
  view.innerHTML = loadingHtml();
  try {
    const ranks = state.ranks.length ? state.ranks : await window.migu.ranks();
    state.ranks = ranks;
    view.innerHTML =
      `<div class="page-title">排行榜</div><div class="page-sub">共 ${ranks.length} 个榜单 · 点击查看歌曲</div>` +
      `<div class="grid">` +
      ranks
        .map(
          (r) => `<div class="card" data-rank="${esc(r.rankId)}">
            <div class="c-cover"><img src="${esc(r.cover || PLACEHOLDER)}" onerror="this.src='${PLACEHOLDER}'" alt="">
              <div class="c-play"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
            </div>
            <div class="c-name">${esc(r.name)}</div>
            <div class="c-sub">${esc(r.group || '')}</div>
          </div>`
        )
        .join('') +
      `</div>`;
    view.querySelectorAll('.card[data-rank]').forEach((c) =>
      c.addEventListener('click', () => renderRankDetail(c.dataset.rank))
    );
  } catch (e) {
    view.innerHTML = emptyHtml('加载失败：' + esc(e.message));
  }
}

async function renderRankDetail(rankId, pageNo = 1) {
  state.view = 'rankDetail';
  view.innerHTML = loadingHtml('正在加载榜单歌曲…');
  try {
    const data = await window.migu.rankSongs(rankId, pageNo, PAGE_SIZE);
    state.lastRank = data;
    const start = (data.page - 1) * data.pageSize;
    view.innerHTML =
      `<div class="back-bar"><button class="back-btn" id="backBtn">← 返回排行榜</button></div>
       <div class="page-title">${esc(data.title || '榜单')}</div>
       <div class="page-sub">共 ${data.total} 首 · 每页 ${data.pageSize} 首 · 双击立即播放</div>
       <div class="song-list" id="rankList">${songRowsHtml(data.songs, start)}</div>
       ${pagerHtml(data.page, data.totalPages, data.total)}`;
    $('#backBtn').addEventListener('click', renderRanks);
    bindSongList($('#rankList'), data.songs);
    bindPager(view, (p) => {
      view.scrollTop = 0;
      renderRankDetail(rankId, p);
    });
  } catch (e) {
    view.innerHTML = emptyHtml('加载失败：' + esc(e.message));
  }
}

async function renderSearch(kw, pageNo = 1) {
  state.view = 'search';
  setNav('search');
  view.innerHTML = loadingHtml(`正在搜索“${esc(kw)}”…`);
  try {
    const data = await window.migu.search(kw, pageNo, PAGE_SIZE);
    const songs = data.songs || [];
    if (!songs.length) {
      view.innerHTML =
        `<div class="page-title">搜索结果</div><div class="page-sub">关键词：${esc(kw)}</div>` +
        emptyHtml('没有找到相关歌曲');
      return;
    }
    const start = (data.page - 1) * data.pageSize;
    view.innerHTML =
      `<div class="page-title">搜索结果</div>
       <div class="page-sub">关键词：${esc(kw)} · 共 ${data.total} 首 · 每页 ${data.pageSize} 首（咪咕搜索接口固定每页 20）· 单击/双击播放</div>
       <div class="song-list" id="searchList">${songRowsHtml(songs, start)}</div>
       ${pagerHtml(data.page, data.totalPages, data.total)}`;
    bindSongList($('#searchList'), songs);
    bindPager(view, (p) => {
      view.scrollTop = 0;
      renderSearch(kw, p);
    });
  } catch (e) {
    view.innerHTML = emptyHtml('搜索失败：' + esc(e.message));
  }
}

/* ------------------------------------------------------------ 播放器 */

function setNav(v) {
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === v));
}

function updateQueueUi() {
  $('#queueCount').textContent = state.queue.length;
  const box = $('#queueList');
  if (!state.queue.length) {
    box.innerHTML = '<div class="queue-empty">列表为空</div>';
    return;
  }
  box.innerHTML = state.queue
    .map((s, i) => {
      const cur = state.current && s.contentId === state.current.contentId;
      return `<div class="queue-item${cur ? ' playing' : ''}" data-qi="${i}">
        <span class="qi-idx">${cur && state.playing ? '♪' : i + 1}</span>
        <span class="qi-name">${esc(s.name)} - ${esc((s.artists || []).join('、'))}</span>
      </div>`;
    })
    .join('');
  box.querySelectorAll('.queue-item').forEach((el) =>
    el.addEventListener('click', () => {
      const i = Number(el.dataset.qi);
      playQueueIndex(i);
    })
  );
}

function setPlayIcon(playing) {
  $('#playIcon').innerHTML = playing
    ? '<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>'
    : '<path d="M8 5v14l11-7z"/>';
  state.playing = playing;
  refreshRowIndicators();
  refreshQueueIndicators();
}

/**
 * 刷新歌曲行的「序号 / 播放中 ♪」标记。
 *
 * 注意：序号必须按行所对应的歌曲重新算出来。
 * 早先的实现是「暂停时把 innerHTML 还原成当前文本」——而此刻文本已经是 ♪，
 * 于是 ♪ 永远变不回序号。行元素上的 data-n 保存了原始序号，用它还原才可靠。
 */
function refreshRowIndicators() {
  document.querySelectorAll('.song-list').forEach((list) => {
    const songs = list._songs || [];
    list.querySelectorAll('.song-row').forEach((row) => {
      const i = Number(row.dataset.i);
      const s = songs[i];
      const isCur = !!(s && state.current && s.contentId === state.current.contentId);
      row.classList.toggle('playing', isCur);
      const idxEl = row.querySelector('.s-idx');
      if (!idxEl) return;
      idxEl.innerHTML =
        isCur && state.playing ? '<span class="eq">♪</span>' : esc(row.dataset.n || String(i + 1));
    });
  });
}

/** 刷新左侧播放队列的序号 / 播放中标记 */
function refreshQueueIndicators() {
  const box = $('#queueList');
  if (!box) return;
  box.querySelectorAll('.queue-item').forEach((el) => {
    const i = Number(el.dataset.qi);
    const s = state.queue[i];
    const isCur = !!(s && state.current && s.contentId === state.current.contentId);
    el.classList.toggle('playing', isCur);
    const idxEl = el.querySelector('.qi-idx');
    if (idxEl) idxEl.textContent = isCur && state.playing ? '♪' : String(i + 1);
  });
}

function updateNowPlaying(song) {
  const artists = song ? (song.artists || []).join('、') || '未知歌手' : '';
  $('#nowName').textContent = song ? song.name : '未在播放';
  $('#nowArtist').textContent = song ? artists : '选择一首歌开始';

  const bg = song && song.cover ? `url("${song.cover}")` : 'none';
  $('#nowCover').style.backgroundImage = bg;

  // 全屏歌词页左侧的大封面与歌曲信息
  const lpCover = $('#lpCover');
  if (lpCover) lpCover.style.backgroundImage = bg;
  const lpName = $('#lpName');
  if (lpName) lpName.textContent = song ? song.name : '未在播放';
  const lpArtist = $('#lpArtist');
  if (lpArtist) lpArtist.textContent = song ? artists : '选择一首歌开始';
}

/** 把歌曲加入播放队列（去重），返回其在队列中的下标 */
function enqueue(song) {
  const i = state.queue.findIndex((s) => s.contentId && s.contentId === song.contentId);
  if (i >= 0) return i;
  state.queue.push(song);
  updateQueueUi();
  return state.queue.length - 1;
}

/** 播放某个列表的第 i 首：整列表替换为播放队列 */
async function playAt(songs, i) {
  if (!songs || !songs[i]) return;
  state.queue = songs.slice();
  updateQueueUi();
  await playQueueIndex(i);
}

async function playQueueIndex(i) {
  const song = state.queue[i];
  if (!song) return;

  // 给这次点歌编号：一旦用户又点了别的歌，本次流程就静默作废，
  // 不再弹提示、不再跳下一首（避免"播放失败"误报）
  const token = ++state.playToken;

  state.qIndex = i;
  state.current = song;
  updateNowPlaying(song);
  updateQueueUi();
  refreshRowIndicators();
  loadLyric(song);

  // 首次点歌要等解析器把咪咕网页版拉起来，给个反馈免得用户以为没反应
  if (!state.playEngineReady) toast('正在准备播放引擎，首次约需 1~3 秒…', 2200);

  try {
    const res = await window.migu.songUrl(song, { tone: state.tone });
    if (token !== state.playToken) return;

    if (!res || !res.url) {
      state.failStreak += 1;
      const why = (res && res.info) || '该歌曲当前无法播放';
      if (state.failStreak >= 3) {
        toast(`${why}（已连续 ${state.failStreak} 首不可播，停止自动跳过）`, 4200);
        setPlayIcon(false);
        return;
      }
      toast(`${why}，自动跳过`);
      setTimeout(() => nextSong(true), 900);
      return;
    }

    state.playEngineReady = true;
    state.failStreak = 0;
    if (res.tone && res.tone !== state.tone) toast(`已降级为 ${res.tone} 音质播放`);

    // 榜单/推荐等列表接口不带歌词，播放接口返回的 lrcUrl 才是可靠来源
    if (res.lrcUrl && res.lrcUrl !== song.lyricUrl) {
      song.lyricUrl = res.lrcUrl;
      loadLyric(song);
    }

    state.currentSrcKey = res.url;
    audio.src = res.url;
    audio.volume = Number($('#volume').value) / 100;

    try {
      await audio.play();
    } catch (e) {
      // 切歌时 play() 被新的加载请求打断是正常现象，不应提示
      const msg = String((e && e.message) || e || '');
      if ((e && e.name === 'AbortError') || /interrupted|aborted/i.test(msg)) return;
      throw e;
    }

    if (token !== state.playToken) return;
    setPlayIcon(true);
  } catch (e) {
    if (token !== state.playToken) return;
    toast('播放失败：' + (e.message || e));
  }
}

function nextSong(auto = false) {
  if (!state.queue.length) return;
  let i;
  if (state.mode === 'random') {
    i = Math.floor(Math.random() * state.queue.length);
  } else {
    i = state.qIndex + 1;
    if (i >= state.queue.length) {
      if (auto && state.mode === 'single') i = state.qIndex;
      else i = 0;
    }
  }
  playQueueIndex(i);
}

function prevSong() {
  if (!state.queue.length) return;
  let i = state.qIndex - 1;
  if (i < 0) i = state.queue.length - 1;
  playQueueIndex(i);
}

/* --------------------------------------------------------- 搜索预测 */

const SUGGEST_ICON = {
  singer:
    '<svg class="si-ico" viewBox="0 0 24 24"><path d="M12 12a5 5 0 1 0-5-5 5 5 0 0 0 5 5zm0 2c-4.42 0-8 2.24-8 5v2h16v-2c0-2.76-3.58-5-8-5z"/></svg>',
  song: '<svg class="si-ico" viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3z"/></svg>',
  hot: '<svg class="si-ico" viewBox="0 0 24 24"><path d="M13 2 4.5 14H10l-1 8 9.5-12H13z"/></svg>',
};

let suggestTimer = null;
let suggestHideTimer = null;
let suggestFlat = []; // 当前可键盘选择的项
let suggestActive = -1;
let suggestSeq = 0; // 防止慢请求覆盖新结果

function hideSuggest() {
  const panel = $('#suggestPanel');
  if (!panel) return;
  panel.classList.remove('show');
  suggestFlat = [];
  suggestActive = -1;
}

/** 把命中的关键词高亮出来 */
function highlightKw(text, kw) {
  const s = String(text == null ? '' : text);
  if (!kw) return esc(s);
  const i = s.toLowerCase().indexOf(kw.toLowerCase());
  if (i < 0) return esc(s);
  return (
    esc(s.slice(0, i)) +
    '<em>' +
    esc(s.slice(i, i + kw.length)) +
    '</em>' +
    esc(s.slice(i + kw.length))
  );
}

function renderSuggest(groups, kw) {
  const panel = $('#suggestPanel');
  if (!panel) return;
  suggestFlat = [];
  let html = '';
  for (const g of groups) {
    if (!g.items || !g.items.length) continue;
    html += `<div class="suggest-group">${esc(g.title)}</div>`;
    for (const it of g.items) {
      const idx = suggestFlat.length;
      suggestFlat.push(it);
      html += `<div class="suggest-item" data-si="${idx}">
        ${SUGGEST_ICON[it.type] || SUGGEST_ICON.song}
        <span class="si-text">${highlightKw(it.text, kw)}</span>
        ${it.tag ? `<span class="si-tag">${esc(it.tag)}</span>` : ''}
      </div>`;
    }
  }
  panel.innerHTML = html || '<div class="suggest-empty">没有找到相关建议</div>';
  panel.querySelectorAll('.suggest-item').forEach((el) => {
    // 用 mousedown + preventDefault，避免输入框先失焦把面板关掉
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      pickSuggest(Number(el.dataset.si));
    });
    el.addEventListener('mouseenter', () => setActiveSuggest(Number(el.dataset.si)));
  });
  panel.classList.add('show');
  setActiveSuggest(-1);
}

function setActiveSuggest(i) {
  const panel = $('#suggestPanel');
  if (!panel) return;
  panel.querySelectorAll('.suggest-item.active').forEach((el) => el.classList.remove('active'));
  suggestActive = i;
  if (i >= 0) {
    const el = panel.querySelector(`.suggest-item[data-si="${i}"]`);
    if (el) {
      el.classList.add('active');
      el.scrollIntoView({ block: 'nearest' });
    }
  }
}

/** 搜索框有内容时才显示清除按钮 */
function syncSearchClearBtn() {
  const input = $('#searchInput');
  const box = input && input.closest('.searchbox');
  if (box) box.classList.toggle('has-text', !!(input.value && input.value.length));
}

function pickSuggest(i) {
  const it = suggestFlat[i];
  if (!it) return;
  suggestSeq += 1; // 作废在途的联想请求，否则它回来会把面板又弹出来
  clearTimeout(suggestTimer);
  $('#searchInput').value = it.text;
  syncSearchClearBtn();
  hideSuggest();
  renderSearch(it.text);
}

async function refreshSuggest() {
  const kw = $('#searchInput').value.trim();
  const seq = ++suggestSeq;
  try {
    if (!kw) {
      // 空输入时给热门搜索
      const hot = await window.migu.hotSearch();
      if (seq !== suggestSeq) return;
      if (!hot || !hot.length) return hideSuggest();
      renderSuggest([{ title: '热门搜索', items: hot.map((w) => ({ text: w, type: 'hot' })) }], '');
      return;
    }
    const s = await window.migu.suggest(kw);
    if (seq !== suggestSeq) return;
    const groups = [];
    if (s && s.singers && s.singers.length) {
      groups.push({
        title: '歌手',
        items: s.singers.slice(0, 4).map((x) => ({ text: x, type: 'singer', tag: '歌手' })),
      });
    }
    if (s && s.songs && s.songs.length) {
      groups.push({ title: '歌曲', items: s.songs.slice(0, 8).map((x) => ({ text: x, type: 'song' })) });
    }
    if (!groups.length) return hideSuggest();
    renderSuggest(groups, kw);
  } catch {
    if (seq === suggestSeq) hideSuggest();
  }
}

function scheduleSuggest(delay = 220) {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(refreshSuggest, delay);
}

function bindSearchSuggest(doSearch) {
  const input = $('#searchInput');
  if (!input) return;

  /** 有内容时才显示清除按钮 */
  const syncClearBtn = syncSearchClearBtn;
  syncClearBtn();

  input.addEventListener('input', () => {
    syncClearBtn();
    scheduleSuggest(220);
  });
  input.addEventListener('focus', () => scheduleSuggest(0));
  // 不用 blur 收起面板：焦点抖动（窗口激活状态变化）会让面板莫名闪退。
  // 「点面板外」和「Esc」已经能覆盖收起场景。

  const clearBtn = $('#clearSearchBtn');
  if (clearBtn) {
    clearBtn.addEventListener('mousedown', (e) => e.preventDefault()); // 别让输入框先失焦
    clearBtn.addEventListener('click', () => {
      suggestSeq += 1; // 作废在途请求
      input.value = '';
      syncClearBtn();
      hideSuggest();
      input.focus();
      scheduleSuggest(0); // 清空后回到热门搜索
    });
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(suggestTimer);
      if (suggestActive >= 0 && suggestFlat[suggestActive]) pickSuggest(suggestActive);
      else doSearch();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!suggestFlat.length) return;
      e.preventDefault();
      const n = suggestFlat.length;
      let i = suggestActive + (e.key === 'ArrowDown' ? 1 : -1);
      if (i < 0) i = n - 1;
      if (i >= n) i = 0;
      setActiveSuggest(i);
      return;
    }
    if (e.key === 'Escape') {
      hideSuggest();
      input.blur();
    }
  });

  // 点面板外面就收起来
  document.addEventListener('click', (e) => {
    if (!e.target.closest || !e.target.closest('.searchbox')) hideSuggest();
  });
}

/* -------------------------------------------------------------- 分页 */

function pagerHtml(page, totalPages, total, unit = '首') {
  const t = Number(total) || 0;
  if (!totalPages || totalPages <= 1) {
    return t ? `<div class="pager"><span class="pg-total">共 ${t} ${unit}</span></div>` : '';
  }
  const nums = [];
  let last = 0;
  for (let i = 1; i <= totalPages; i++) {
    const show = i === 1 || i === totalPages || Math.abs(i - page) <= 2;
    if (!show) continue;
    if (last && i - last > 1) nums.push('<span class="pg-gap">…</span>');
    nums.push(`<button class="pg-num${i === page ? ' on' : ''}" data-page="${i}">${i}</button>`);
    last = i;
  }
  return `<div class="pager">
    <button class="pg-btn" data-page="${page - 1}"${page <= 1 ? ' disabled' : ''}>上一页</button>
    ${nums.join('')}
    <button class="pg-btn" data-page="${page + 1}"${page >= totalPages ? ' disabled' : ''}>下一页</button>
    <span class="pg-total">共 ${t} ${unit} · 第 ${page}/${totalPages} 页</span>
  </div>`;
}

function bindPager(scope, go) {
  scope.querySelectorAll('.pager [data-page]').forEach((el) => {
    el.addEventListener('click', () => {
      if (el.disabled) return;
      const p = Number(el.dataset.page);
      if (p >= 1) go(p);
    });
  });
}

/* -------------------------------------------------------------- 歌词 */

function parseLrc(text) {
  const out = [];
  const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  text.split(/\r?\n/).forEach((line) => {
    let m;
    const times = [];
    re.lastIndex = 0;
    while ((m = re.exec(line))) {
      const min = Number(m[1]);
      const sec = Number(m[2]);
      const ms = m[3] ? Number((m[3] + '00').slice(0, 3)) : 0;
      times.push(min * 60 + sec + ms / 1000);
    }
    const content = line.replace(re, '').trim();
    if (times.length && content) times.forEach((t) => out.push({ t, text: content }));
  });
  return out.sort((a, b) => a.t - b.t);
}

async function loadLyric(song) {
  state.lyricLines = [];
  state.lyricIndex = -1;
  state.follow = true; // 换歌了，恢复自动跟随
  updateFollowBtn();
  const body = $('#lyricBody');
  body.textContent = '暂无歌词';
  pushLyricToDesktop(song); // 先把桌面歌词切到歌名，避免停留在上一首
  if (!song || !song.lyricUrl) return;
  try {
    const raw = await window.migu.lyric(song.lyricUrl);
    if (!raw) return;
    const lines = parseLrc(raw);
    if (!lines.length) {
      body.textContent = raw.slice(0, 4000);
      return;
    }
    state.lyricLines = lines;
    body.innerHTML = lines.map((l, i) => `<div class="ll" data-li="${i}">${esc(l.text)}</div>`).join('');
    pushLyricToDesktop(song);
  } catch {
    /* 忽略歌词错误 */
  }
}

/* ------------------------------------------------------- 桌面歌词同步 */

function syncDesktopLyricBtn(open) {
  const btn = $('#desktopLyricBtn');
  if (btn) btn.classList.toggle('active', !!open);
  // 封面右上角的小红点：不开歌词面板也能看出桌面歌词正开着
  const wrap = $('#coverWrap');
  if (wrap) wrap.classList.toggle('lyric-on', !!open);
}

/** 歌词面板开关（同时同步按钮高亮） */
function setLyricPanel(open) {
  $('#lyricDrawer').classList.toggle('open', !!open);
  $('#lyricBtn').classList.toggle('active', !!open);
}

/** 把当前这一行/下一行推给桌面歌词窗口 */
function pushLyricToDesktop(song) {
  const lines = state.lyricLines;
  const idx = state.lyricIndex;
  let text = '';
  let next = '';

  if (lines.length && idx >= 0 && lines[idx]) {
    text = lines[idx].text;
    next = lines[idx + 1] ? lines[idx + 1].text : '';
  } else if (lines.length) {
    next = lines[0].text; // 还没开始唱，先把第一句作为“下一句”预览
  }

  // 还没唱到第一句时，先显示歌名，避免歌词条空着
  if (!text && song) {
    const artists = (song.artists || []).join('、');
    text = song.name + (artists ? ' - ' + artists : '');
  }

  window.migu.lyricUpdate({ text, next });
}

function syncLyric(cur) {
  if (state.dragging) return; // 拖动选段时不跟着自动滚
  const lines = state.lyricLines;
  if (!lines.length) {
    if (state.lyricIndex !== -1) {
      state.lyricIndex = -1;
      pushLyricToDesktop(state.current);
    }
    return;
  }
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t <= cur + 0.25) idx = i;
    else break;
  }
  if (idx === state.lyricIndex) return;
  state.lyricIndex = idx;
  if (state.desktopLyricOpen) pushLyricToDesktop();
  const box = $('#lyricBody');
  box.querySelectorAll('.ll.on').forEach((e) => e.classList.remove('on'));
  const el = box.querySelector(`.ll[data-li="${idx}"]`);
  if (el) {
    el.classList.add('on');
    // 用户正在自己翻歌词时不要把他拽回来
    if (!state.follow) return;
    const top = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2;
    box.scrollTo({ top, behavior: 'smooth' });
  }
}

/* --------------------------------------------- 自动跟随 / 手动浏览歌词 */

let followBtnTimer = null;
/** 开启/关闭自动跟随。关闭时会浮出「回到当前」按钮 */
function updateFollowBtn() {
  const btn = $('#lyricFollowBtn');
  if (btn) btn.classList.toggle('show', !state.follow);
}

function setFollow(on) {
  state.follow = !!on;
  updateFollowBtn();
  if (state.follow) {
    state.lyricIndex = -1; // 强制重算，立刻滚回当前句
    syncLyric(audio.currentTime);
  }
}

/**
 * 拖动期间把滚动位置钉死。
 * syncLyric 那侧已经停了自动跟随，但浏览器可能还有一段平滑滚动动画在跑，
 * 这里用 scroll 事件把它按回去，保证拖的时候视图纹丝不动。
 */
function lockScrollDuringDrag(box) {
  const target = box.scrollTop;
  const onScroll = () => {
    if (box.scrollTop !== target) box.scrollTop = target;
  };
  box.addEventListener('scroll', onScroll);
  return () => box.removeEventListener('scroll', onScroll);
}

/* ----------------------------------------------- 拖动歌词快进到对应位置 */

function setSeekTip(text) {
  const tip = $('#lyricSeekTip');
  if (!tip) return;
  if (text) {
    tip.textContent = text;
    tip.classList.add('show');
  } else {
    tip.classList.remove('show');
  }
}

/** 跳到第 idx 句歌词对应的时间点 */
function seekToLyricLine(idx) {
  const line = state.lyricLines[idx];
  if (!line) return;
  const dur = audio.duration;
  if (!isFinite(dur) || dur <= 0) return;
  audio.currentTime = Math.min(line.t, Math.max(0, dur - 0.25));
  state.lyricIndex = -1; // 强制重新定位高亮行
  syncLyric(audio.currentTime);
  if (state.desktopLyricOpen) pushLyricToDesktop(state.current);
  toast(
    '已跳到 ' + fmtTime(line.t) + (line.text ? ' · ' + line.text.slice(0, 16) : ''),
    1800
  );
}

/**
 * 歌词拖动选段：
 *  - 直接在歌词上拖动 → 实时预览目标句，松手跳过去
 *  - 原地单击某句   → 直接跳到那一句
 */
function bindLyricSeek() {
  const body = $('#lyricBody');
  if (!body) return;

  let drag = null;

  const clearDragVisual = () => {
    body.classList.remove('dragging');
    body.querySelectorAll('.ll.target').forEach((el) => el.classList.remove('target'));
    setSeekTip('');
  };

  body.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const line = e.target.closest && e.target.closest('.ll');
    if (!line || line.dataset.li == null) {
      // 点在滚动条或空白处：说明用户想自己翻，停掉自动跟随即可（滚动交给浏览器）
      setFollow(false);
      return;
    }
    // 一按下就进入拖动状态：立即禁止平滑滚动，并把滚动位置钉住
    body.classList.add('dragging');
    state.dragging = true;
    drag = {
      startY: e.clientY,
      moved: false,
      startIndex: Number(line.dataset.li),
      index: Number(line.dataset.li),
      unlock: lockScrollDuringDrag(body),
    };
    e.preventDefault(); // 阻止选中文本
  });

  // 滚轮翻歌词同样视为「手动浏览」
  body.addEventListener(
    'wheel',
    () => {
      if (!drag) setFollow(false);
    },
    { passive: true }
  );

  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    if (!drag.moved && Math.abs(e.clientY - drag.startY) > 5) drag.moved = true;
    if (!drag.moved) return;

    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const line = hit && hit.closest ? hit.closest('.ll') : null;
    if (!line || line.dataset.li == null) return;

    const idx = Number(line.dataset.li);
    if (idx !== drag.index) {
      drag.index = idx;
      body.querySelectorAll('.ll.target').forEach((el) => el.classList.remove('target'));
      line.classList.add('target');
    }
    const l = state.lyricLines[idx];
    setSeekTip('松手跳到 ' + fmtTime(l ? l.t : 0) + (l ? ' · ' + l.text.slice(0, 14) : ''));
  });

  window.addEventListener('mouseup', () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    state.dragging = false;
    if (d.unlock) d.unlock(); // 先解除滚动锁定，跳转时才滚得动
    clearDragVisual();
    // 拖/点到某句是明确的定位意图，跳完继续跟随
    state.follow = true;
    updateFollowBtn();
    seekToLyricLine(d.moved ? d.index : d.startIndex);
  });
}

/* -------------------------------------------------------------- 事件 */

function bindUi() {
  bindLyricSeek();

  // 搜索
  const doSearch = () => {
    const kw = $('#searchInput').value.trim();
    if (!kw) return toast('请输入搜索关键词');
    hideSuggest();
    renderSearch(kw);
  };
  $('#searchBtn').addEventListener('click', doSearch);
  bindSearchSuggest(doSearch);

  // 导航
  document.querySelectorAll('.nav-item').forEach((n) =>
    n.addEventListener('click', () => {
      const v = n.dataset.view;
      if (v === 'home') renderHome();
      else if (v === 'ranks') renderRanks();
      else if (v === 'mymusic') renderMyMusic();
      else if (v === 'search') {
        const kw = $('#searchInput').value.trim();
        if (kw) renderSearch(kw);
        else toast('请先在顶部输入关键词');
      }
    })
  );

  // 音质
  $('#toneSel').addEventListener('change', (e) => {
    state.tone = e.target.value;
    $('#setTone').value = e.target.value;
    window.migu.settings.set({ tone: state.tone });
    toast('音质已切换为 ' + state.tone);
  });

  // 播放控制
  $('#playBtn').addEventListener('click', () => {
    if (!state.current) {
      if (state.queue.length) playQueueIndex(0);
      else toast('播放列表为空，先选一首歌吧');
      return;
    }
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  });
  $('#nextBtn').addEventListener('click', () => nextSong(false));
  $('#prevBtn').addEventListener('click', prevSong);

  // 播放模式
  $('#modeBtn').addEventListener('click', () => {
    const order = ['list', 'single', 'random'];
    state.mode = order[(order.indexOf(state.mode) + 1) % order.length];
    const label = { list: '列表循环', single: '单曲循环', random: '随机播放' }[state.mode];
    toast('播放模式：' + label);
    $('#modeIcon').innerHTML =
      state.mode === 'single'
        ? '<path d="M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z"/><text x="12" y="15" font-size="9" text-anchor="middle" fill="currentColor">1</text>'
        : '<path d="M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z"/>';
  });

  // 歌词抽屉
  $('#lyricBtn').addEventListener('click', () =>
    setLyricPanel(!$('#lyricDrawer').classList.contains('open'))
  );
  $('#lyricClose').addEventListener('click', () => setLyricPanel(false));

  // 手动翻过歌词后，点这个回到正在唱的那句
  $('#lyricFollowBtn').addEventListener('click', () => {
    setFollow(true);
    toast('已回到当前播放位置', 1400);
  });

  // 桌面歌词悬浮窗
  $('#desktopLyricBtn').addEventListener('click', async () => {
    await window.migu.lyricToggle();
    const st = await window.migu.lyricStatus();
    state.desktopLyricOpen = !!st.open;
    syncDesktopLyricBtn(st.open);
    toast(st.open ? '桌面歌词已开启，鼠标移到歌词条上点「锁定」即可固定显示' : '桌面歌词已关闭');
    if (st.open) pushLyricToDesktop(state.current);
  });

  // 进度条
  const seek = $('#seek');
  seek.addEventListener('input', () => {
    state.seeking = true;
  });
  seek.addEventListener('change', () => {
    if (audio.duration) audio.currentTime = (Number(seek.value) / 1000) * audio.duration;
    state.seeking = false;
  });

  // 音量
  $('#volume').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    audio.volume = v / 100;
    $('#setVolume').value = String(v);
    saveVolumeDebounced(v);
  });

  // 设置面板
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#settingsClose').addEventListener('click', closeSettings);
  $('#settingsMask').addEventListener('click', (e) => {
    if (e.target === $('#settingsMask')) closeSettings();
  });
  $('#setTray').addEventListener('change', async (e) => {
    await window.migu.settings.set({ minimizeToTray: e.target.checked });
    toast(e.target.checked ? '关闭窗口时将最小化到系统托盘' : '关闭窗口时将直接退出程序');
  });
  $('#setTone').addEventListener('change', async (e) => {
    state.tone = e.target.value;
    $('#toneSel').value = e.target.value;
    await window.migu.settings.set({ tone: state.tone });
    toast('默认音质：' + state.tone);
  });
  $('#setVolume').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    audio.volume = v / 100;
    $('#volume').value = String(v);
    saveVolumeDebounced(v);
  });
  $('#setMinimize').addEventListener('click', async () => {
    closeSettings();
    await window.migu.minimizeToTray();
  });
  $('#setQuit').addEventListener('click', async () => {
    await window.migu.quitApp();
  });

  // 加入歌单弹窗
  $('#playlistClose').addEventListener('click', () => $('#playlistMask').classList.remove('show'));
  $('#playlistMask').addEventListener('click', (e) => {
    if (e.target === $('#playlistMask')) $('#playlistMask').classList.remove('show');
  });

  // 新建歌单弹窗
  const closeNewPl = () => {
    $('#newPlMask').classList.remove('show');
    newPlAfterCreate = null;
  };
  $('#newPlClose').addEventListener('click', closeNewPl);
  $('#newPlCancel').addEventListener('click', closeNewPl);
  $('#newPlMask').addEventListener('click', (e) => {
    if (e.target === $('#newPlMask')) closeNewPl();
  });
  $('#newPlOk').addEventListener('click', submitNewPlaylist);
  $('#newPlName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitNewPlaylist();
    } else if (e.key === 'Escape') {
      closeNewPl();
    }
  });

  // 日志
  $('#openLogBtn').addEventListener('click', async () => {
    try {
      const r = await window.migu.openLog();
      if (!r || !r.ok) toast('打开日志失败：' + ((r && r.error) || '未知错误'), 3600);
    } catch (e) {
      toast('打开日志失败：' + (e.message || e), 3600);
    }
  });
  $('#openLogDirBtn').addEventListener('click', async () => {
    try {
      await window.migu.revealLog();
    } catch (e) {
      toast('打开文件夹失败：' + (e.message || e), 3600);
    }
  });

  // 清理旧日志：切换保留期 / 立即清理
  $('#logRetention').addEventListener('change', async (e) => {
    const days = Number(e.target.value) || 0;
    await window.migu.settings.set({ logRetentionDays: days });
    await refreshLogStats();
    toast(days > 0 ? `将自动清理 ${days} 天前的日志` : '已关闭日志自动清理');
  });
  $('#cleanLogBtn').addEventListener('click', async () => {
    const days = Number($('#logRetention').value) || 0;
    if (days <= 0) {
      toast('请先把保留期设为「7 天」或「30 天」');
      return;
    }
    try {
      const r = await window.migu.logClean(days);
      await refreshLogStats();
      if (r && r.removed > 0) toast(`已清理 ${r.removed} 个日志文件，释放 ${fmtSize(r.freed)}`, 3200);
      else toast(`没有超过 ${days} 天的日志需要清理`, 2600);
    } catch (e) {
      toast('清理失败：' + (e.message || e), 3600);
    }
  });

  // audio 事件
  audio.addEventListener('play', () => setPlayIcon(true));
  audio.addEventListener('pause', () => setPlayIcon(false));
  audio.addEventListener('ended', () => nextSong(true));
  audio.addEventListener('error', () => {
    if (!audio.src || audio.src === location.href) return;
    // 只对“当前这一首”的加载失败作提示；切歌瞬间旧请求的报错一律忽略
    const key = state.currentSrcKey || '';
    if (key && !audio.src.startsWith(key.slice(0, 100))) return;
    toast('音频加载失败，可能受版权限制，已尝试下一首');
    setTimeout(() => nextSong(true), 800);
  });
  audio.addEventListener('loadedmetadata', () => {
    $('#durTime').textContent = fmtTime(audio.duration);
  });
  audio.addEventListener('timeupdate', () => {
    const cur = audio.currentTime || 0;
    if (!state.seeking) {
      const d = audio.duration || 0;
      $('#seek').value = d ? String(Math.round((cur / d) * 1000)) : '0';
    }
    $('#curTime').textContent = fmtTime(cur);
    syncLyric(cur);
  });

  // 登录
  $('#loginBtn').addEventListener('click', async () => {
    toast('已打开登录窗口，请在弹出的窗口中完成登录');
    try {
      await window.migu.login();
    } catch (e) {
      toast('打开登录窗口失败：' + (e.message || e));
    }
  });

  // 全局快捷键
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSettings();
      setLyricPanel(false);
      return;
    }
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') {
      e.preventDefault();
      $('#playBtn').click();
    }
  });
}

/* --------------------------------------------------------- 新建歌单 */

let newPlAfterCreate = null;
let newPlBusy = false;

/**
 * 打开新建歌单弹窗。
 * @param {(id:string, title:string) => any} [onCreated] 建好之后的后续动作（例如把刚选的歌加进去）
 */
function openNewPlaylistDialog(onCreated, hint) {
  newPlAfterCreate = onCreated || null;
  $('#newPlHint').textContent = hint || '给歌单起个名字（最多 40 个字）';
  const input = $('#newPlName');
  input.value = '';
  $('#newPlMask').classList.add('show');
  setTimeout(() => input.focus(), 60);
}

async function submitNewPlaylist() {
  if (newPlBusy) return;
  const input = $('#newPlName');
  const title = input.value.trim();
  if (!title) {
    toast('歌单名不能为空');
    input.focus();
    return;
  }

  const btn = $('#newPlOk');
  newPlBusy = true;
  btn.disabled = true;
  btn.textContent = '创建中…';
  try {
    const r = await window.migu.createPlaylist(title);
    if (r && r.ok) {
      $('#newPlMask').classList.remove('show');
      toast(`歌单「${title}」已创建`, 2600);
      const cb = newPlAfterCreate;
      newPlAfterCreate = null;
      if (cb) await cb(r.id, title);
    } else if (r && r.needLogin) {
      toast('登录状态已失效，请重新登录后再试', 3600);
    } else {
      toast('创建失败：' + ((r && r.error) || '未知错误'), 3600);
    }
  } catch (e) {
    toast('创建失败：' + (e.message || e), 3600);
  } finally {
    newPlBusy = false;
    btn.disabled = false;
    btn.textContent = '创建';
  }
}

/* --------------------------------------------------------- 我的音乐 */

function playlistCardHtml(p, isFav, mine) {
  const cover = p.cover
    ? `<img src="${esc(p.cover)}" onerror="this.style.display='none'" alt="">`
    : `<div class="pl-cover-fav">♥</div>`;
  return `<div class="card pl-card" data-pl="${esc(p.id)}" data-title="${esc(p.title)}"${
    isFav ? ' data-fav="1"' : ''
  }${mine ? ' data-mine="1"' : ''}>
    <div class="c-cover">${cover}
      <div class="c-play" title="把当前播放列表加入这个歌单">
        <svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>
      </div>
    </div>
    <div class="c-name">${esc(p.title)}</div>
    <div class="c-sub">${isFav ? p.count + ' 首' : (p.count || 0) + ' 首'}</div>
  </div>`;
}

/** 「我的歌单」区里那张虚线的新建卡片 */
function newPlaylistCardHtml() {
  return `<div class="card pl-card pl-new" data-new="1" data-title="新建歌单">
    <div class="c-cover"><div class="pl-cover-fav">＋</div></div>
    <div class="c-name">新建歌单</div>
    <div class="c-sub">创建一个自己的歌单</div>
  </div>`;
}

/**
 * 从歌单里点歌：先按当前页起播（响应快），
 * 再把**整个歌单**补进播放队列 —— 否则随机播放只能在当前页 20 首里打转。
 */
async function playFromPlaylist(playlistId, pageSongs, index) {
  await playAt(pageSongs, index);
  const started = state.current;
  if (!started) return;
  try {
    const all = await window.migu.playlistAllSongs(playlistId);
    if (!all || !all.ok || !all.songs || all.songs.length <= pageSongs.length) return;
    if (state.current !== started) return; // 用户中途又点了别的歌，放弃补全
    const newIdx = all.songs.findIndex((s) => s.contentId === started.contentId);
    state.queue = all.songs.slice();
    state.qIndex = newIdx >= 0 ? newIdx : 0;
    updateQueueUi();
    refreshRowIndicators();
    toast(`已把整个歌单（${all.songs.length} 首）放进播放列表，随机播放可覆盖全部`, 3600);
  } catch {
    /* 补全失败不影响正在播的这首 */
  }
}

/** 播放整个歌单 */
async function playWholePlaylist(playlistId, title) {
  toast('正在载入整个歌单…', 2000);
  try {
    const all = await window.migu.playlistAllSongs(playlistId);
    if (!all || !all.ok || !all.songs || !all.songs.length) {
      toast('载入失败：' + ((all && all.error) || '未知错误'), 3600);
      return;
    }
    await playAt(all.songs, 0);
    toast(`开始播放「${title}」，共 ${all.songs.length} 首`, 2800);
  } catch (e) {
    toast('载入失败：' + (e.message || e), 3600);
  }
}

/** 歌单详情：列出里面的歌曲（每页 20 首）
 *  opts.removable 为真时每行显示「移出」按钮；opts.isFav 表示这是「我喜欢的」 */
async function renderPlaylistDetail(playlistId, title, pageNo = 1, opts = {}) {
  state.view = 'playlistDetail';
  view.innerHTML = loadingHtml('正在读取歌单…');
  const removable = !!opts.removable;
  const isFav = !!opts.isFav;
  const back = `<div class="back-bar"><button class="back-btn" id="backBtn">← 返回我的音乐</button></div>`;
  const bindBack = () => {
    const b = $('#backBtn');
    if (b) b.addEventListener('click', renderMyMusic);
  };

  try {
    const r = await window.migu.playlistSongs(playlistId, pageNo, PAGE_SIZE);
    if (!r || !r.ok) {
      view.innerHTML = back + `<div class="page-title">${esc(title)}</div>` + emptyHtml(r.error || '读取失败');
      bindBack();
      return;
    }
    const start = (r.page - 1) * r.pageSize;
    view.innerHTML =
      back +
      `<div class="page-title">${esc(title)}</div>
       <div class="page-sub">共 ${r.total} 首 · 每页 ${r.pageSize} 首 · 第 ${r.page}/${r.totalPages} 页</div>
       <div class="pl-actions">
         <button class="btn-primary" id="playAllBtn">▶ 播放全部（${r.total} 首）</button>
         <span class="pl-actions-hint">${
           removable
             ? '点歌时会自动把整个歌单放进播放列表；行尾的 − 可以把这首歌移出歌单'
             : '点歌时会自动把整个歌单放进播放列表，随机播放可覆盖全部'
         }</span>
       </div>
       <div class="song-list${removable ? ' removable' : ''}" id="plSongList">${songRowsHtml(r.songs, start, { removable })}</div>
       ${pagerHtml(r.page, r.totalPages, r.total)}`;
    bindBack();
    bindSongList($('#plSongList'), r.songs, {
      onPlay: (songs, i) => playFromPlaylist(playlistId, songs, i),
      onRemove: removable
        ? (song, pageSongs) => removeSongFromPlaylist(playlistId, title, song, pageNo, pageSongs.length, isFav)
        : null,
    });
    const playAll = $('#playAllBtn');
    if (playAll) playAll.addEventListener('click', () => playWholePlaylist(playlistId, title));
    bindPager(view, (p) => {
      view.scrollTop = 0;
      renderPlaylistDetail(playlistId, title, p, opts);
    });
  } catch (e) {
    view.innerHTML =
      back + `<div class="page-title">${esc(title)}</div>` + emptyHtml('读取失败：' + esc(e.message || e));
    bindBack();
  }
}

/**
 * 把一首歌移出当前歌单。
 * 「我喜欢的」要传空 id —— 咪咕那边它是收藏，走的是不带 id 的分支。
 */
async function removeSongFromPlaylist(playlistId, title, song, pageNo, pageCount, isFav) {
  if (!song || !song.contentId) return;
  const target = isFav ? '' : playlistId;
  toast(`正在把《${song.name}》移出「${title}」…`, 1800);
  try {
    const r = await window.migu.removeFromPlaylist(target, [song.contentId]);
    if (r && r.ok) {
      toast(`已把《${song.name}》移出「${title}」`, 2600);
      // 这一页被搬空且不是第一页时，退一页，别让用户看到空白
      const nextPage = pageCount <= 1 && pageNo > 1 ? pageNo - 1 : pageNo;
      renderPlaylistDetail(playlistId, title, nextPage, { removable: true, isFav });
    } else if (r && r.needLogin) {
      toast('登录状态已失效，请重新登录后再试', 3600);
    } else {
      toast('移出失败：' + ((r && r.error) || '未知错误'), 3600);
    }
  } catch (e) {
    toast('移出失败：' + (e.message || e), 3600);
  }
}

async function renderMyMusic() {
  state.view = 'mymusic';
  setNav('mymusic');
  view.innerHTML = loadingHtml('正在读取你的歌单…');
  try {
    const [auth, r] = await Promise.all([window.migu.authStatus(), window.migu.myPlaylists()]);

    if (!r || !r.ok) {
      // 登录态失效时，服务端只会回一句「参数校验失败」，直接显示等于没说
      const needLogin = (r && r.needLogin) || !(auth && auth.loggedIn);
      view.innerHTML =
        `<div class="page-title">我的音乐</div>` +
        emptyHtml(
          needLogin
            ? '登录状态已失效，重新登录后就能看到你的歌单了'
            : '读取歌单失败：' + esc((r && r.error) || '未知错误')
        ) +
        (needLogin
          ? '<div class="login-cta"><button class="btn-login" id="mmLogin">重新登录</button></div>'
          : '');
      const lb = document.getElementById('mmLogin');
      if (lb) {
        lb.addEventListener('click', async () => {
          toast('已打开登录窗口，请在弹出的窗口中完成登录');
          try {
            await window.migu.login();
          } catch (e) {
            toast('打开登录窗口失败：' + (e.message || e));
          }
        });
      }
      return;
    }

    const name = (auth && auth.nickname) || '已登录用户';
    const avatar = auth && auth.avatar ? `style="background-image:url('${esc(auth.avatar)}')"` : '';

    let html = `<div class="page-title">我的音乐</div>
      <div class="page-sub">歌单数据从你的咪咕账号实时读取</div>
      <div class="mymusic-head">
        <div class="mymusic-avatar" ${avatar}>${auth && auth.avatar ? '' : esc(name.slice(0, 1))}</div>
        <div class="mymusic-info">
          <b>${esc(name)}</b>
          <span>${auth && auth.loggedIn ? '已登录' : '未登录'}</span>
        </div>
        <div class="mymusic-stats">
          <div><b>${r.favoriteCount || 0}</b><span>我喜欢的</span></div>
          <div><b>${r.created.length}</b><span>自建歌单</span></div>
          <div><b>${r.collected.length}</b><span>收藏歌单</span></div>
        </div>
      </div>`;

    html += `<div class="section-title">我喜欢的</div><div class="grid">`;
    html += playlistCardHtml(
      { id: r.favoriteId || '', title: '我喜欢的', count: r.favoriteCount || 0, cover: '' },
      true,
      true
    );
    html += `</div>`;

    if (r.created.length) {
      html += `<div class="section-title">我的歌单</div><div class="grid">`;
      html += newPlaylistCardHtml();
      html += r.created.map((p) => playlistCardHtml(p, false, true)).join('');
      html += `</div>`;
    } else {
      html += `<div class="section-title">我的歌单</div><div class="grid">`;
      html += newPlaylistCardHtml();
      html += `</div>`;
      html += `<p class="pl-hint">还没有自建歌单 —— 点上面的「新建歌单」就能建一个。</p>`;
    }

    if (r.collected.length) {
      html += `<div class="section-title">收藏的歌单</div><div class="grid">`;
      // 收藏来的歌单是别人的，不给「移出」入口
      html += r.collected.map((p) => playlistCardHtml(p)).join('');
      html += `</div>`;
    }

    html += `<p class="pl-hint">点歌单卡片可以查看里面的歌曲；鼠标移到封面的 <b>＋</b> 上，可以把<b>当前播放列表</b>一次性加进去；在自己歌单里可以把单曲移出。</p>`;

    view.innerHTML = html;

    view.querySelectorAll('.pl-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        const id = card.dataset.pl;
        const title = card.dataset.title;
        const isFav = card.dataset.fav === '1';
        const mine = card.dataset.mine === '1';
        if (card.dataset.new === '1') {
          openNewPlaylistDialog(() => renderMyMusic());
          return;
        }
        if (e.target.closest && e.target.closest('.c-play')) {
          e.stopPropagation();
          addQueueToPlaylist(isFav ? '' : id, title);
          return;
        }
        if (!id) {
          toast('没取到这个歌单的 id，无法查看', 3000);
          return;
        }
        renderPlaylistDetail(id, title, 1, { removable: mine, isFav: isFav && mine });
      });
    });
  } catch (e) {
    view.innerHTML = `<div class="page-title">我的音乐</div>` + emptyHtml('读取失败：' + esc(e.message || e));
  }
}

/** 把当前播放队列一次性加进某个歌单 */
async function addQueueToPlaylist(musicListId, title) {
  const ids = [...new Set((state.queue || []).map((s) => s.contentId).filter(Boolean))];
  if (!ids.length) return toast('播放列表是空的，先播放几首歌吧', 2800);
  toast(`正在把 ${ids.length} 首加入「${title}」…`, 2200);
  try {
    const r = await window.migu.addToPlaylist(musicListId, ids);
    if (r && r.ok) {
      const parts = [`成功 ${r.successNum} 首`];
      if (r.repeated) parts.push(`${r.repeated} 首已存在`);
      if (r.failed) parts.push(`${r.failed} 首不支持`);
      toast(`已加入「${title}」：${parts.join('，')}`, 4200);
    } else {
      toast('加入失败：' + ((r && r.error) || '未知错误'), 3600);
    }
  } catch (e) {
    toast('加入失败：' + (e.message || e), 3600);
  }
}

/* --------------------------------------------------------- 加入歌单 */

let plTargetSong = null;

async function openPlaylistPicker(song) {
  if (!song || !song.contentId) return toast('这首歌没有可用的 contentId，无法添加');
  plTargetSong = song;
  $('#plSong').textContent = song.name + ' — ' + ((song.artists || []).join('、') || '未知歌手');
  $('#playlistMask').classList.add('show');
  const box = $('#plList');
  box.innerHTML = '<div class="suggest-empty">正在读取你的歌单…</div>';

  try {
    const r = await window.migu.myPlaylists();
    if (!r || !r.ok) {
      box.innerHTML = `<div class="suggest-empty">${esc(
        (r && r.needLogin)
          ? '登录状态已失效，请先重新登录再收藏歌曲'
          : (r && r.error) || '读取歌单失败，请确认已登录'
      )}</div>`;
      return;
    }
    let html = `<div class="pl-item" data-id="">
      <div class="pl-cover">♥</div>
      <div class="pl-meta"><b>我喜欢的</b><span>${r.favoriteCount || 0} 首</span></div>
    </div>`;
    if (r.created && r.created.length) {
      for (const p of r.created) {
        html += `<div class="pl-item" data-id="${esc(p.id)}">
          <div class="pl-cover"${p.cover ? ` style="background-image:url('${esc(p.cover)}')"` : ''}></div>
          <div class="pl-meta"><b>${esc(p.title)}</b><span>${p.count} 首</span></div>
        </div>`;
      }
    } else {
      html += '<div class="suggest-empty">还没有自建歌单，可以加入到「我喜欢的」</div>';
    }
    // 允许现场建一个再加入，省得先去别处建好再回来
    html += `<div class="pl-item pl-new-item" data-new="1">
      <div class="pl-meta"><b>＋ 新建歌单并加入</b></div>
    </div>`;
    box.innerHTML = html;
    box.querySelectorAll('.pl-item').forEach((el) => {
      el.addEventListener('click', () => {
        if (el.dataset.new === '1') {
          $('#playlistMask').classList.remove('show');
          openNewPlaylistDialog(
            (id, title) => doAddToPlaylist(id, title),
            `新建一个歌单，并把《${plTargetSong ? plTargetSong.name : '这首歌'}》加进去`
          );
          return;
        }
        doAddToPlaylist(el.dataset.id, el.querySelector('b').textContent);
      });
    });
  } catch (e) {
    box.innerHTML = `<div class="suggest-empty">${esc(e.message || '读取歌单失败')}</div>`;
  }
}

async function doAddToPlaylist(musicListId, title) {
  const song = plTargetSong;
  if (!song) return;
  try {
    const r = await window.migu.addToPlaylist(musicListId, [song.contentId]);
    if (r && r.ok) {
      if (r.successNum > 0) toast(`已添加到「${title}」`, 2600);
      else if (r.repeated > 0) toast(`这首歌已经在「${title}」里了`, 2600);
      else toast('没有添加成功（可能该歌曲不支持收藏）', 3200);
    } else {
      toast('添加失败：' + ((r && r.error) || '未知错误'), 3600);
    }
  } catch (e) {
    toast('添加失败：' + (e.message || e), 3600);
  }
  $('#playlistMask').classList.remove('show');
}

/* ------------------------------------------------------------ 设置面板 */

let volSaveTimer = null;
function saveVolumeDebounced(v) {
  clearTimeout(volSaveTimer);
  volSaveTimer = setTimeout(() => window.migu.settings.set({ volume: v }), 500);
}

function fmtSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

/** 刷新「日志占用 / 保留策略」那一行的说明文字 */
async function refreshLogStats() {
  const el = $('#logStatsText');
  if (!el) return;
  const days = Number($('#logRetention').value) || 0;
  const tail = days > 0 ? `；启动时自动清理 ${days} 天前的` : '；已关闭自动清理';
  try {
    const st = await window.migu.logStats();
    el.textContent = `共 ${st.count} 个文件 · ${fmtSize(st.bytes)}${tail}`;
    el.title = st.dir || '';
  } catch {
    el.textContent = '统计失败';
  }
}

async function openSettings() {
  try {
    const s = await window.migu.settings.get();
    $('#setTray').checked = !!s.minimizeToTray;
    $('#setTone').value = s.tone || 'PQ';
    $('#setVolume').value = String(typeof s.volume === 'number' ? s.volume : 70);
    $('#logRetention').value = String(typeof s.logRetentionDays === 'number' ? s.logRetentionDays : 30);
  } catch {}
  try {
    const lp = await window.migu.logPath();
    const el = $('#logPathText');
    if (el && lp && lp.file) {
      el.textContent = '当前：' + String(lp.file).split(/[\\/]/).pop();
      el.title = lp.file;
    } else if (el) {
      el.textContent = '本次运行的日志将在首次写入后生成';
      el.title = '';
    }
  } catch {}
  await refreshLogStats();
  $('#settingsMask').classList.add('show');
}

function closeSettings() {
  $('#settingsMask').classList.remove('show');
}

/* ------------------------------------------------------------ 登录态 */

function renderAuth(auth) {
  const box = $('#userArea');
  if (auth && auth.loggedIn) {
    const name = auth.nickname || '已登录用户';
    box.innerHTML = `<div class="user-chip">
      ${
        auth.avatar
          ? `<img class="avatar" src="${esc(auth.avatar)}" alt="">`
          : `<div class="avatar">${esc(name.slice(0, 1))}</div>`
      }
      <span class="name" title="${esc(name)}">${esc(name)}</span>
      <button class="logout" id="logoutBtn">退出</button>
    </div>`;
    $('#logoutBtn').addEventListener('click', async () => {
      await window.migu.logout();
      toast('已退出登录');
    });
  } else {
    box.innerHTML = `<button class="btn-login" id="loginBtn">登录</button>`;
    $('#loginBtn').addEventListener('click', async () => {
      toast('已打开登录窗口，请在弹出的窗口中完成登录');
      try {
        await window.migu.login();
      } catch (e) {
        toast('打开登录窗口失败：' + (e.message || e));
      }
    });
  }
}

window.migu.onAuthChanged((auth) => {
  renderAuth(auth);
  if (auth.loggedIn) {
    toast('登录成功' + (auth.nickname ? '，欢迎 ' + auth.nickname : ''));
    // 如果用户是停在「我的音乐」页点的重新登录，登录成功后就地把歌单读出来
    if (state.view === 'mymusic' && view.querySelector('.login-cta')) renderMyMusic();
  }
});

/* -------------------------------------------------------------- 启动 */

async function boot() {
  bindUi();
  try {
    const auth = await window.migu.authStatus();
    renderAuth(auth);
  } catch {}

  // 应用上次保存的设置（音质 / 音量）
  try {
    const s = await window.migu.settings.get();
    if (s.tone) {
      state.tone = s.tone;
      $('#toneSel').value = s.tone;
      $('#setTone').value = s.tone;
    }
    if (typeof s.volume === 'number') {
      $('#volume').value = String(s.volume);
      $('#setVolume').value = String(s.volume);
      audio.volume = s.volume / 100;
    }
  } catch {}

  // 托盘右键菜单里的播放控制
  window.migu.onPlayerCommand((cmd) => {
    if (cmd === 'toggle') $('#playBtn').click();
    else if (cmd === 'next') nextSong(false);
    else if (cmd === 'prev') prevSong();
  });

  // 在托盘菜单里改设置时，界面同步过来
  window.migu.onSettingsChanged((s) => {
    $('#setTray').checked = !!s.minimizeToTray;
    if (s.tone) {
      state.tone = s.tone;
      $('#toneSel').value = s.tone;
      $('#setTone').value = s.tone;
    }
  });

  window.migu.onLyricChanged((st) => {
    state.desktopLyricOpen = !!st.open;
    syncDesktopLyricBtn(!!st.open);
    if (st.open) pushLyricToDesktop(state.current);
    // 刚被锁定 -> 明确告诉用户怎么解锁（锁定后歌词条本身点不到了）
    if (st.open && st.locked && !state._lyricLockTipShown) {
      state._lyricLockTipShown = true;
      toast('桌面歌词已锁定（鼠标穿透）。解锁：托盘右键 →「锁定桌面歌词」，或点这里的桌面歌词按钮', 5600);
    }
    if (!st.locked) state._lyricLockTipShown = false;
  });

  // 恢复桌面歌词按钮状态
  try {
    const lst = await window.migu.lyricStatus();
    state.desktopLyricOpen = !!lst.open;
    syncDesktopLyricBtn(!!lst.open);
  } catch {}

  // 又点了一次图标：已有实例被唤回，这里给个提示
  window.migu.onAlreadyRunning(() => {
    toast('咪咕音乐已经在运行了，已为你切回主窗口', 3200);
  });

  renderHome();
}

boot();
