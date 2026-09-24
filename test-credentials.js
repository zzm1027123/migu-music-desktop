/**
 * 自动登录凭证存储验证
 *
 * 重点：密码必须**加密落盘**，绝不明文。这里逐项验证：
 *   1. 本机有没有系统级加密能力（safeStorage）
 *   2. 存进去能原样读回来
 *   3. 磁盘上的文件里**搜不到明文密码**
 *   4. 清除后读不到
 *   5. 没有凭证时不会误报
 *
 * 运行：electron test-credentials.js
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const TEST_UD = path.join(__dirname, '.userdata-cred');
fs.mkdirSync(TEST_UD, { recursive: true });
app.setPath('userData', TEST_UD);

const credentials = require('./src/credentials');
const logger = require('./src/logger');
logger.init(TEST_UD);

const OUT = path.join(__dirname, 'test-cred-output.txt');
fs.writeFileSync(OUT, '');
const say = (m = '') => {
  fs.appendFileSync(OUT, m + '\n');
  console.log(m);
};
let failed = 0;
const ok = (m) => say('  [PASS] ' + m);
const bad = (m) => {
  failed++;
  say('  [FAIL] ' + m);
};

const USER = '13800001234';
const PASS = 'MySecretP@ssw0rd-明文不该出现在文件里';

app.whenReady().then(async () => {
  try {
    say('=== 自动登录凭证存储验证 ===\n');

    say('[1] 本机加密能力');
    const avail = credentials.available();
    if (avail) ok('safeStorage 可用（Windows 上走 DPAPI，密钥绑定当前用户）');
    else {
      bad('本机不支持系统加密 —— 那就应当拒绝保存，而不是退回明文');
      const r = credentials.save(TEST_UD, USER, PASS);
      if (!r.ok) ok('确实拒绝了保存：' + r.error);
      else bad('竟然还是保存了，有明文落盘风险');
      return done();
    }

    say('\n[2] 保存后能读回来');
    const saved = credentials.save(TEST_UD, USER, PASS);
    if (saved.ok) ok('保存成功');
    else return done('保存失败：' + saved.error);

    const loaded = credentials.load(TEST_UD);
    if (!loaded) return done('读不回来');
    if (loaded.username === USER) ok('账号一致：' + loaded.username);
    else bad(`账号不一致：${loaded.username}`);
    if (loaded.password === PASS) ok('密码一致（长度 ' + loaded.password.length + '）');
    else bad('密码不一致');

    say('\n[3] 磁盘上的文件必须是密文');
    const fp = credentials.filePath(TEST_UD);
    const raw = fs.readFileSync(fp);
    say(`      文件 ${path.basename(fp)}，${raw.length} 字节`);
    const asLatin = raw.toString('latin1');
    const asUtf8 = raw.toString('utf8');
    if (!asUtf8.includes(PASS) && !asLatin.includes(PASS)) ok('文件里搜不到明文密码');
    else bad('文件里竟然有明文密码！');
    if (!asUtf8.includes(USER)) ok('文件里也搜不到明文账号');
    else bad('文件里有明文账号');
    // 密文一般不含可打印长串
    const printable = (asLatin.match(/[\x20-\x7e]{8,}/g) || []).filter((s) => /[A-Za-z]{6}/.test(s));
    if (!printable.length) ok('内容看起来是纯二进制密文');
    else say('      · 文件里有可打印片段（不一定有问题）：' + printable.slice(0, 2).join(' / ').slice(0, 60));

    say('\n[4] 状态查询不会泄露密码');
    const st = { supported: credentials.available(), hasSaved: credentials.exists(TEST_UD), username: credentials.peekUsername(TEST_UD) };
    say('      ' + JSON.stringify(st));
    if (st.hasSaved && st.username === USER) ok('状态里能拿到账号名（用于界面显示）');
    else bad('状态不对');
    if (!JSON.stringify(st).includes(PASS)) ok('状态里没有密码字段');
    else bad('状态里混进了密码');

    say('\n[5] 清除之后应当读不到');
    credentials.clear(TEST_UD);
    if (!credentials.exists(TEST_UD)) ok('文件已删除');
    else bad('文件还在');
    if (!credentials.load(TEST_UD)) ok('读不到凭证了');
    else bad('清除后仍能读出来');
    if (credentials.peekUsername(TEST_UD) === '') ok('账号名也空了');
    else bad('账号名残留');

    say('\n[6] 空值不该被保存');
    const r1 = credentials.save(TEST_UD, '', 'x');
    const r2 = credentials.save(TEST_UD, 'x', '');
    if (!r1.ok && !r2.ok) ok('账号或密码为空时拒绝保存');
    else bad('空值竟然保存成功了');
  } catch (e) {
    bad('异常 ' + (e && e.stack ? e.stack : e));
  }

  done();
});

function done(err) {
  if (err) bad(err);
  say('\n=== ' + (failed ? failed + ' 项失败' : '凭证存储验证通过') + ' ===');
  app.exit(failed ? 1 : 0);
}
