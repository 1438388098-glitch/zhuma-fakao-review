/**
 * 阶段 5.2：汇总审查报告，生成统一修订清单（在 04_render_pdf.js 之前运行！）
 *
 * 用法：node scripts/05_review_aggregate.js --work <工作目录>
 *
 * 读取 scrape/reviews/*.md（审查员按 assets/review_prompt_template.md 输出），
 * 解析出问题条目，按「科目 → 严重度」排序，产出 scrape/reviews/_fixlist.md。
 *
 * 防呆设计（审查闭环的最后一道闸）：
 *  - 严重度容忍加粗/后缀（**P0**、P0（阻断）均识别为 P0）
 *  - 表格单元格支持 \| 转义；无法解析的行会计数并逐条告警
 *  - 解析条数与报告的「结论摘要」交叉核对，不一致即告警
 *  - 有报告却一条都解析不出来时按错误退出（exit 2），绝不产出"无需修订"的假绿灯
 *  - 报告早于笔记最后修改时间时告警（统计可能不含最新修订）
 *
 * 退出码：0 成功 / 2 缺输入或解析结果为空
 */
const fs = require('fs');
const path = require('path');
const env = require('./lib/env.js');

const args = env.parseArgs(process.argv);
let WORK;
try {
  WORK = env.workDir(args);
} catch (e) { console.error('FATAL', (e && e.message) || e); process.exit(2); }
const SC = env.scrapeDir(WORK);
const REVIEWS = path.join(SC, 'reviews');
const NOTES = path.join(SC, 'notes');
const MANIFEST = path.join(SC, 'units_manifest.json');

if (!fs.existsSync(REVIEWS)) {
  console.error('未找到 scrape/reviews/，请先分派审查 subagent');
  process.exit(2);
}

const SEV_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** 输出表格时转义单元格（竖线与换行会破坏 Markdown 表格） */
const escCell = c => String(c === undefined || c === null ? '' : c).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** 解析一行 Markdown 表格行（支持 \| 转义） */
function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map(c => c.trim().replace(/\\\|/g, '|'));
}

/** 从严重度单元格提取 P0–P3；容忍 **P0**、P0（阻断）、P0/xxx 等写法，识别不了返回 null */
function parseSev(cell) {
  const m = String(cell).replace(/\*/g, '').trim().toUpperCase().match(/P([0-3])(?![0-9])/);
  return m ? 'P' + m[1] : null;
}

/** 解析报告的「结论摘要」小节：- P0: n 条, P1: n 条 ...；没有该小节返回 null。
 *  节界兼容 h2–h6 子标题（`###` 子节里的数字不会误算进摘要）。 */
