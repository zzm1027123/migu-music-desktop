/**
 * can-listen 接口诊断：为什么能播的歌被标成「受限」
 *
 * 日志证据：`[播放解析] 成功 雾里 - 姚六一 音质=SQ` —— 实际能播，界面却标了「受限」。
 * 这里把接口的**原始返回**打出来，看是不是漏读了字段、或者判定本身不对。
 *
 * 运行：electron test-canlisten.js
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const { prepareUserData } = require('./test-util');
app.setPath('userData', prepareUserData('.userdata-canlisten'));

const resolver = require('./src/resolver');
const api = require('./src/migu-api');

const OUT = path.join(__dirname, 'test-canlisten-output.txt');
fs.writeFileSync(OUT, '');
const say = (m = '') => {
  fs.appendFileSync(OUT, m + '\n');
  console.log(m);
};

app.whenReady().then(async () => {
  try {
    // ---------- [1] 找到「雾里 - 姚六一」的正确版本 ----------
    say('=== [1] 搜索「雾里」，挑出姚六一那版 ===');
    const r = await api.search('雾里', 1);
    const all = (r && r.songs) || [];
    say(`  搜到 ${all.length} 条，前 8 条：`);
    for (const s of all.slice(0, 8)) {
      const isTarget = String(s.name).trim() === '雾里' && /姚六一/.test(String(s.artist || ''));
      say(`  ${isTarget ? '→' : ' '} ${String(s.name).padEnd(18)} ${String(s.artist || '').padEnd(14)} id=${s.contentId} vip=${s.vip ? 'Y' : '-'}`);
    }
    const target = all.find((s) => String(s.name).trim() === '雾里' && /姚六一/.test(String(s.artist || ''))) || all[0];
    if (!target) {
      say('没搜到，无法继续');
      app.exit(1);
      return;
    }
    say(`\n  选中：${target.name} - ${target.artist}  id=${target.contentId}`);
    say(`  完整字段：` + JSON.stringify(target, null, 2).replace(/\n/g, '\n  '));

    const ids = [target.contentId, ...all.slice(0, 5).map((s) => s.contentId)];

    // ---------- [2] can-listen 原始返回（method 必须小写）----------
    say('\n=== [2] can-listen 原始返回 ===');
    try {
      const raw = await resolver.webCall(
        '/strategy/pc/can-listen/v1.0',
        { contentIds: ids.join(','), curPlayContentId: '' },
        'post'
      );
      say('  ' + JSON.stringify(raw, null, 2).replace(/\n/g, '\n  '));
    } catch (e) {
      say('  调用异常：' + ((e && e.message) || e));
    }

    // ---------- [3] 客户端解析出来的 ----------
    say('\n=== [3] resolver.canListen 解析结果 ===');
    const map = await resolver.canListen(ids);
    for (const s of all.slice(0, 6)) {
      const info = map[s.contentId];
      say(`  ${String(s.name).padEnd(18)} ${info ? JSON.stringify(info) : '(无返回)'}`);
    }

    // ---------- [4] 实际能不能播 ----------
    say('\n=== [4] 实际解析播放地址 ===');
    for (const s of all.slice(0, 6)) {
      const info = map[s.contentId];
      let canPlay = false;
      let detail = '';
      try {
        const u = await resolver.resolvePlayUrl(s, 'SQ');
        canPlay = !!(u && u.url);
        detail = canPlay ? `音质=${u.tone || '?'}` : (u && u.info) || '';
      } catch (e) {
        detail = (e && e.message) || String(e);
      }
      const judged = info ? (info.canListen ? '可播' : info.limitLength ? '试听' : '受限') : '无返回';
      const warn = info && !info.canListen && canPlay ? '  ⚠ 误标！' : '';
      say(`  ${String(s.name).padEnd(18)} 判定=${judged.padEnd(4)} 实际=${canPlay ? '能播' : '不能播'}  ${detail}${warn}`);
    }
  } catch (e) {
    say('诊断异常：' + (e && e.stack ? e.stack : e));
  }
  app.exit(0);
});
