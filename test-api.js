/**
 * 纯 Node 环境下的 API 层自检（复用 src/migu-api.js，自动回退到全局 fetch）
 * 运行：node test-api.js
 */
const api = require('./src/migu-api');

let failed = 0;
const ok = (m) => console.log('  [PASS] ' + m);
const bad = (m) => {
  failed++;
  console.log('  [FAIL] ' + m);
};

(async () => {
  console.log('=== 咪咕 API 层自检 ===\n');

  console.log('[1] 搜索');
  let songs = [];
  try {
    const r = await api.search('晴天', 1, 10);
    songs = r.songs || [];
    if (songs.length) {
      ok(`搜索到 ${songs.length} 首`);
      const s = songs[0];
      console.log(`      例：${s.name} - ${s.artists.join('/')} | album=${s.album} | cid=${s.contentId} | sid=${s.songId} | albId=${s.albumId} | cover=${s.cover ? '有' : '无'} | vip=${s.vip}`);
    } else bad('无结果');
  } catch (e) {
    bad('异常 ' + e.message);
  }

  console.log('\n[2] 排行榜列表');
  let ranks = [];
  try {
    ranks = await api.rankIndex();
    if (ranks.length) ok(`${ranks.length} 个榜单，例：${ranks.slice(0, 3).map((r) => r.name).join(' / ')}`);
    else bad('为空');
  } catch (e) {
    bad('异常 ' + e.message);
  }

  console.log('\n[3] 榜单歌曲');
  let rankSongs = [];
  if (ranks.length) {
    try {
      const d = await api.rankSongs(ranks[0].rankId);
      rankSongs = d.songs || [];
      if (rankSongs.length) {
        ok(`《${d.title}》共 ${rankSongs.length} 首`);
        rankSongs.slice(0, 3).forEach((s, i) => console.log(`      ${i + 1}. ${s.name} - ${s.artists.join('/')} ${s.vip ? '[VIP]' : ''} ${s.duration}s 音质:${s.qualities.map((q) => q.type).join(',')}`));
      } else bad('为空');
    } catch (e) {
      bad('异常 ' + e.message);
    }
  }

  console.log('\n[4] 今日推荐');
  try {
    const t = await api.todayRecommend();
    if (t.songs.length) ok(`${t.date} · ${t.songs.length} 首，例：${t.songs[0].name}`);
    else bad('为空');
  } catch (e) {
    bad('异常 ' + e.message);
  }

  console.log('\n[5] 播放直链');
  const pool = [...rankSongs, ...songs];
  let played = 0;
  for (const s of pool.slice(0, 15)) {
    try {
      const r = await api.songUrl(s, { tone: 'PQ' });
      if (r.url) {
        ok(`可播放 ${s.name} - ${s.artists.join('/')}  音质=${r.tone}`);
        console.log('      ' + r.url.slice(0, 100) + '…');
        if (++played >= 3) break;
      } else {
        console.log(`      · 不可播 ${s.name}（${r.tried.join(',')}）`);
      }
    } catch (e) {
      console.log('      ! ' + s.name + ' ' + e.message);
    }
  }
  if (!played) bad('未取到任何播放直链');

  console.log('\n[6] 歌词');
  try {
    const w = [...songs, ...rankSongs].find((s) => s.lyricUrl);
    if (w) {
      const lrc = await api.lyric(w.lyricUrl);
      if (lrc && lrc.length > 10) {
        ok(`歌词 ${lrc.length} 字节`);
        console.log('      ' + lrc.split('\n').slice(0, 3).join(' | ').slice(0, 160));
      } else bad('歌词为空');
    } else console.log('      · 跳过（无歌词地址）');
  } catch (e) {
    bad('异常 ' + e.message);
  }

  console.log('\n=== ' + (failed ? failed + ' 项失败' : '全部通过') + ' ===');
  process.exit(failed ? 1 : 0);
})();
