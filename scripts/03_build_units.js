/**
 * 阶段 3：把全量题目按科目切分成 subagent 处理单元
 *
 * 用法：node scripts/03_build_units.js --work <工作目录> [--chunk 55]
 *
 * 产出：
 *   scrape/units/*.json        每个单元的题目分片（供 subagent 读取）
 *   scrape/units_manifest.json 单元清单（文件名/科目/卷次/题数/对应笔记文件名）
 */
const fs = require('fs');
const path = require('path');
const env = require('./lib/env.js');

const args = env.parseArgs(process.argv);
const WORK = env.workDir(args);
const SC = env.scrapeDir(WORK);
const UNITS = env.ensureDir(path.join(SC, 'units'));
const CHUNK = Number(args.chunk || 55);

const log = (...a) => console.log(...a);
const safe = s => String(s).replace(/[\\/:*?"<>|\s]+/g, '_').replace(/_+/g, '_').slice(0, 40);

/** 归一化一条原始题目记录 */
function normalize(q) {
  let options = [];
  try { options = JSON.parse(q.optionsStr || q.answer || '[]'); } catch (e) { options = []; }

  let correct = [];
  if (Array.isArray(q.answer) && q.answer.length && typeof q.answer[0] === 'object') {
    correct = q.answer.map(o => o.id);
  } else {
    try {
      const a = JSON.parse(q.answer || '[]');
      correct = Array.isArray(a) ? a.map(o => (o && o.id) || o) : [];
    } catch (e) { correct = []; }
  }

  return {
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
    options: options.map(o => ({ id: o.id, text: o.text })),
    correctAnswer: correct,
    explanation: q.cautionDesc || '',
    myNote: q.noteValue || '',
    videoUrl: q.videoUrl || '',
  };
}

const raw = env.readJson(path.join(SC, 'questions.json'), null);
if (!raw) { console.error('未找到 scrape/questions.json，请先运行 scripts/02_scrape.js'); process.exit(2); }

const all = Object.values(raw).map(normalize);
log('题目总数：', all.length);

// 按 卷次 + 科目 分组
const bySubject = {};
for (const q of all) {
  const key = q.group + '__' + q.subject;
  (bySubject[key] = bySubject[key] || []).push(q);
}

// 清空旧单元，避免残留
for (const f of fs.readdirSync(UNITS)) fs.unlinkSync(path.join(UNITS, f));

const manifest = [];
for (const [key, list] of Object.entries(bySubject)) {
  const name = safe(key);
  const chunks = Math.ceil(list.length / CHUNK);
  for (let i = 0; i < chunks; i++) {
    const part = list.slice(i * CHUNK, (i + 1) * CHUNK);
    const file = name + (chunks > 1 ? `_part${i + 1}of${chunks}` : '') + '.json';
    fs.writeFileSync(path.join(UNITS, file), JSON.stringify(part, null, 1), 'utf8');
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

fs.writeFileSync(path.join(SC, 'units_manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
log('单元数：', manifest.length, '（每单元 <=', CHUNK, '题）');
for (const m of manifest) log(' ', m.file, m.count, '题', m.group, m.subject);
log('\n下一步：按 units_manifest.json 派发 subagent，提示词见 assets/note_prompt_template.md');
