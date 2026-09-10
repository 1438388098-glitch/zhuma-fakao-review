/**
 * 阶段 5.2：汇总审查报告，生成统一修订清单
 *
 * 用法：node scripts/05_review_aggregate.js --work <工作目录>
 *
 * 读取 scrape/reviews/*.md（审查员按 assets/review_prompt_template.md 输出），
 * 解析出问题条目，按「科目 → 严重度」排序，产出 scrape/reviews/_fixlist.md。
 */
const fs = require('fs');
const path = require('path');
const env = require('./lib/env.js');

const args = env.parseArgs(process.argv);
const WORK = env.workDir(args);
const SC = env.scrapeDir(WORK);
const REVIEWS = path.join(SC, 'reviews');

if (!fs.existsSync(REVIEWS)) {
  console.error('未找到 scrape/reviews/，请先分派审查 subagent');
  process.exit(2);
}

const SEV_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

function parseReport(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const base = path.basename(file, '.md');
  const [subject, dim] = base.split('__');
  const items = [];
  for (const line of txt.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    if (cells.length < 6) continue;
    const sev = cells[1].toUpperCase();
    if (!SEV_ORDER.hasOwnProperty(sev)) continue; // 跳过表头/分隔行
    items.push({
      severity: sev,
      location: cells[2],
      problem: cells[3],
      fix: cells[4],
      evidence: cells[5],
      subject, dimension: dim, report: base,
    });
  }
  return items;
}

const files = fs.readdirSync(REVIEWS).filter(f => f.endsWith('.md') && !f.startsWith('_'));
if (!files.length) { console.error('scrape/reviews/ 下没有审查报告'); process.exit(2); }

let all = [];
for (const f of files) all.push(...parseReport(path.join(REVIEWS, f)));

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
lines.push(`生成时间：${new Date().toISOString()}`);
lines.push(`审查报告数：${files.length}　问题总数：${all.length}`);
lines.push('');
lines.push(`| 严重度 | 条数 | 处理要求 |`);
lines.push(`|---|---|---|`);
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
    lines.push(`| ${i.severity} | ${i.location} | ${i.problem} | ${i.fix} | ${i.evidence} | ${i.dimension || ''} |`);
  }
  lines.push('');
  if (p01 > 0) needFix.push({ subject, p01, files: [...new Set(list.map(i => i.location))].slice(0, 8) });
}

lines.push('## 需要派发修订员的科目');
lines.push('');
if (!needFix.length) lines.push('（无 P0/P1，可直接进入 PDF 渲染）');
else {
  lines.push('| 科目 | P0+P1 条数 | 涉及文件（部分） |');
  lines.push('|---|---|---|');
  for (const n of needFix.sort((a, b) => b.p01 - a.p01)) {
    lines.push(`| ${n.subject} | ${n.p01} | ${n.files.join(', ')} |`);
  }
}

fs.writeFileSync(path.join(REVIEWS, '_fixlist.md'), lines.join('\n'), 'utf8');

console.log('审查报告：', files.length);
console.log('问题统计：', JSON.stringify(counts));
console.log('需修订科目：', needFix.length);
console.log('已写入：', path.join(REVIEWS, '_fixlist.md'));