function parseSummary(txt) {
  const sec = txt.match(/^##\s*结论摘要[\s\S]*?(?=\n#{2,6}\s|\s*$)/m);
  if (!sec) return null;
  const out = {};
  for (const m of sec[0].matchAll(/P([0-3])\s*[:：]\s*(\d+)/g)) out['P' + m[1]] = Number(m[2]);
  return Object.keys(out).length ? out : null;
}

const warnings = [];
const warn = m => { warnings.push(m); console.error('WARN:', m); };

function parseReport(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const base = path.basename(file, '.md');
  const [subject, dim] = base.split('__');
  const items = [];
  let skipped = 0;
  for (const line of txt.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = splitRow(line);
    if (cells.length < 6) { skipped++; continue; }
    // 表头行与分隔行是正常结构，不计入"无法解析"
    if (cells.every(c => /^:?-+:?$/.test(c))) continue;
    if (/^#(\d+)?$/i.test(cells[0]) || /严重度|severity/i.test(cells[1])) continue;
    const sev = parseSev(cells[1]);
    if (!sev) { skipped++; continue; } // 数据行但严重度写错
    items.push({
      severity: sev,
      location: cells[2],
      problem: cells[3],
      fix: cells[4],
      evidence: cells[5],
      subject, dimension: dim, report: base,
    });
  }
  if (skipped) warn(`${base}: ${skipped} 行表格无法解析（列数不足或严重度无法识别），已跳过 —— 请核对该报告格式`);
  // 交叉核对：表格解析条数 vs 报告自己声明的结论摘要
  const sum = parseSummary(txt);
  const counted = { P0: 0, P1: 0, P2: 0, P3: 0 };
  items.forEach(i => counted[i.severity]++);
  if (sum) {
    for (const k of Object.keys(SEV_ORDER)) {
      if (sum[k] !== undefined && sum[k] !== counted[k]) {
        warn(`${base}: 结论摘要称 ${k} ${sum[k]} 条，但表格实际解析出 ${counted[k]} 条 —— 请核对该报告`);
      }
    }
  }
  return items;
}

const files = fs.readdirSync(REVIEWS).filter(f => f.endsWith('.md') && !f.startsWith('_'));
if (!files.length) { console.error('scrape/reviews/ 下没有审查报告'); process.exit(2); }

// 报告时效检查：报告早于笔记最后修改时间 => 笔记在审查后被修订过，统计可能已过时。
// 汇总成一条告警，避免修订轮下逐报告刷屏淹没真正的解析告警。
let newestNote = 0;
if (fs.existsSync(NOTES)) {
  for (const f of fs.readdirSync(NOTES)) {
    try { newestNote = Math.max(newestNote, fs.statSync(path.join(NOTES, f)).mtimeMs); } catch (e) { /* ignore */ }
  }
}
if (newestNote) {
  const stale = [];
  for (const f of files) {
    try { if (fs.statSync(path.join(REVIEWS, f)).mtimeMs < newestNote) stale.push(f); } catch (e) { /* ignore */ }
  }
  if (stale.length) {
    warn(`${stale.length} 份审查报告早于笔记最新修改时间（笔记在审查后被修订过）：${stale.join('、')} —— 修订时请以报告与当前笔记的比对为准，勿按本清单重复修订已修复项`);
  }
}

let all = [];
for (const f of files) all.push(...parseReport(path.join(REVIEWS, f)));

// 假绿灯防护：有报告却零解析 => 大概率格式问题，按错误退出而不是宣布"无需修订"
if (!all.length) {
  console.error('所有审查报告都没有解析出任何问题条目 —— 要么确实零问题（极罕见），要么报告不符合约定格式。');
  console.error('为避免"假绿灯"，本次不生成修订清单。请抽查 scrape/reviews/ 下的报告格式（表格 6 列、严重度写 P0–P3）后重跑。');
  process.exit(2);
}

// 科目名与 manifest 对账：报告文件名写错科目时能被发现，而不是静默归入"未识别"
const manifest = env.readJson(MANIFEST, []);
const knownSubjects = new Set(manifest.map(m => m.subject));
const unmatched = [...new Set(all.map(i => i.subject))]
  .filter(s => s && s !== '未识别' && knownSubjects.size && !knownSubjects.has(s));
if (unmatched.length) {
  warn('以下科目名与 units_manifest.json 不匹配（报告文件名应按 <科目>__<维度>.md 命名）: ' + unmatched.join('、'));
}

const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
all.forEach(i => counts[i.severity]++);

// 按科目分组
const bySubject = {};
for (const it of all) {
  const s = it.subject || '未识别';
  (bySubject[s] = bySubject[s] || []).push(it);
}

const lines = [];
lines.push('# 修订清单（汇总）');
lines.push('');
lines.push(`生成时间：${new Date().toLocaleString('sv-SE')}`);
lines.push(`审查报告数：${files.length}　问题总数：${all.length}${warnings.length ? `　解析告警：${warnings.length} 条（见脚本输出）` : ''}`);
lines.push('');
lines.push('| 严重度 | 条数 | 处理要求 |');
lines.push('|---|---|---|');
lines.push(`| P0 | ${counts.P0} | 必须修订，修订后复审 |`);
lines.push(`| P1 | ${counts.P1} | 必须修订 |`);
lines.push(`| P2 | ${counts.P2} | 建议修订 |`);
lines.push(`| P3 | ${counts.P3} | 可忽略 |`);
lines.push('');

const needFix = [];
for (const [subject, list] of Object.entries(bySubject).sort()) {
  list.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const p01 = list.filter(i => i.severity === 'P0' || i.severity === 'P1').length;
  lines.push(`## ${subject}　（P0 ${list.filter(i => i.severity === 'P0').length} / P1 ${list.filter(i => i.severity === 'P1').length} / 共 ${list.length}）`);
  lines.push('');
  lines.push('| 严重度 | 位置 | 问题 | 建议改法 | 依据 | 来源维度 |');
  lines.push('|---|---|---|---|---|---|');
  for (const i of list) {
    lines.push(`| ${i.severity} | ${escCell(i.location)} | ${escCell(i.problem)} | ${escCell(i.fix)} | ${escCell(i.evidence)} | ${escCell(i.dimension)} |`);
  }
  lines.push('');
  if (p01 > 0) {
    // location 是「part 文件 + 知识点标题」自由文本，按科目去重后给出涉及范围
    const locs = [...new Set(list.map(i => i.location))];
    const shown = locs.slice(0, 8);
    if (locs.length > shown.length) shown.push(`…等共 ${locs.length} 处`);
    needFix.push({ subject, p01, locs: shown });
  }
}

lines.push('## 需要派发修订员的科目');
lines.push('');
if (!needFix.length) lines.push('（无 P0/P1，可直接进入 PDF 渲染）');
else {
  lines.push('| 科目 | P0+P1 条数 | 涉及位置（部分） |');
  lines.push('|---|---|---|');
  for (const n of needFix.sort((a, b) => b.p01 - a.p01)) {
    lines.push(`| ${escCell(n.subject)} | ${n.p01} | ${n.locs.map(escCell).join('；')} |`);
  }
}

env.writeFileAtomic(path.join(REVIEWS, '_fixlist.md'), lines.join('\n'));

console.log('审查报告：', files.length);
console.log('问题统计：', JSON.stringify(counts));
if (warnings.length) console.log('解析告警：', warnings.length, '条（详见上方 WARN 行，建议核对对应报告）');
console.log('需修订科目：', needFix.length);
console.log('已写入：', path.join(REVIEWS, '_fixlist.md'));
