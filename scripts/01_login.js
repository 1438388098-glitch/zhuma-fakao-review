/**
 * 阶段 1：扫码登录竹马法考（固定 profile，一次扫码长期有效）
 *
 * 用法：node scripts/01_login.js --work <工作目录>
 *
 * 说明：
 *  - 使用 playwright-core + 本机 Chrome（不下载 Chromium）
 *  - 固定 userDataDir = <工作目录>/scrape/profile，后续脚本复用同一 profile
 *  - 二维码导出到 <工作目录>/qr_login.png，由主 Agent 用 present_files 发给用户
 *  - 轮询最长 12 分钟，扫码成功后落盘登录态
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const env = require('./lib/env.js');

const QR_URL = 'https://www.zhumavip.com/w/qrlogin';
const BOOK_URL = 'https://www.zhumavip.com/w/my/errorbooks?businessType=104'
  + '&businessName=%E6%B3%95%E5%BE%8B%E8%81%8C%E4%B8%9A%E8%B5%84%E6%A0%BC%E8%80%83%E8%AF%95'
  + '&legalQuestionType=0&queType=%E9%94%99%E9%A2%98%E6%9C%AC&mineType=01';

const args = env.parseArgs(process.argv);
const WORK = env.workDir(args);
const SC = env.scrapeDir(WORK);
const PROFILE = path.join(SC, 'profile');
const WAIT_MIN = Number(args['wait-min'] || 12);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

(async () => {
  const CHROME = env.findChrome();
  log('chrome =', CHROME);
  log('profile =', PROFILE);

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: CHROME,
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  // 已登录则直接跳过
  await page.goto(BOOK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  if (!page.url().includes('qrlogin')) {
    log('ALREADY LOGGED IN, url =', page.url().slice(0, 90));
    fs.writeFileSync(path.join(SC, 'login_ok.flag'), page.url(), 'utf8');
    await ctx.close();
    process.exit(0);
  }

  await page.goto(QR_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);
  log('opened qrlogin');

  // 关键：切换扫码模式的图标用 JS 属性绑定 onclick，CSS 的 [onclick] 属性选择器匹配不到，
  // 必须用 i.onclick 属性过滤。
  const clicked = await page.evaluate(() => {
    const cands = [...document.querySelectorAll('img')].filter(i => i.onclick);
    if (!cands.length) return 'NOIMG';
    const h = [...document.querySelectorAll('*')]
      .filter(e => e.children.length === 0 && (e.textContent || '').trim() === '手机号登录/注册')[0];
    let target = cands[0];
    if (h) {
      let n = h;
      for (let i = 0; i < 8 && n; i++) n = n.parentElement;
      if (n) { const inCard = cands.filter(i => n.contains(i)); if (inCard.length) target = inCard[0]; }
    }
    target.click();
    return 'CLICKED';
  });
  log('qr toggle:', clicked);

  let dataUrl = null;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(1500);
    dataUrl = await page.evaluate(() => {
      const im = [...document.images].filter(x => x.src.startsWith('data:image') && x.naturalWidth > 150)[0];
      return im ? im.src : null;
    });
    if (dataUrl) break;
  }
  if (!dataUrl) {
    log('NO QR FOUND —— 页面结构可能已改版，请检查 references/api_reference.md');
    await ctx.close();
    process.exit(2);
  }
  const png = path.join(WORK, 'qr_login.png');
  fs.writeFileSync(png, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
  log('QR saved ->', png);
  log('>>> 请把 qr_login.png 发给用户，并提示用「竹马 APP」扫码（不是微信）');

  const deadline = Date.now() + WAIT_MIN * 60 * 1000;
  let ok = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    let st;
    try { st = await page.evaluate(() => ({ url: location.href, txt: document.body ? document.body.innerText : '' })); }
    catch (e) { continue; }
    if (!st.url.includes('qrlogin') || /退出/.test(st.txt)) { ok = true; break; }
  }
  log('login detected:', ok);

  if (ok) {
    await page.goto(BOOK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000);
    const v = await page.evaluate(() => ({ url: location.href, txt: document.body.innerText.slice(0, 120) }));
    const good = !v.url.includes('qrlogin');
    log('verify:', good ? 'OK' : 'STILL LOGGED OUT');
    fs.writeFileSync(path.join(SC, 'state.json'), JSON.stringify(await ctx.storageState(), null, 2), 'utf8');
    if (good) fs.writeFileSync(path.join(SC, 'login_ok.flag'), v.url, 'utf8');
    if (good) log('>>> 登录成功，可执行 scripts/02_scrape.js');
    await ctx.close();
    process.exit(good ? 0 : 1);
  }

  log('超时未检测到登录，请重跑本脚本或加大 --wait-min');
  await ctx.close();
  process.exit(1);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
