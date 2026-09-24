/**
 * 我的歌单 / 收藏
 *
 * 这些是「用户态」接口，必须借用网页版自己的 http 客户端发（见 resolver.webCall），
 * 否则会被判定为未登录。
 */
const resolver = require('./resolver');
const api = require('./migu-api');
const logger = require('./logger');

/** 从 actionUrl 里抠出 musicListId（「我喜欢的」只有这个入口才带） */
function pickMusicListId(url) {
  const m = String(url || '').match(/musicListId=([\w-]+)/i);
  return m ? m[1] : '';
}

/** 把接口返回的歌单对象统一成前端好用的结构 */
function normList(x) {
  if (!x) return null;
  const img = x.imgItem || {};
  return {
    id: x.musicListId || x.id || '',
    title: x.title || '',
    cover: img.img || img.webpImg || x.img || '',
    count: Number(x.musicNum || x.songNum || 0),
    owner: x.ownerName || '',
    resourceType: String(x.resourceType || ''),
    createTime: x.publishTime || '',
  };
}

/**
 * 判断一次失败是不是「登录态没了」。
 *
 * 咪咕在未登录时的提示很不直观：
 *   - home-page 这类接口因为拿不到 uid，回的是「请求错误，参数校验失败」；
 *   - 另一些接口才老实回「请先登录」(290001)。
 * 这两种都要翻译成用户能看懂的话，否则界面上只会显示一句莫名其妙的参数错误。
 */
const NEED_LOGIN_RE = /请先登录|未登录|登录已过期|参数校验失败/;
function isNeedLogin(code, info) {
  return String(code || '') === '290001' || NEED_LOGIN_RE.test(String(info || ''));
}

function needLoginResult(extra = {}) {
  return {
    ok: false,
    needLogin: true,
    error: '登录状态已失效，请重新登录',
    songs: [],
    total: 0,
    totalPages: 0,
    ...extra,
  };
}

/** 我喜欢的 / 自建歌单 / 收藏的歌单 */
async function getMyPlaylists() {
  const r = await resolver.webCall('/pc/user/home-page/v2.0');
  const res = r && r.res;
  if (!r || !r.ok || !res || res.code !== '000000') {
    const info = (res && res.info) || r.err || '获取歌单失败';
    if (isNeedLogin(res && res.code, info)) {
      logger.warn('[歌单] 未登录或登录已过期，无法读取我的歌单');
      return needLoginResult({ created: [], collected: [], favoriteCount: 0 });
    }
    logger.warn('[歌单] 获取我的歌单失败：' + info);
    return { ok: false, error: info, created: [], collected: [], favoriteCount: 0 };
  }

  const d = res.data || {};
  const created = ((d.myCreatedMusicLists || {}).createdMusicLists || []).map(normList).filter(Boolean);
  const collected = ((d.myCollectedMusicLists || {}).collectMusicLists || []).map(normList).filter(Boolean);

  // 「喜欢的音乐」在 userPrivateItems 里，带歌曲数（以及它自己的 musicListId）
  const fav = (d.userPrivateItems || []).find((it) => /喜欢的音乐/.test(it.title || ''));
  let favoriteCount = 0;
  let favoriteId = '';
  if (fav) {
    const m = String(fav.subTitle || '').match(/(\d+)/);
    if (m) favoriteCount = Number(m[1]);
    favoriteId = pickMusicListId(fav.actionUrl);
  }
  // 兜底：从自建歌单里找个叫「我喜欢」的
  if (!favoriteId) {
    const guess = created.find((p) => /我喜欢/.test(p.title));
    if (guess) favoriteId = guess.id;
  }

  logger.info(
    `[歌单] 读取到自建歌单 ${created.length} 个、收藏歌单 ${collected.length} 个、我喜欢 ${favoriteCount} 首（id=${favoriteId || '空'}）`
  );
  return { ok: true, created, collected, favoriteCount, favoriteId };
}

/**
 * 读取歌单里的歌曲（单页）。
 * 客户端统一按每页 20 首分页（接口本身单页上限是 50）。
 */
async function getPlaylistSongs(playlistId, pageNo = 1, pageSize = 20) {
  if (!playlistId) return { ok: false, error: '缺少歌单 id', songs: [], total: 0 };
  const page = Math.max(1, Number(pageNo) || 1);
  const size = Math.min(50, Math.max(1, Number(pageSize) || 20));

  const r = await resolver.webCall('/MIGUM3.0/resource/playlist/song/v2.0', {
    playlistId: String(playlistId),
    pageNo: String(page),
    pageSize: String(size),
  });
  const res = r && r.res;
  if (!r || !r.ok || !res || res.code !== '000000') {
    const info = (res && res.info) || r.err || '读取歌单歌曲失败';
    logger.warn(`[歌单] 读取歌曲失败 playlistId=${playlistId} page=${page}：${info}`);
    return { ok: false, error: info, songs: [], total: 0, page, pageSize: size, totalPages: 0 };
  }

  const d = res.data || {};
  const total = Number(d.totalCount || 0);
  const songs = (d.songList || []).map((x) => {
    try {
      return api.normalizeSongData(x);
    } catch {
      return null;
    }
  }).filter(Boolean);

  const totalPages = Math.max(1, Math.ceil(total / size));
  logger.info(`[歌单] 读取歌单 ${playlistId} 第 ${page}/${totalPages} 页：本页 ${songs.length} 首，共 ${total} 首`);
  return { ok: true, songs, total, page, pageSize: size, totalPages };
}

