'use strict';
/**
 * scripts/lib/env.js 纯函数单测
 * 运行: node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const env = require('../scripts/lib/env.js');

// ---------- parseArgs ----------
test('parseArgs: --key value / --flag / 位置参数', () => {
  // 注意契约：--key 后面跟着非 -- 开头的词会被当作值；无值 flag 放最后
  const a = env.parseArgs(['node', 'x.js', '--work', 'D:/tmp', '--chunk', '55', 'pos', '--dry']);
  assert.strictEqual(a.work, 'D:/tmp');
  assert.strictEqual(a.chunk, '55');
  assert.strictEqual(a.dry, true);
  assert.deepStrictEqual(a._, ['pos']);
});

test('parseArgs: --key 后跟另一个 -- 时不吞参数', () => {
  const a = env.parseArgs(['node', 'x.js', '--chunk', '--dry']);
  assert.strictEqual(a.chunk, true);
  assert.strictEqual(a.dry, true);
});

// ---------- numArg ----------
test('numArg: 默认值与字符串数字', () => {
  assert.strictEqual(env.numArg({}, 'chunk', 55), 55);
  assert.strictEqual(env.numArg({ chunk: true }, 'chunk', 55), 55); // 忘给值兜底
  assert.strictEqual(env.numArg({ chunk: '20' }, 'chunk', 55), 20);
});

test('numArg: 非法数字 / 非整数 / 越界 抛错', () => {
  assert.throws(() => env.numArg({ chunk: 'abc' }, 'chunk', 55));
  assert.throws(() => env.numArg({ chunk: '5.5' }, 'chunk', 55, { int: true }));
  assert.throws(() => env.numArg({ chunk: '999' }, 'chunk', 55, { min: 1, max: 500, int: true }));
});

// ---------- readJson ----------
test('readJson: 不存在返回默认值，损坏文件返回默认值', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhuma-env-'));
  try {
    assert.strictEqual(env.readJson(path.join(dir, 'nope.json'), null), null);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{截断', 'utf8');
    assert.strictEqual(env.readJson(path.join(dir, 'bad.json'), 'DEF'), 'DEF');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 原子写 ----------
test('writeFileAtomic / writeJsonAtomic: 写入内容完整且无临时文件残留', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhuma-env-'));
  try {
    const f = path.join(dir, 'a.json');
    env.writeJsonAtomic(f, { ok: 1 }, 2);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { ok: 1 });
    assert.strictEqual(fs.readdirSync(dir).filter(n => n.includes('.tmp-')).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 进程锁 ----------
test('acquireLock: 互斥；过期锁（2h）可抢占', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhuma-env-'));
  try {
    const lock = path.join(dir, 'lock');
    assert.strictEqual(env.acquireLock(lock), true);
    assert.strictEqual(env.acquireLock(lock), false); // 未过期，拿不到
    // 把锁的 mtime 改到 3 小时前 → 可抢占
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(lock, old, old);
    assert.strictEqual(env.acquireLock(lock), true);
    env.releaseLock(lock);
    assert.strictEqual(fs.existsSync(lock), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 排版变量 ----------
test('layoutCssVars: compact 密度输出 CSS 变量', () => {
  const css = env.layoutCssVars('compact');
  assert.ok(css.includes('--doc-font:9.3pt'));
  assert.ok(css.startsWith(':root{') && css.endsWith('}'));
  assert.strictEqual(env.layoutCssVars('不存在的布局'), env.layoutCssVars('compact')); // 兜底 compact
});

// ---------- 学情档案 ----------
test('readProfile: 默认档案与用户覆盖合并', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhuma-env-'));
  try {
    fs.writeFileSync(path.join(dir, 'study_profile.json'), JSON.stringify({ daily_minutes: 90 }), 'utf8');
    const p = env.readProfile(dir);
    assert.strictEqual(p.daily_minutes, 90);
    assert.strictEqual(p.review_round, '二轮强化'); // 未覆盖字段保留默认
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
