/**
 * 会员歌曲播放验证：复用已登录的用户数据（副本），测试 resolver 能否拿到 VIP 曲目地址。
 * 运行：electron test-vip.js
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const REAL_UD = process.env.MIGU_TEST_UD || path.join(__dirname, 'dist', '咪咕音乐', 'resources', 'app', '.userdata');
const TEST_UD = path.join(__dirname, '.userdata-test');

// 复制一份登录数据，避免与正在运行的客户端争用同一 userData
if (!fs.existsSync(TEST_UD)) {
  console.log('复制登录数据副本…');
  fs.cpSync(REAL_UD, TEST_UD, { recursive: true });
}
app.setPath('userData', TEST_UD);

const LOG = path.join(__dirname, 'test-vip-output.txt');
fs.writeFileSync(LOG, '');
const say = (m = '') => {
  fs.appendFileSync(LOG, m + '\n');
  console.log(m);
};

const resolver = require('./src/resolver');
const { session } = require('electron');

// 会员/VIP 曲目
const CASES = [
  { name: '晴天', artists: ['周杰伦'], contentId: '600902000006889366', copyrightId: '60054701923', songId: '3790007' },
  { name: '圣诞星（feat. 杨瑞代）', artists: ['周杰伦'], contentId: '600929000000096577', copyrightId: '60054704965', songId: '1140505222' },
];

app.whenReady().then(async () => {
  try {
    say('=== 会员歌曲播放验证 ===\n');

    const cookies = await session.defaultSession.cookies.get({});
    say(`[0] 登录 Cookie：${cookies.length} 个` + (cookies.some((c) => c.name === 'idmpauth' || c.name === 'pacmtoken') ? '（含登录票据 ✓）' : '（无登录票据，可能未登录）'));

    const warmed = await resolver.prewarm ? true : true;
    const t0 = Date.now();
    // 预热并等待就绪
    let st = resolver.status();
    for (let i = 0; i < 30 && !st.ready; i++) {
      resolver.prewarm();
      await new Promise((r) => setTimeout(r, 1000));
      st = resolver.status();
    }
    say(`[1] 解析器状态：ready=${st.ready} 耗时=${((Date.now() - t0) / 1000).toFixed(1)}s ${st.lastError ? '错误=' + st.lastError : ''}`);
    if (!st.ready) {
      say('解析器未能就绪，后续测试跳过');
      app.exit(1);
      return;
    }

    // 可播放性
    say('\n[2] can-listen 检查：');
    const map = await resolver.canListen(CASES.map((c) => c.contentId));
    for (const c of CASES) {
      const info = map[c.contentId];
      say(`      ${c.name.padEnd(20)} ${info ? (info.canListen ? '可播放 ✓' : info.limitLength ? '仅试听' : '不可播放 ✗') : '无返回'}`);
    }

    // 实际取地址
    say('\n[3] 解析播放地址（会员歌曲）：');
    let okCount = 0;
    for (const c of CASES) {
      for (const tone of ['PQ', 'HQ', 'SQ']) {
        const r = await resolver.resolvePlayUrl(c, tone);
        if (r.url) {
          okCount++;
          say(`      ✓ ${c.name} [${tone} → ${r.tone}]`);
          say(`        ${String(r.url).slice(0, 130)}…`);
          say(`        歌词: ${r.lrcUrl ? '有' : '无'}`);
          break;
        } else {
          say(`      ✗ ${c.name} [${tone}] code=${(r.tried || []).join(',')} ${r.info || ''}`);
        }
      }
    }

    say(`\n=== ${okCount ? `成功解析 ${okCount}/${CASES.length} 首会员歌曲` : '未能解析任何会员歌曲'} ===`);
    resolver.destroy();
    app.exit(okCount ? 0 : 1);
  } catch (e) {
    say('异常：' + (e && e.stack ? e.stack : e));
    app.exit(2);
  }
});
