'use strict';
/**
 * 阶段 3（切分）与阶段 5.2（审查汇总）的 CLI 端到端测试。
 * 全部使用临时工作目录 + 构造的 scrape/ 输入，不依赖真实抓取数据。
 * 运行: node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const S3 = path.join(__dirname, '..', 'scripts', '03_build_units.js');
const S5 = path.join(__dirname, '..', 'scripts', '05_review_aggregate.js');

function tmpWork() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zhuma-pipeline-'));
}

function run(script, work, args = []) {
  return spawnSync('node', [script, '--work', work, ...args], { encoding: 'utf8' });
}

function mkQuestion(id, over = {}) {
  return Object.assign({
    id,
    _group: '2024年卷一',
    _subject: '刑法',
    question: '题干' + id,
    optionsStr: JSON.stringify([{ id: 'A', text: '选项A' }, { id: 'B', text: '选项B' }]),
    answer: [{ id: 'A' }],
    cautionDesc: '解析' + id,
  }, over);
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 1), 'utf8');
}

// ================= 阶段 3：build_units =================

test('03: 正常切分——单文件单元、manifest 与 noteFile 映射', () => {
  const w = tmpWork();
  try {
    writeJson(path.join(w, 'scrape', 'questions.json'), {
      q1: mkQuestion('q1'), q2: mkQuestion('q2'), q3: mkQuestion('q3'),
    });
    const r = run(S3, w);
    assert.strictEqual(r.status, 0, r.stderr);
    const manifest = JSON.parse(fs.readFileSync(path.join(w, 'scrape', 'units_manifest.json'), 'utf8'));
    assert.strictEqual(manifest.length, 1);
    assert.strictEqual(manifest[0].count, 3);
    assert.strictEqual(manifest[0].noteFile, manifest[0].file.replace(/\.json$/, '.md'));
    const unit = JSON.parse(fs.readFileSync(path.join(w, 'scrape', 'units', manifest[0].file), 'utf8'));
    assert.strictEqual(unit.length, 3);
    assert.strictEqual(unit[0].correctAnswer[0], 'A');
    assert.strictEqual(unit[0].options.length, 2);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('03: chunk 切分产出 partNofM 命名', () => {
  const w = tmpWork();
  try {
    const qs = {};
    for (let i = 1; i <= 5; i++) qs['q' + i] = mkQuestion('q' + i);
    writeJson(path.join(w, 'scrape', 'questions.json'), qs);
    const r = run(S3, w, ['--chunk', '2']);
    assert.strictEqual(r.status, 0, r.stderr);
    const manifest = JSON.parse(fs.readFileSync(path.join(w, 'scrape', 'units_manifest.json'), 'utf8'));
    assert.strictEqual(manifest.length, 3);
    assert.deepStrictEqual(manifest.map(m => m.chunk), ['1/3', '2/3', '3/3']);
    assert.ok(manifest[0].file.includes('_part1of3'));
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('03: 文件名清洗——分组/科目中的非法字符变下划线', () => {
  const w = tmpWork();
  try {
    writeJson(path.join(w, 'scrape', 'questions.json'), {
      q1: mkQuestion('q1', { _group: '2024 卷:一/特' }),
    });
    const r = run(S3, w);
    assert.strictEqual(r.status, 0, r.stderr);
    const files = fs.readdirSync(path.join(w, 'scrape', 'units'));
    assert.strictEqual(files.length, 1);
    assert.match(files[0], /^[^\\/:*?"<>|\s]+\.json$/);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('03: 部分题目字段异常 → 告警但继续，坏题答案为空', () => {
  const w = tmpWork();
  try {
    writeJson(path.join(w, 'scrape', 'questions.json'), {
      q1: mkQuestion('q1'),
      q2: mkQuestion('q2', { optionsStr: '不是JSON', answer: '' }),
    });
    const r = run(S3, w);
    assert.strictEqual(r.status, 0);
    assert.ok(r.stdout.includes('WARN'));
    const manifest = JSON.parse(fs.readFileSync(path.join(w, 'scrape', 'units_manifest.json'), 'utf8'));
    const unit = JSON.parse(fs.readFileSync(path.join(w, 'scrape', 'units', manifest[0].file), 'utf8'));
    const bad = unit.find(u => u.questionId === 'q2');
    assert.strictEqual(bad.options.length, 0);
    assert.strictEqual(bad.correctAnswer.length, 0);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('03: 全部题目字段异常 → exit 2（防站点改版假成功）', () => {
  const w = tmpWork();
  try {
    writeJson(path.join(w, 'scrape', 'questions.json'), {
      q1: mkQuestion('q1', { optionsStr: 'x', answer: 'x' }),
      q2: mkQuestion('q2', { optionsStr: 'x', answer: 'x' }),
    });
    const r = run(S3, w);
    assert.strictEqual(r.status, 2);
    assert.ok(r.stderr.includes('全部题目的选项/答案都为空'));
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('03: 缺 questions.json / 空对象 → exit 2', () => {
  const w1 = tmpWork();
  try {
    assert.strictEqual(run(S3, w1).status, 2);
  } finally { fs.rmSync(w1, { recursive: true, force: true }); }

  const w2 = tmpWork();
  try {
    writeJson(path.join(w2, 'scrape', 'questions.json'), {});
    const r = run(S3, w2);
    assert.strictEqual(r.status, 2);
    assert.ok(r.stderr.includes('为空或损坏'));
  } finally { fs.rmSync(w2, { recursive: true, force: true }); }
});

test('03: 重跑会重建 units/（残留文件被清除）', () => {
  const w = tmpWork();
  try {
    writeJson(path.join(w, 'scrape', 'questions.json'), { q1: mkQuestion('q1') });
    assert.strictEqual(run(S3, w).status, 0);
    const stale = path.join(w, 'scrape', 'units', 'stale_part1of1.json');
    fs.writeFileSync(stale, '[]', 'utf8');
    assert.strictEqual(run(S3, w).status, 0);
    assert.strictEqual(fs.existsSync(stale), false);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

// ================= 阶段 5.2：review_aggregate =================

function mkReview(dir, name, content, mtime) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, content, 'utf8');
  if (mtime) fs.utimesSync(f, mtime, mtime);
}

const GOOD_REPORT = `# 审查报告：刑法 × 准确性

| # | 严重度 | 位置 | 问题 | 建议改法 | 依据 |
|---|---|---|---|---|---|
| 1 | **P0** | 刑法_part1of2.json·正当防卫 | 把「不法侵害正在进行」写成「随时可以反击」 | 改回时间条件表述 | 笔记第3节原文 |
| 2 | P2 | 刑法_part2of2.json·罪数 | 含竖线的单元格 \\| 需要转义 | 保留转义 | 依据含\\|竖线 |

## 结论摘要

- P0: 1 条, P1: 0 条, P2: 1 条, P3: 0 条
`;

test('05: 正常汇总——严重度容忍加粗、转义、manifest 科目对账', () => {
  const w = tmpWork();
  try {
    writeJson(path.join(w, 'scrape', 'units_manifest.json'), [
      { file: '刑法_part1of2.json', subject: '刑法', group: 'g', chunk: '', count: 1, noteFile: 'x.md' },
    ]);
    mkReview(path.join(w, 'scrape', 'reviews'), '刑法__准确性.md', GOOD_REPORT);
    const r = run(S5, w);
    assert.strictEqual(r.status, 0, r.stderr);
    const fixlist = fs.readFileSync(path.join(w, 'scrape', 'reviews', '_fixlist.md'), 'utf8');
    assert.ok(fixlist.includes('| P0 | 1 |'));
    assert.ok(fixlist.includes('| P2 | 1 |'));
    assert.ok(fixlist.includes('需要派发修订员的科目'));
    // escCell：竖线被转义为 \|
    assert.ok(fixlist.includes('\\|'));
    // 加粗严重度 **P0** 被识别
    assert.ok(fixlist.includes('正当防卫'));
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('05: 假绿灯防护——有报告但零解析 → exit 2，不产出修订清单', () => {
  const w = tmpWork();
  try {
    mkReview(path.join(w, 'scrape', 'reviews'), '刑法__准确性.md', '这份报告只有自由文本，没有表格。');
    const r = run(S5, w);
    assert.strictEqual(r.status, 2);
    assert.ok(r.stderr.includes('假绿灯'));
    assert.strictEqual(fs.existsSync(path.join(w, 'scrape', 'reviews', '_fixlist.md')), false);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('05: 结论摘要与表格条数不一致 → 告警但继续', () => {
  const w = tmpWork();
  try {
    const bad = GOOD_REPORT.replace('- P0: 1 条', '- P0: 5 条');
    writeJson(path.join(w, 'scrape', 'units_manifest.json'), [{ subject: '刑法' }]);
    mkReview(path.join(w, 'scrape', 'reviews'), '刑法__准确性.md', bad);
    const r = run(S5, w);
    assert.strictEqual(r.status, 0);
    assert.ok(r.stderr.includes('结论摘要称 P0 5 条'));
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('05: 严重度写错（P9）的行被跳过并告警', () => {
  const w = tmpWork();
  try {
    const bad = GOOD_REPORT.replace('| **P0** |', '| P9 |');
    writeJson(path.join(w, 'scrape', 'units_manifest.json'), [{ subject: '刑法' }]);
    mkReview(path.join(w, 'scrape', 'reviews'), '刑法__准确性.md', bad);
    const r = run(S5, w);
    assert.strictEqual(r.status, 0);
    assert.ok(r.stderr.includes('无法解析'));
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('05: 报告早于笔记修改时间 → 输出时效告警', () => {
  const w = tmpWork();
  try {
    writeJson(path.join(w, 'scrape', 'units_manifest.json'), [{ subject: '刑法' }]);
    const past = new Date(Date.now() - 60 * 60 * 1000);
    mkReview(path.join(w, 'scrape', 'reviews'), '刑法__准确性.md', GOOD_REPORT, past);
    // 笔记 mtime = 现在（晚于报告）
    fs.mkdirSync(path.join(w, 'scrape', 'notes'), { recursive: true });
    const note = path.join(w, 'scrape', 'notes', '刑法_part1of2.md');
    fs.writeFileSync(note, '# 笔记', 'utf8');
    const r = run(S5, w);
    assert.strictEqual(r.status, 0);
    assert.ok(r.stderr.includes('早于笔记最新修改时间'));
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('05: 缺 reviews 目录 / 目录为空（仅 _ 前缀文件）→ exit 2', () => {
  const w1 = tmpWork();
  try {
    assert.strictEqual(run(S5, w1).status, 2);
  } finally { fs.rmSync(w1, { recursive: true, force: true }); }

  const w2 = tmpWork();
  try {
    mkReview(path.join(w2, 'scrape', 'reviews'), '_fixlist.md', '# 忽略我');
    assert.strictEqual(run(S5, w2).status, 2);
  } finally { fs.rmSync(w2, { recursive: true, force: true }); }
});
