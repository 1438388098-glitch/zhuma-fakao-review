/**
 * 阶段 1：扫码登录竹马法考（固定 profile，一次扫码长期有效）
 *
 * 用法：node scripts/01_login.js --work <工作目录> [--wait-min 12]
 *
 * 说明：
 *  - 使用 playwright-core + 本机 Chrome/Edge（不下载 Chromium）
 *  - 固定 userDataDir = <工作目录>/scrape/profile，后续脚本复用同一 profile（登录态只存这里）
 *  - 二维码导出到 <工作目录>/qr_login.png（若站点返回 JPEG 则为 qr_login.jpg），
 *    由主 Agent 用 present_files 发给用户
 *  - 轮询检测登录（默认最长 12 分钟，--wait-min 可调）；二维码过期会自动刷新重取
 *  - 成功后写 <工作目录>/scrape/login_ok.flag，供编排方快速判断
 *
 * 退出码：0 已登录 / 1 超时或登录校验失败 / 2 找不到或无法解码二维码（页面可能改版）
 */
const fs = require('fs');
const path = require('path');
const env = require('./lib/env.js');
const { chromium } = env.loadPlaywright();

const QR_URL = 'https://www.zhumavip.com/w/qrlogin';
const BOOK_URL = env.BOOK_URL;
const VIEWPORT = { width: 1600, height: 1000 };

const args = env.parseArgs(process.argv);
const WORK = env.workDir(args);
const SC = env.scrapeDir(WORK);
const PROFILE = path.join(SC, 'profile');
const WAIT_MIN = env.numArg(args, 'wait-min', 12, { min: 1, max: 60, int: true });

const log = env.log;
const sleep = env.sleep;
const poll = env.poll;

const findQrDataUrl = page => page.evaluate(() => {
  const im = [...document.images].filter(x => x.src.startsWith('data:image') && x.naturalWidth > 150)[0];
  return im ? im.src : null;
});

/**
 * 在 qrlogin 页面拿到二维码 dataURL。
 * 关键：切换扫码模式的图标用 JS 属性绑定 onclick，CSS 的 [onclick] 属性选择器匹配不到，
 * 必须用 i.onclick 属性过滤。页面可能本来就处于扫码模式 —— 先等 6s，没有二维码再点切换。
 */
async function obtainQr(page) {
  await page.goto(QR_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  let dataUrl = await poll(findQrDataUrl.bind(null, page), 6000, 1500);
  if (!dataUrl) {
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
    dataUrl = await poll(findQrDataUrl.bind(null, page), 18000, 1500);
  }
  return dataUrl;
}

/** 解码 data URL 并校验图片魔数，避免把非图片数据写成损坏文件 */
function decodeQr(dataUrl) {
  const m = String(dataUrl).match(/^data:image\/(\w+);base64,(.+)$/);
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8;
  return isPng || isJpeg ? { buf, ext: isPng ? 'png' : 'jpg' } : null;
}

function saveQr(qr) {
  const p = path.join(WORK, 'qr_login.' + qr.ext);
  // 清掉另一种扩展名的旧二维码，避免主 Agent 取到过期图片
  try { fs.unlinkSync(path.join(WORK, 'qr_login.' + (qr.ext === 'png' ? 'jpg' : 'png'))); } catch (e) { /* 不存在则忽略 */ }
  fs.writeFileSync(p, qr.buf);
  return p;
}

(async () => {
  const CHROME = env.findChrome();
  log('chrome =', CHROME);
  log('profile =', PROFILE);

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: CHROME,
    headless: true,
    viewport: VIEWPORT,
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  try {
    const page = ctx.pages()[0] || await ctx.newPage();

    // 已登录检测：打开错题本页，未登录会被重定向到 qrlogin。
    // 用 waitForURL 给 8s 窗口等重定向（服务端 302 或客户端 JS 延迟跳转都能等到），
    // 首次没跳再复核一次，两次都没跳才判定已登录 —— 避免 domcontentloaded 后
    // 客户端 JS 鉴权跳转尚未来得及执行时误判"已登录"。
    const jumpedToQr = () => page.waitForURL(/qrlogin/, { timeout: 8000 }).then(() => true).catch(() => false);
    await page.goto(BOOK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    let needLogin = await jumpedToQr();
    if (!needLogin) {
      await page.goto(BOOK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      needLogin = await jumpedToQr();
    }
    if (!needLogin) {
      log('ALREADY LOGGED IN, url =', page.url().slice(0, 90));
      fs.writeFileSync(path.join(SC, 'login_ok.flag'), page.url(), 'utf8');
      return 0;
    }

    let qr = decodeQr(await obtainQr(page));
    if (!qr) {
      log('NO QR FOUND —— 页面结构可能已改版，请检查 references/api_reference.md');
      return 2;
    }
    log('QR saved ->', saveQr(qr));
    log('>>> 请把二维码图片发给用户，并提示用「竹马 APP」扫码（不是微信）');

    const deadline = Date.now() + WAIT_MIN * 60 * 1000;
    let ok = false;
    while (Date.now() < deadline) {
      await sleep(3000);
      let st;
      try { st = await page.evaluate(() => ({ url: location.href, txt: document.body ? document.body.innerText.slice(0, 300) : '' })); }
      catch (e) { continue; }
      if (!st.url.includes('qrlogin') || /退出/.test(st.txt)) { ok = true; break; }
      // 二维码过期：页面提示失效/过期时自动刷新重取，不让用户干等到超时
      if (/失效|过期/.test(st.txt)) {
        log('二维码已过期，自动刷新…');
        qr = decodeQr(await obtainQr(page));
        if (!qr) { log('刷新后未取到二维码，退出'); return 2; }
        log('新二维码已保存 ->', saveQr(qr));
        log('>>> 请把新二维码发给用户扫码');
      }
    }
    log('login detected:', ok);
    if (!ok) {
      log('超时未检测到登录，请重跑本脚本或加大 --wait-min');
      return 1;
    }

    // 登录后验证：回到错题本页，等 20s 看是否被踢回登录页，没被踢回才算成功
    await page.goto(BOOK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const backToQr = await page.waitForURL(/qrlogin/, { timeout: 20000 }).then(() => true).catch(() => false);
    if (backToQr) {
      log('VERIFY FAILED —— 扫码后仍未进入错题本，请重跑本脚本');
      return 1;
    }
    log('verify: OK');
    fs.writeFileSync(path.join(SC, 'login_ok.flag'), page.url(), 'utf8');
    log('>>> 登录成功，可执行 scripts/02_scrape.js');
    return 0;
  } finally {
    // 任何路径（含异常）都关闭浏览器，否则孤儿 Chrome 会锁死 profile 目录，
    // 下次启动直接失败（Windows 下同一 user-data-dir 不能被两个实例共用）
    await ctx.close().catch(() => {});
  }
})()
  .then(c => { process.exitCode = c || 0; })
  .catch(e => { console.error('FATAL', (e && e.stack) || e); process.exitCode = 1; });