/**
 * 拉取歌单里的**全部**歌曲（用于「播放全部」/ 让随机播放能覆盖整个歌单）。
 * 逐页请求，避免一次要太多。
 */
async function getAllPlaylistSongs(playlistId, maxPages = 40) {
  if (!playlistId) return { ok: false, error: '缺少歌单 id', songs: [], total: 0 };

  const all = [];
  let total = 0;
  for (let page = 1; page <= maxPages; page++) {
    const r = await resolver.webCall('/MIGUM3.0/resource/playlist/song/v2.0', {
      playlistId: String(playlistId),
      pageNo: String(page),
      pageSize: '50', // 取全量时用接口允许的最大页长，少发几次请求
    });
    const res = r && r.res;
    if (!r || !r.ok || !res || res.code !== '000000') {
      if (page === 1) {
        return { ok: false, error: (res && res.info) || r.err || '读取失败', songs: [], total: 0 };
      }
      break;
    }
    const d = res.data || {};
    total = Number(d.totalCount || total);
    const list = d.songList || [];
    for (const x of list) {
      try {
        all.push(api.normalizeSongData(x));
      } catch {}
    }
    if (!list.length || all.length >= total) break;
  }

  logger.info(`[歌单] 取全量歌单 ${playlistId}：${all.length}/${total} 首`);
  return { ok: true, songs: all, total: total || all.length };
}

/**
 * 把歌曲加入歌单。
 * @param {string} musicListId 目标歌单；传空则加入「我喜欢的」
 * @returns {{ok:boolean, successNum?:number, repeated?:number, error?:string}}
 */
async function addSongs(musicListId, contentIds) {
  const ids = (contentIds || []).filter(Boolean);
  if (!ids.length) return { ok: false, error: '没有可添加的歌曲' };

  const body = { contentIds: ids };
  if (musicListId) body.id = musicListId;

  const r = await resolver.webCall('/pc/user/api/add-music-list-song/v1.0', body, 'post');
  const res = r && r.res;
  if (!r || !r.ok || !res || res.code !== '000000') {
    const info = (res && res.info) || r.err || '添加失败';
    if (isNeedLogin(res && res.code, info)) {
      logger.warn('[歌单] 未登录或登录已过期，无法加入歌单');
      return { ok: false, needLogin: true, error: '登录状态已失效，请重新登录' };
    }
    logger.warn(`[歌单] 添加失败（目标=${musicListId || '我喜欢的'}）：${info}`);
    return { ok: false, error: info };
  }

  const data = res.data || {};
  const successNum = Number(data.successNum || 0);
  const repeated = (data.fail2RepeatContentIdList || []).length;
  const failed = (data.failContentIdList || []).length;
  logger.info(
    `[歌单] 添加 ${ids.length} 首到 ${musicListId || '我喜欢的'}：成功 ${successNum}，重复 ${repeated}，失败 ${failed}`
  );
  return { ok: true, successNum, repeated, failed, total: ids.length };
}

/**
 * 新建歌单。
 *
 * 走的是 `/pc/open/api/music-list/add/v2.0`（网页版建歌单用的就是这支），
 * 必须带 channel / type，否则服务端会当成非法来源。
 *
 * @param {string} title 歌单名
 * @returns {{ok:boolean, id?:string, title?:string, error?:string, needLogin?:boolean}}
 */
async function createPlaylist(title) {
  const name = String(title || '').trim();
  if (!name) return { ok: false, error: '歌单名不能为空' };
  if (name.length > 40) return { ok: false, error: '歌单名太长了（最多 40 个字）' };

  const r = await resolver.webCall(
    '/pc/open/api/music-list/add/v2.0',
    { title: name, channel: '23', type: 'self_build' },
    'post'
  );
  const res = r && r.res;
  if (!r || !r.ok || !res || res.code !== '000000') {
    const code = String((res && res.code) || '');
    const info = (res && res.info) || r.err || '创建失败';
    if (isNeedLogin(code, info)) {
      logger.warn('[歌单] 未登录或登录已过期，无法新建歌单');
      return { ok: false, needLogin: true, error: '登录状态已失效，请重新登录' };
    }
    // 这几个是网页版自己会翻译的常见错误，原样透出去太难看
    if (code === '100001') return { ok: false, error: '已经有同名歌单了，换个名字吧' };
    if (code === '299999') return { ok: false, error: '歌单名不合法，换一个试试' };
    logger.warn(`[歌单] 新建歌单失败（${name}）：${code} ${info}`);
    return { ok: false, error: info };
  }

  // 接口不一定回 id，没回就捞一次列表把它找出来
  const d = res.data || {};
  let id = d.musicListId || d.id || '';
  if (!id) {
    const mine = await getMyPlaylists();
    const found = (mine.created || []).find((p) => p.title === name);
    if (found) id = found.id;
  }

  logger.info(`[歌单] 已新建歌单「${name}」（id=${id || '未取到'}）`);
  return { ok: true, id, title: name };
}

