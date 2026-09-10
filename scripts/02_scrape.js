/**
 * 阶段 2：全量抓取竹马错题本（题干 / 选项 / 正确答案 / 官方解析）
 *
 * 用法：node scripts/02_scrape.js --work <工作目录> [--groups 1,2] [--delay 150]
 *
 * 原理：复用 01_login.js 建立的固定 profile，从页面里"借"一次真实请求的鉴权头，
 *       然后在页面内用 fetch 调竹马内部接口（比爬 DOM 快且完整）。
 *
 * 断点续跑：questions.json 每 20 题落盘一次，重跑会自动跳过已抓题目。
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const env = require('./lib/env.js');

const BOOK_URL = 'https://www.zhumavip.com/w/my/errorbooks?businessType=104'
  + '&businessName=%E6%B3%95%E5%BE%8B%E8%81%8C%E4%B8%9A%E8%B5%84%E6%A0%BC%E8%80%83%E8%AF%95'
  + '&legalQuestionType=0&queType=%E9%94%99%E9%A2%98%E6%9C%AC&mineType=01';

const GROUPS = {
  1: { name: '客观题一', catId: 267, questionTypeId: '702' },
  2: { name: '客观题二', catId: 268, questionTypeId: '703' },
};

const KEEP_HEADERS = ['token', 'mtoken', 'stoken', 'appname', 'channel', 'clienttype', 'accept-q'];

const args = env.parseArgs(process.argv);
const WORK = env.workDir(args);
const SC = env.scrapeDir(WORK);
const DELAY = Number(args.delay || 150);
const PROFILE = path.join(SC, 'profile');

const F_CAT = path.join(SC, 'catalogs.json');
const F_SET = path.join(SC, 'chapter_sets.json');
const F_Q = path.join(SC, 'questions.json');
const F_LEAF = path.join(SC, 'leaves.json');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

(async () => {
  const wantGroups = String(args.groups || '1,2').split(',').map(s => s.trim())
    .map(k => GROUPS[k]).filter(Boolean);
  if (!wantGroups.length) throw new Error('--groups 只能是 1（客观题一）、2（客观题二）或 1,2');

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: env.findChrome(),
    headless: true,
    viewport: { width: 1600, height: 1000 },
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  // 借鉴权头
  let real = null;
  page.on('request', r => {
    if (/java-api/.test(r.url()) && !real && r.headers()['token']) real = r.headers();
  });

  await page.goto(BOOK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(9000);

  if (page.url().includes('qrlogin') || !real) {
    log('未登录或未捕获到鉴权头，请先运行 scripts/01_login.js');
    await ctx.close();
    process.exit(2);
  }

  const H = { 'Content-Type': 'application/json' };
  KEEP_HEADERS.forEach(k => { if (real[k]) H[k] = real[k]; });
  log('auth headers captured, token len =', (H.token || '').length);

  // 在页面上下文里发请求，自动带上 cookie 与同源约束
  const call = (ep, body) => page.evaluate(async ({ ep, body, H }) => {
    const h = Object.assign({}, H, { ts: String(Date.now()) });
    const r = await fetch('/java-api' + ep, {
      method: 'POST', headers: h, credentials: 'include', body: JSON.stringify(body),
    });
    let j = null;
    try { j = await r.json(); } catch (e) { return { code: -1, msg: 'bad json' }; }
    return { code: j.code, msg: j.msg, data: j.data };
  }, { ep, body, H });

  // ---------- 阶段 2.1 目录 ----------
  let catalogs = env.readJson(F_CAT, null);
  if (!catalogs) {
    catalogs = {};
    for (const g of wantGroups) {
      const r = await call('/api/error/question/list/selectCatalogByUserIdV2', {
        catId: g.catId, kindId: '1', mineType: '01', pageNum: 1, pageSize: 200,
        questionTypeId: g.questionTypeId, depthType: 0, recursionFlag: false,
        includeSingleJudgeQuestions: true, isKnowledgePointsRepeat: true,
      });
      log('catalog', g.name, '->', r.code, r.msg);
      catalogs[g.name] = r.code === 200 ? r.data : null;
    }
    fs.writeFileSync(F_CAT, JSON.stringify(catalogs, null, 2), 'utf8');
  }

  const leaves = [];
  for (const g of wantGroups) {
    for (const subj of (catalogs[g.name] || [])) {
      const subs = subj.subList || [];
      if (subs.length) {
        for (const ch of subs) {
          if (ch.count > 0) leaves.push({
            group: g.name, subject: subj.content, chapter: ch.content,
            catalogId: ch.id, count: ch.count, questionTypeId: g.questionTypeId,
          });
        }
      } else if (subj.count > 0) {
        leaves.push({
          group: g.name, subject: subj.content, chapter: subj.content,
          catalogId: subj.id, count: subj.count, questionTypeId: g.questionTypeId,
        });
      }
    }
  }
  fs.writeFileSync(F_LEAF, JSON.stringify(leaves, null, 2), 'utf8');
  log('chapters:', leaves.length, 'expected questions:', leaves.reduce((a, b) => a + b.count, 0));

  // ---------- 阶段 2.2 每章题目 ----------
  const sets = env.readJson(F_SET, {});
  for (const l of leaves) {
    const key = l.group + '#' + l.catalogId;
    if (sets[key] && sets[key].questions) continue;
    const r = await call('/api/error/question/getQuestionSetFromKnowledgeListV2', {
      mineType: '01', kindId: '1', catalogId: String(l.catalogId), questionTypeId: l.questionTypeId,
      businessTypeId: '104', includeSingleJudgeQuestions: true, isKnowledgePointsRepeat: true,
    });
    if (r.code !== 200 || !r.data) {
      log('SET FAIL', l.subject, '/', l.chapter, r.code, r.msg);
      sets[key] = { error: r.msg };
    } else {
      sets[key] = {
        answerErrorId: r.data.answerErrorId,
        expected: l.count,
        questions: (r.data.questions || []).map(q => ({ id: q.id, kind: q.kind })),
      };
    }
    fs.writeFileSync(F_SET, JSON.stringify(sets), 'utf8');
    await new Promise(r2 => setTimeout(r2, 120));
  }
  const totalQ = Object.values(sets).reduce((a, s) => a + ((s.questions && s.questions.length) || 0), 0);
  log('stage 2.2 done. questions collected:', totalQ);

  // ---------- 阶段 2.3 逐题详情 ----------
  const todo = [];
  for (const l of leaves) {
    const s = sets[l.group + '#' + l.catalogId];
    if (!s || !s.questions) continue;
    for (const q of s.questions) {
      todo.push({
        group: l.group, subject: l.subject, chapter: l.chapter,
        questionId: q.id, answerRecordId: s.answerErrorId,
      });
    }
  }
  const done = env.readJson(F_Q, {});
  const pending = todo.filter(t => !done[t.questionId]);
  log('stage 2.3: total', todo.length, 'pending', pending.length);

  let i = 0, fails = 0;
  for (const t of pending) {
    const r = await call('/api/error/question/getErrorQuestionAnalysisByIdV2', {
      questionId: t.questionId, answerRecordId: t.answerRecordId,
    });
    i++;
    if (r.code === 200 && r.data) {
      done[t.questionId] = Object.assign({}, r.data, {
        _group: t.group, _subject: t.subject, _chapter: t.chapter,
      });
      if (i % 20 === 0) fs.writeFileSync(F_Q, JSON.stringify(done), 'utf8');
      if (i % 25 === 0) log(`  [${i}/${pending.length}] stored ${Object.keys(done).length}`);
    } else {
      fails++;
      if (fails < 8) log('  FAIL q=' + t.questionId, r.code, r.msg);
      if (/登录/.test(r.msg || '')) { log('AUTH LOST at q=' + t.questionId + ' —— 请重跑 01_login.js'); break; }
    }
    await new Promise(r2 => setTimeout(r2, DELAY));
  }
  fs.writeFileSync(F_Q, JSON.stringify(done), 'utf8');
  log('stage 2.3 done. stored:', Object.keys(done).length, 'fails:', fails);

  // 提示限制
  const sample = Object.values(done)[0];
  if (sample && (sample.userOptions === null || (Array.isArray(sample.userOptions) && !sample.userOptions.length))) {
    log('NOTE: userOptions/userAnswer 为空 —— 竹马不保存"我错选了哪个选项"，这部分拿不到。');
  }

  await ctx.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
