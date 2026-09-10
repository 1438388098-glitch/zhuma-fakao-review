/**
 * 阶段 3：把全量题目按科目切分成 subagent 处理单元
 *
 * 用法：node scripts/03_build_units.js --work <工作目录> [--chunk 55]
 *
 * 产出：
 *   scrape/units/*.json        每个单元的题目分片（供 subagent 读取）
 *   scrape/units_manifest.json 单元清单（文件名/科目/卷次/题数/对应笔记文件名）
 *
 * 注意：
 *  - 重跑会删除并重建 scrape/units/ —— 若此前已生成过笔记，重切分后旧笔记与
 *    新 manifest 可能错位，必须重新执行阶段 4（笔记生成）。
 *  - 选项/正确答案解析失败的题目会逐条告警；若全部题目都失败（站点字段结构变动）则中止。
 *
 * 退出码：0 成功 / 2 缺输入或输入损坏
 */
const fs = require('fs');
const path = require('path');
const env = require('./lib/env.js');

const args = env.parseArgs(process.argv);
const fail2 = e => { console.error('FATAL', (e && e.message) || e); process.exit(2); };
let WORK, CHUNK;
try {
  WORK = env.workDir(args);
  CHUNK = env.numArg(args, 'chunk', 55, { min: 1, max: 500, int: true });
} catch (e) { fail2(e); }
const SC = env.scrapeDir(WORK);
const UNITS = env.ensureDir(path.join(SC, 'units'));

const log = (...a) => console.log(...a);

// Windows 文件名清洗：非法字符、保留设备名（CON/NUL/COM1…）、结尾点与空格都要处理
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const safe = s => {
  let t = String(s)
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._\s]+/, '')
    .slice(0, 40)
    .replace(/[._\s]+$/, '');
  if (WIN_RESERVED.test(t)) t = '_' + t;
  return t || 'unnamed';
};

/** 解析「选项数组 JSON 字符串」。只认 optionsStr，解析结果必须为数组；失败返回 [] 并记录原因。 */
function parseOptions(q, problems) {
  if (q.optionsStr === undefined || q.optionsStr === null || q.optionsStr === '') {
    problems.push('缺少 optionsStr');
    return [];
  }
  try {
    const o = JSON.parse(q.optionsStr);
    if (!Array.isArray(o)) { problems.push('optionsStr 不是数组'); return []; }
    if (!o.length) problems.push('optionsStr 为空数组');
    return o;
  } catch (e) {
    problems.push('optionsStr 解析失败');
    return [];
  }
}

/** 解析「正确答案」。可能是对象数组、JSON 字符串数组或裸文本；失败返回 [] 并记录原因。 */
function parseCorrect(q, problems) {
  if (Array.isArray(q.answer) && q.answer.length && typeof q.answer[0] === 'object') {
    const r = q.answer.map(o => o && o.id).filter(x => x !== undefined && x !== null);
    if (!r.length) problems.push('answer 对象数组解析为空');
    return r;
  }
  if (q.answer === undefined || q.answer === null || q.answer === '') {
    problems.push('缺少 answer');
    return [];
  }
  if (Array.isArray(q.answer)) {
    problems.push('answer 为空数组');
    return [];
  }
  try {
    const a = JSON.parse(q.answer);
    if (Array.isArray(a)) {
      const r = a.map(o => (o && o.id) || o).filter(x => x !== undefined && x !== null);
      if (!r.length) problems.push('answer JSON 数组解析为空');
      return r;
    }
    if (a !== null && a !== undefined) return [a]; // 标量 JSON（如 "A"）
    problems.push('answer 为 null');
    return [];
  } catch (e) {
    return [String(q.answer)]; // 裸文本答案（如 "A"）
  }
}

/** 归一化一条原始题目记录 */
function normalize(q) {
  const problems = [];
  const options = parseOptions(q, problems);
  const correct = parseCorrect(q, problems);
  const unit = {
    questionId: q.id,
    group: q._group,
    subject: q._subject,
    chapter: q._chapter,
    type: q.tagName || '',
    difficulty: q.difficulty,
    score: q.score,
    source: q.snText || q.questionName || '',
    year: q.year,
    stem: q.question || '',
    options: options.map(o => ({ id: o && o.id, text: o && o.text })),
    correctAnswer: correct,
    explanation: q.cautionDesc || '',
    myNote: q.noteValue || '',
    videoUrl: q.videoUrl || '',
  };
  return { unit, problems };
}