/**
 * 删除整个歌单。
 *
 * 网页版删歌单用的是 `/pc/v1.0/user/deleteMusicList.do`，GET，只要 channel + id。
 * 注意这是删**歌单**，不是删里面的歌 —— 歌曲本身还在曲库里。
 *
 * @param {string} musicListId
 */
async function deletePlaylist(musicListId) {
  const id = String(musicListId || '').trim();
  if (!id) return { ok: false, error: '缺少歌单 id' };

  const r = await resolver.webCall('/pc/v1.0/user/deleteMusicList.do', { channel: '23', id });
  const res = r && r.res;
  if (!r || !r.ok || !res || res.code !== '000000') {
    const info = (res && res.info) || r.err || '删除失败';
    if (isNeedLogin(res && res.code, info)) {
      logger.warn('[歌单] 未登录或登录已过期，无法删除歌单');
      return { ok: false, needLogin: true, error: '登录状态已失效，请重新登录' };
    }
    logger.warn(`[歌单] 删除歌单失败（id=${id}）：${(res && res.code) || ''} ${info}`);
    return { ok: false, error: info };
  }

  logger.info(`[歌单] 已删除歌单 id=${id}`);
  return { ok: true, id };
}

/**
 * 把歌曲移出歌单。
 *
 * 咪咕没有独立的「移除歌曲」接口 —— 网页版用的是同一支
 * `/pc/user/h5-import-musiclist/v1.0`，靠 songflag 区分动作：
 *   songflag "0" = 修改歌单名，"2" = 移除歌曲，"3" = 其它
 * （见网页版 BulkOperation / 播放器里的「不喜欢」逻辑）
 *
 * @param {string} musicListId 歌单 id；传空表示「我喜欢的」
 * @param {string[]} contentIds 要移出的歌曲
 */
async function removeSongs(musicListId, contentIds) {
  const ids = (contentIds || []).filter(Boolean);
  if (!ids.length) return { ok: false, error: '没有可移除的歌曲' };

  const body = { channel: '23', songflag: '2', contentId: ids.join('|') };
  if (musicListId) body.id = String(musicListId);

  const r = await resolver.webCall('/pc/user/h5-import-musiclist/v1.0', body, 'post');
  const res = r && r.res;
  if (!r || !r.ok || !res || res.code !== '000000') {
    const info = (res && res.info) || r.err || '移除失败';
    if (isNeedLogin(res && res.code, info)) {
      logger.warn('[歌单] 未登录或登录已过期，无法移出歌单');
      return { ok: false, needLogin: true, error: '登录状态已失效，请重新登录' };
    }
    logger.warn(`[歌单] 移出失败（歌单=${musicListId || '我喜欢的'}）：${info}`);
    return { ok: false, error: info };
  }

  logger.info(`[歌单] 已从 ${musicListId || '我喜欢的'} 移出 ${ids.length} 首`);
  return { ok: true, removed: ids.length };
}

/** 查询这些歌曲分别在哪些歌单里 / 是否已在我喜欢 */
async function checkInPlaylists(contentIds) {
  const ids = (contentIds || []).filter(Boolean);
  if (!ids.length) return { lists: [], favMap: {} };
  const r = await resolver.webCall('/pc/v1.0/content/inMusicLists.do', {
    type: '1',
    contentId: ids.join('|'),
  });
  const res = r && r.res;
  if (!r || !r.ok || !res || res.code !== '000000') {
    const info = (res && res.info) || r.err || '';
    if (isNeedLogin(res && res.code, info)) logger.warn('[歌单] 未登录，无法查询歌曲所在歌单');
    return { lists: [], favMap: {}, needLogin: isNeedLogin(res && res.code, info) };
  }
  const od = res.originData || {};
  const favMap = {};
  for (const it of od.isInfavors || []) favMap[it.contentId] = it.isInfavor === '1';
  const lists = (Array.isArray(res.data) ? res.data : []).map(normList).filter(Boolean);
  return { lists, favMap };
}

module.exports = {
  getMyPlaylists,
  createPlaylist,
  deletePlaylist,
  addSongs,
  removeSongs,
  checkInPlaylists,
  getPlaylistSongs,
  getAllPlaylistSongs,
};
