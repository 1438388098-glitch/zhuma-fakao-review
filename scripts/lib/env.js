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

/** 定位本机 Chrome。优先环境变量 CHROME_PATH。 */
function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    process.env.AGENT_BROWSER_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const hit = firstExisting(cands);
  if (!hit) {
    throw new Error('未找到本机 Chrome。请安装 Google Chrome，或设置环境变量 CHROME_PATH 指向 chrome 可执行文件。');
  }
  return hit;
}

/** 桌面目录：Windows 上可能在 OneDrive 下，不要用 ~/Desktop 猜。 */
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

/** 解析工作目录：--work 优先，否则当前目录 */
function workDir(args) {
  const w = (args && args.work) || process.cwd();
  const abs = path.resolve(w);
  if (!fs.existsSync(abs)) throw new Error('工作目录不存在：' + abs);
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

function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return def; }
}

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
  findChrome, desktopDir, parseArgs, workDir, scrapeDir, ensureDir,
  readJson, readProfile, layoutVars, layoutCssVars, DEFAULT_PROFILE,
};