const qFile = path.join(SC, 'questions.json');
if (!fs.existsSync(qFile)) {
  console.error('未找到 scrape/questions.json，请先运行 scripts/02_scrape.js');
  process.exit(2);
}
const raw = env.readJson(qFile, null);
if (!raw || typeof raw !== 'object' || !Object.keys(raw).length) {
  console.error('scrape/questions.json 为空或损坏（多半是上次抓取被中断）—— 删除该文件后重跑 scripts/02_scrape.js');
  process.exit(2);
}

const all = [];
const badQ = [];
for (const q of Object.values(raw)) {
  const { unit, problems } = normalize(q);
  all.push(unit);
  if (problems.length) badQ.push({ id: unit.questionId, problems });
}
log('题目总数：', all.length);
if (badQ.length) {
  log(`WARN：${badQ.length} 题的选项/答案字段异常（将为空），生成笔记时缺答案基准：`);
  for (const b of badQ.slice(0, 10)) log('  q=' + b.id, '->', b.problems.join('; '));
  if (badQ.length > 10) log('  ... 其余', badQ.length - 10, '条略');
  const noOptions = all.filter(u => !u.options.length).length;
  const noAnswer = all.filter(u => !u.correctAnswer.length).length;
  if (noOptions === all.length || noAnswer === all.length) {
    console.error('全部题目的选项/答案都为空 —— 大概率站点字段结构变动，中止。请按 references/api_reference.md 的「接口变动时如何重新发现」排查');
    process.exit(2);
  }
}

// 元数据缺失兜底：宁可显式标注也不让 undefined 静默进文件名与封面
for (const u of all) {
  if (!u.subject) u.subject = '未知科目';
  if (!u.group) u.group = '未知卷次';
}

// 与 02 的章节预期对账（跨章节重复题会让两者不等，属正常，仅提示）
const leaves = env.readJson(path.join(SC, 'leaves.json'), null);
if (Array.isArray(leaves) && leaves.length) {
  const expected = leaves.reduce((a, b) => a + (Number(b.count) || 0), 0);
  if (expected && expected !== all.length) {
    log(`NOTE：章节预期题数合计 ${expected}，按题目 id 去重后实际 ${all.length}（差值来自跨章节重复题）`);
  }
}

// 按 卷次 + 科目 分组
const bySubject = {};
for (const q of all) {
  const key = q.group + '__' + q.subject;
  (bySubject[key] = bySubject[key] || []).push(q);
}

// 重建 units 目录（整目录删除再建，避免残留文件与子目录导致的清理失败）
fs.rmSync(UNITS, { recursive: true, force: true });
env.ensureDir(UNITS);

const manifest = [];
const usedNames = new Set();
for (const [key, list] of Object.entries(bySubject)) {
  let name = safe(key);
  let n = usedNames.size + 1; // 递增计数器：候选名也被占用时继续 +1，绝不死循环
  while (usedNames.has(name)) name = safe(key).slice(0, 36) + '_' + (n++);
  usedNames.add(name);
  const chunks = Math.max(1, Math.ceil(list.length / CHUNK));
  for (let i = 0; i < chunks; i++) {
    const part = list.slice(i * CHUNK, (i + 1) * CHUNK);
    const file = name + (chunks > 1 ? `_part${i + 1}of${chunks}` : '') + '.json';
    env.writeFileAtomic(path.join(UNITS, file), JSON.stringify(part, null, 1));
    manifest.push({
      file,
      subjectKey: key,
      subject: list[0].subject,
      group: list[0].group,
      chunk: chunks > 1 ? `${i + 1}/${chunks}` : '',
      count: part.length,
      noteFile: file.replace(/\.json$/, '.md'),
    });
  }
}

env.writeJsonAtomic(path.join(SC, 'units_manifest.json'), manifest, 2);
log('单元数：', manifest.length, '（每单元 <=', CHUNK, '题）');
for (const m of manifest) log(' ', m.file, m.count, '题', m.group, m.subject);
log('\n下一步：按 units_manifest.json 派发 subagent，提示词见 assets/note_prompt_template.md');
log('注意：若此前已生成过笔记，重切分后旧笔记已随 units/ 重建而失效，必须重新执行阶段 4。');
