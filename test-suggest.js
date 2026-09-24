/**
 * 搜索预测验证：热门搜索、输入联想、点击/键盘选择、高亮
 * 运行：electron test-suggest.js
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const TEST_UD = path.join(__dirname, '.userdata-suggest');
fs.rmSync(TEST_UD, { recursive: true, force: true });
fs.mkdirSync(TEST_UD, { recursive: true });
app.setPath('userData', TEST_UD);

const { registerIpc } = require('./src/ipc');
const logger = require('./src/logger');
logger.init(TEST_UD);

const OUT = path.join(__dirname, 'test-suggest-output.txt');
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
  getSettings: () => ({}),
  setSettings: (p) => p,
});

const PANEL_STATE = `JSON.stringify({
  shown: document.getElementById('suggestPanel').classList.contains('show'),
  groups: [...document.querySelectorAll('#suggestPanel .suggest-group')].map(e => e.textContent),
  items: [...document.querySelectorAll('#suggestPanel .suggest-item')].map(e => ({
    text: e.querySelector('.si-text').textContent,
    tag: e.querySelector('.si-tag') ? e.querySelector('.si-tag').textContent : '',
    hi: !!e.querySelector('.si-text em')
  }))
})`;

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
    say('=== 搜索预测验证 ===\n');
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    await wait(6000);

    say('[1] 空输入聚焦 -> 热门搜索');
    await win.webContents.executeJavaScript(
      `(()=>{const i=document.getElementById('searchInput'); i.focus();
         i.dispatchEvent(new Event('input',{bubbles:true})); return 1})()`,
      true
    );
    await wait(2500);
    const hot = JSON.parse(await win.webContents.executeJavaScript(PANEL_STATE, true));
    say('      分组：' + JSON.stringify(hot.groups) + ' 共 ' + hot.items.length + ' 项');
    say('      前几项：' + hot.items.slice(0, 5).map((x) => x.text).join(' / '));
    if (hot.shown && hot.items.length > 0 && hot.groups.join('').includes('热门搜索'))
      ok('聚焦空搜索框时展示热门搜索词');
    else bad('热门搜索未显示：' + JSON.stringify(hot));

    say('\n[2] 输入「周杰」-> 联想');
    await win.webContents.executeJavaScript(
      `(()=>{const i=document.getElementById('searchInput'); i.value='周杰';
         i.dispatchEvent(new Event('input',{bubbles:true})); return 1})()`,
      true
    );
    await wait(2800);
    const sug = JSON.parse(await win.webContents.executeJavaScript(PANEL_STATE, true));
    say('      分组：' + JSON.stringify(sug.groups));
    for (const it of sug.items.slice(0, 6)) say(`      · ${it.text} ${it.tag}`);
    if (sug.shown && sug.items.length > 0) ok(`联想返回 ${sug.items.length} 条建议`);
    else bad('联想没有返回内容');
    if (sug.groups.join('').includes('歌手')) ok('建议里有「歌手」分组');
    else bad('缺少歌手分组：' + JSON.stringify(sug.groups));
    if (sug.items.some((x) => x.hi)) ok('命中的关键词已高亮');
    else bad('没有高亮命中部分');

    // 截图（面板展开状态）
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, 'screenshot-suggest.png'), img.toPNG());
    say('      截图：screenshot-suggest.png');

    say('\n[3] 点击建议项');
    const firstText = sug.items[0].text;
    await win.webContents.executeJavaScript(
      `(()=>{const el=document.querySelector('#suggestPanel .suggest-item');
         el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return 1})()`,
      true
    );
    await wait(6000);
    const afterClick = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({
           input: document.getElementById('searchInput').value,
           panelShown: document.getElementById('suggestPanel').classList.contains('show'),
           rows: document.querySelectorAll('#searchList .song-row').length,
           title: document.querySelector('.page-title') ? document.querySelector('.page-title').textContent : ''
         })`,
        true
      )
    );
    say('      ' + JSON.stringify(afterClick));
    if (afterClick.input === firstText) ok('点选后搜索框填入建议词：' + firstText);
    else bad(`搜索框内容不符：期望 ${firstText}，实际 ${afterClick.input}`);
    if (!afterClick.panelShown) ok('点选后预测面板自动收起');
    else bad('点选后面板没有收起');
    if (afterClick.rows > 0) ok(`并直接搜出 ${afterClick.rows} 条结果`);
    else bad('点选后没有触发搜索');

    say('\n[4] 键盘导航：↓ 选中 + Enter');
    await win.webContents.executeJavaScript(
      `(()=>{const i=document.getElementById('searchInput'); i.value='晴天';
         i.dispatchEvent(new Event('input',{bubbles:true})); return 1})()`,
      true
    );
    await wait(2800);
    const nav = JSON.parse(
      await win.webContents.executeJavaScript(
        `(()=>{
           const i=document.getElementById('searchInput');
           i.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
           const a=document.querySelector('#suggestPanel .suggest-item.active .si-text');
           i.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
           const b=document.querySelector('#suggestPanel .suggest-item.active .si-text');
           return JSON.stringify({first:a?a.textContent:null, second:b?b.textContent:null});
         })()`,
        true
      )
    );
    say('      ↓ 两次选中：' + JSON.stringify(nav));
    if (nav.first && nav.second && nav.first !== nav.second) ok('上下键可以在建议间移动');
    else bad('方向键导航无效：' + JSON.stringify(nav));

    await win.webContents.executeJavaScript(
      `(()=>{document.getElementById('searchInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return 1})()`,
      true
    );
    await wait(6000);
    const afterEnter = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({
           input: document.getElementById('searchInput').value,
           rows: document.querySelectorAll('#searchList .song-row').length
         })`,
        true
      )
    );
    say('      ' + JSON.stringify(afterEnter));
    if (afterEnter.input === nav.second) ok('Enter 采用当前选中的建议：' + nav.second);
    else bad(`Enter 未采用选中项：期望 ${nav.second}，实际 ${afterEnter.input}`);
    if (afterEnter.rows > 0) ok(`并搜出 ${afterEnter.rows} 条结果`);
    else bad('Enter 后没有搜索结果');

    say('\n[5] 搜索框快捷清除按钮');
    const beforeClear = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({
           hasBtn: !!document.getElementById('clearSearchBtn'),
           opacity: getComputedStyle(document.getElementById('clearSearchBtn')).opacity,
           input: document.getElementById('searchInput').value
         })`,
        true
      )
    );
    say('      清除前（输入框有内容）：' + JSON.stringify(beforeClear));
    if (beforeClear.hasBtn && Number(beforeClear.opacity) > 0.5) ok('有内容时清除按钮可见');
    else bad('清除按钮未显示：' + JSON.stringify(beforeClear));

    // 拍一张「有内容 + 清除按钮可见」的样子
    await win.webContents.executeJavaScript(
      `(()=>{document.getElementById('searchInput').blur();return 1})()`,
      true
    );
    await wait(900);
    const imgHasText = await win.webContents.capturePage({
      x: 180,
      y: 8,
      width: 480,
      height: 48,
    });
    fs.writeFileSync(path.join(__dirname, 'screenshot-clear-search.png'), imgHasText.toPNG());
    say('      截图（有内容时）：screenshot-clear-search.png');
    await win.webContents.executeJavaScript(
      `(()=>{document.getElementById('searchInput').focus();return 1})()`,
      true
    );
    await wait(400);

    await win.webContents.executeJavaScript(
      `(()=>{document.getElementById('clearSearchBtn').click();return 1})()`,
      true
    );
    await wait(2500);
    const afterClear = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({
           input: document.getElementById('searchInput').value,
           opacity: getComputedStyle(document.getElementById('clearSearchBtn')).opacity,
           focused: document.activeElement === document.getElementById('searchInput'),
           panelShown: document.getElementById('suggestPanel').classList.contains('show'),
           groups: [...document.querySelectorAll('#suggestPanel .suggest-group')].map(e => e.textContent)
         })`,
        true
      )
    );
    say('      清除后：' + JSON.stringify(afterClear));
    if (afterClear.input === '') ok('输入框已清空');
    else bad('输入框没清空：' + afterClear.input);
    if (Number(afterClear.opacity) < 0.5) ok('清除按钮自动隐藏');
    else bad('清除按钮仍可见');
    if (afterClear.focused) ok('焦点仍在输入框（可直接继续输入）');
    else bad('焦点丢失');
    if (afterClear.groups.join('').includes('热门搜索')) ok('清除后回到热门搜索建议');
    else bad('清除后建议面板异常：' + JSON.stringify(afterClear.groups));
  } catch (e) {
    bad('异常 ' + (e && e.stack ? e.stack : e));
  }

  say('\n=== ' + (failed ? failed + ' 项失败' : '搜索预测验证通过') + ' ===');
  try {
    win.destroy();
  } catch {}
  app.exit(failed ? 1 : 0);
});
