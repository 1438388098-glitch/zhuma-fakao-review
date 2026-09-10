/**
 * 公共环境探测与工具函数。
 * 所有脚本共用：不硬编码 Node / Chrome / 桌面路径（这些在不同机器、不同版本上会变）。
 */
const fs = require('fs');
const path = require('path');

function firstExisting(list) {
  for (const p of list) {
    try { if (p && fs.existsSync(p)) return p; } catch (e) { /* ignore */ }
  }
  return null;
}

/** 定位本机 Chrome / Edge。优先环境变量 CHROME_PATH / AGENT_BROWSER_EXECUTABLE_PATH。 */
function findChrome() {
  const explicit = [process.env.CHROME_PATH, process.env.AGENT_BROWSER_EXECUTABLE_PATH].filter(Boolean);
  for (const p of explicit) {
    try { if (fs.existsSync(p)) return p; } catch (e) { /* ignore */ }
  }
  if (explicit.length) {
    console.error('WARN: CHROME_PATH / AGENT_BROWSER_EXECUTABLE_PATH 已设置但指向的文件不存在，回退到自动探测。');
  }
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const hit = firstExisting(cands);
  if (!hit) {
    throw new Error('未找到本机 Chrome / Edge。请安装 Google Chrome（或 Microsoft Edge），或设置环境变量 CHROME_PATH 指向浏览器可执行文件。');
  }
  return hit;
}

/** 桌面目录：Windows 上可能在 OneDrive 下，不要用 ~/Desktop 猜。可能返回 null，调用方需判空。 */
function desktopDir() {
  const cands = [
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'OneDrive', '桌面'),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'OneDrive', 'Desktop'),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'Desktop'),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, '桌面'),
    path.join(require('os').homedir(), 'Desktop'),
  ];
  return firstExisting(cands);
}

/** 极简命令行参数解析：--key value / --flag */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

/**
 * 读取数值型命令行参数。--key 忘给值（args[key] === true）或非法值时按 def 兜底；
 * 给了值但不是合法数字 / 超出范围时直接抛错 —— 避免 Number(true)=1、NaN 按 0ms 处理之类的静默陷阱。
 */
function numArg(args, key, def, opt = {}) {
  const { min = -Infinity, max = Infinity, int = false } = opt;
  let v = args ? args[key] : undefined;
  if (v === undefined || v === true || v === '') v = def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`参数 --${key} 不是有效数字：${JSON.stringify(v)}`);
  if (int && !Number.isInteger(n)) throw new Error(`参数 --${key} 必须是整数：${v}`);
  if (n < min || n > max) throw new Error(`参数 --${key} 超出允许范围 [${min}, ${max}]：${n}`);
  return n;
}

/** 解析工作目录：--work 优先，否则当前目录。必须是已存在的目录。 */
function workDir(args) {
  const w = (args && args.work) || process.cwd();
  const abs = path.resolve(String(w));
  if (!fs.existsSync(abs)) throw new Error('工作目录不存在：' + abs);
  if (!fs.statSync(abs).isDirectory()) throw new Error('工作目录路径不是一个目录：' + abs);
  return abs;
}

function scrapeDir(work) {
  const d = path.join(work, 'scrape');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * 读 JSON。文件不存在返回 def；存在但解析失败时告警后也返回 def ——
 * 让调用方能区分"没有"与"坏了"，避免截断文件被当成"未抓取"静默重抓。
 */
function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(`WARN: ${file} 读取/解析失败（${e.message}），将按不存在处理`);
    }
    return def;
  }
}

/** 原子写文本：先写临时文件再 rename，进程中途被杀不会留下截断文件（Windows 下 rename 会覆盖同名）。 */
function writeFileAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

/** 原子写 JSON。pretty 传数字表示缩进空格数，默认紧凑。 */
function writeJsonAtomic(file, data, pretty) {
  writeFileAtomic(file, JSON.stringify(data, null, pretty === undefined ? 0 : pretty));
}

/** 进程级互斥锁（防止同目录跑两个实例互相覆盖）。返回是否拿到锁；锁超过 2 小时视为过期可抢占。 */
function acquireLock(file) {
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < 2 * 60 * 60 * 1000) return false;
    console.error('WARN: 发现超过 2 小时的过期锁文件，视为残留并覆盖。');
  } catch (e) { /* 不存在，正常 */ }
  fs.writeFileSync(file, String(process.pid), 'utf8');
  return true;
}

function releaseLock(file) { try { fs.unlinkSync(file); } catch (e) { /* ignore */ } }

/** 加载 playwright-core，失败时给出可操作的安装指引（而不是裸的 Cannot find module 堆栈）。 */
function loadPlaywright() {
  try {
    return require('playwright-core');
  } catch (e) {
    throw new Error(
      '未找到 playwright-core。请先安装并设置 NODE_PATH：\n' +
      '  npm install playwright-core --prefix <隔离目录>\n' +
      '  export NODE_PATH=<隔离目录>/node_modules   （Git Bash）\n' +
      `当前 NODE_PATH=${process.env.NODE_PATH || '(未设置)'}`
    );
  }
}

/** 本地时区 HH:MM:SS（不用 ISO 的 UTC，避免中国用户看到慢 8 小时的日志时间）。 */
function log(...a) {
  console.log(new Date().toTimeString().slice(0, 8), ...a);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 轮询等待 fn() 返回真值（fn 允许返回 Promise / 抛错），超时返回 null。替代固定 sleep 的时序假设。 */
async function poll(fn, timeoutMs, stepMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v) return v;
    await sleep(stepMs);
  }
  return null;
}

/** 错题本入口页（登录检测与鉴权头捕获都用它） */
const BOOK_URL = 'https://www.zhumavip.com/w/my/errorbooks?businessType=104'
  + '&businessName=%E6%B3%95%E5%BE%8B%E8%81%8C%E4%B8%9A%E8%B5%84%E6%A0%BC%E8%80%83%E8%AF%95'
  + '&legalQuestionType=0&queType=%E9%94%99%E9%A2%98%E6%9C%AC&mineType=01';

/** 学情档案；未提供时使用默认值 */
const DEFAULT_PROFILE = {
  layout: 'compact',
  output_granularity: 'both',
  note_focus: 'comprehensive',
  weak_subjects: [],
  review_round: '二轮强化',
  days_to_exam: null,
  daily_minutes: 60,
  study_habit: '',
  target: '',
};

function readProfile(work) {
  return Object.assign({}, DEFAULT_PROFILE, readJson(path.join(work, 'study_profile.json'), {}));
}

/** 排版密度 → CSS 变量（由 assets/pdf_style.css 消费） */
function layoutVars(layout) {
  const map = {
    compact: { '--doc-font': '9.3pt', '--doc-lh': '1.45', '--tbl-font': '8.8pt', '--tbl-pad': '0.8mm', '--margin-v': '11mm', '--margin-h': '10mm', '--gap-h': '4mm', '--gap-p': '1.2mm' },
    normal: { '--doc-font': '10.5pt', '--doc-lh': '1.65', '--tbl-font': '9.8pt', '--tbl-pad': '1.2mm', '--margin-v': '16mm', '--margin-h': '14mm', '--gap-h': '6mm', '--gap-p': '2mm' },
    loose: { '--doc-font': '11.5pt', '--doc-lh': '1.9', '--tbl-font': '10.5pt', '--tbl-pad': '1.8mm', '--margin-v': '20mm', '--margin-h': '18mm', '--gap-h': '8mm', '--gap-p': '3mm' },
  };
  return map[layout] || map.compact;
}

/** 把布局变量渲染成 :root { ... } */
function layoutCssVars(layout) {
  const v = layoutVars(layout);
  return ':root{' + Object.entries(v).map(([k, val]) => `${k}:${val};`).join('') + '}';
}

module.exports = {
  findChrome, desktopDir, parseArgs, numArg, workDir, scrapeDir, ensureDir,
  readJson, writeFileAtomic, writeJsonAtomic, acquireLock, releaseLock,
  loadPlaywright, log, sleep, poll, BOOK_URL, readProfile, layoutVars, layoutCssVars, DEFAULT_PROFILE,
};
