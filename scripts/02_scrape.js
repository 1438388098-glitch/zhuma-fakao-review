/**
 * 阶段 2：全量抓取竹马错题本（题干 / 选项 / 正确答案 / 官方解析）
 *
 * 用法：node scripts/02_scrape.js --work <工作目录> [--groups 1,2] [--delay 150]
 *
 * 原理：复用 01_login.js 建立的固定 profile，从页面里"借"一次真实请求的鉴权头，
 *       然后在页面内用 fetch 调竹马内部接口（比爬 DOM 快且完整）。
 *
 * 健壮性：
 *  - 断点续跑：questions.json 每 20 题原子落盘（tmp+rename），重跑自动跳过已抓题目
 *  - 页面内 fetch 带 20s 超时；连续失败 10 次熔断；失败按指数退避
 *  - 目录接口失败不写缓存（避免瞬时故障被永久缓存、静默丢整组数据）
 *  - 同一题目跨章节重复时按 questionId 去重，只抓一次
 *  - .scrape.lock 防止两个实例并发互相覆盖
 *
 * 退出码：0 成功 / 1 有失败或目录为空（可重跑续抓）/ 2 未登录或鉴权头未捕获（先跑 01_login.js）
 */
const fs = require('fs');
const path = require('path');
const env = require('./lib/env.js');
const { chromium } = env.loadPlaywright();

const BOOK_URL = env.BOOK_URL;
const VIEWPORT = { width: 1600, height: 1000 };

// 站点类目 ID（来源见 references/api_reference.md）。站点改版后若接口返回 200 但数据为空/错类目，先查这里。
const GROUPS = {
  1: { name: '客观题一', catId: 267, questionTypeId: '702' },
  2: { name: '客观题二', catId: 268, questionTypeId: '703' },
};

const KEEP_HEADERS = ['token', 'mtoken', 'stoken', 'appname', 'channel', 'clienttype', 'accept-q'];
const FETCH_TIMEOUT_MS = 20000;
const BREAKER_LIMIT = 10;

const args = env.parseArgs(process.argv);
const WORK = env.workDir(args);
const SC = env.scrapeDir(WORK);
const PROFILE = path.join(SC, 'profile');
const DELAY = env.numArg(args, 'delay', 150, { min: 100, max: 10000, int: true });
const LOCK = path.join(SC, '.scrape.lock');

const F_CAT = path.join(SC, 'catalogs.json');
const F_SET = path.join(SC, 'chapter_sets.json');
const F_Q = path.join(SC, 'questions.json');
const F_LEAF = path.join(SC, 'leaves.json');

const log = env.log;
const sleep = env.sleep;
const poll = env.poll;

(async () => {
  const wantGroups = String(args.groups || '1,2').split(',').map(s => s.trim())
    .map(k => GROUPS[k]).filter(Boolean);
  if (!wantGroups.length) throw new Error('--groups 只能是 1（客观题一）、2（客观题二）或 1,2');

  if (!env.acquireLock(LOCK)) {
    log('另一个抓取进程似乎正在运行（scrape/.scrape.lock）。若确认没有并发，删除该文件后重试。');
    return 1;
  }

  // ctx 从创建到 close 全程在 try 内：启动本身失败（如找不到 Chrome）也不能泄漏锁
  let ctx = null;
  try {
    ctx = await chromium.launchPersistentContext(PROFILE, {
      executablePath: env.findChrome(),
      headless: true,
      viewport: VIEWPORT,
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    const page = ctx.pages()[0] || await ctx.newPage();

    // 借鉴权头：监听真实请求，轮询等待捕获（最多 20s），而不是固定 sleep 9s
    let real = null;
    page.on('request', r => {
      if (/java-api/.test(r.url()) && !real && r.headers()['token']) real = r.headers();
    });

    await page.goto(BOOK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const captured = await poll(async () => {
      if (page.url().includes('qrlogin')) return 'NOT_LOGGED_IN';
      if (real) return 'OK';
      return null;
    }, 20000, 1000);

    if (captured !== 'OK') {
      log(captured === 'NOT_LOGGED_IN'
        ? '未登录（跳到了登录页），请先运行 scripts/01_login.js'
        : '已打开错题本但 20s 内未捕获到鉴权头（网络慢或页面改版），请重试；若反复失败见 references/api_reference.md');
      return 2;
    }

    const H = { 'Content-Type': 'application/json' };
    KEEP_HEADERS.forEach(k => { if (real[k]) H[k] = real[k]; });
    log('auth headers captured, token len =', (H.token || '').length);

    // 在页面上下文里发请求（自动带 cookie 与同源约束），带 20s 超时；
    // evaluate 本身失败（如页面跳转导致执行环境销毁）时重试一次
    const call = async (ep, body) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await page.evaluate(async ({ ep, body, H, timeoutMs }) => {
            const h = Object.assign({}, H, { ts: String(Date.now()) });
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), timeoutMs);
            try {
              const r = await fetch('/java-api' + ep, {
                method: 'POST', headers: h, credentials: 'include',
                body: JSON.stringify(body), signal: ac.signal,
              });
              let j = null;
              try { j = await r.json(); } catch (e) { return { code: -1, msg: 'bad json (HTTP ' + r.status + ')' }; }
              return { code: j.code, msg: j.msg, data: j.data };
            } catch (e) {
              return { code: -1, msg: e && e.name === 'AbortError' ? `timeout(${timeoutMs}ms)` : 'network: ' + (e && e.message || e) };
            } finally { clearTimeout(timer); }
          }, { ep, body, H, timeoutMs: FETCH_TIMEOUT_MS });
        } catch (e) {
          if (attempt === 0) { await sleep(1500); continue; }
          return { code: -1, msg: 'evaluate failed: ' + (e && e.message || e) };
        }
      }
    };

    // ---------- 阶段 2.1 目录 ----------
    // 失败的结果绝不写缓存 —— 否则一次瞬时故障会让该组此后永远解析为空（静默丢数据）
    let catalogs = env.readJson(F_CAT, null);
    if (!catalogs || typeof catalogs !== 'object' || Array.isArray(catalogs)) { catalogs = {}; }
    const catFailed = [];
    let catDirty = false;
    for (const g of wantGroups) {
      if (Array.isArray(catalogs[g.name])) continue; // 已有成功缓存
      const r = await call('/api/error/question/list/selectCatalogByUserIdV2', {
        catId: g.catId, kindId: '1', mineType: '01', pageNum: 1, pageSize: 200,
        questionTypeId: g.questionTypeId, depthType: 0, recursionFlag: false,
        includeSingleJudgeQuestions: true, isKnowledgePointsRepeat: true,
      });
      log('catalog', g.name, '->', r.code, r.msg);
      if (r.code === 200 && Array.isArray(r.data)) {
        catalogs[g.name] = r.data;
        catDirty = true;
      } else {
        catFailed.push(`${g.name}(${r.code} ${r.msg || ''})`);
      }
    }
    if (catDirty) env.writeJsonAtomic(F_CAT, catalogs, 2);
    if (catFailed.length) {
      log('目录获取失败（未写入缓存，重跑会自动重试）：', catFailed.join('; '));
      return 1;
    }

    const leaves = [];
    for (const g of wantGroups) {
      for (const subj of (catalogs[g.name] || [])) {
        const subs = subj.subList || [];
        if (subs.length) {
          for (const ch of subs) {
            const n = Number(ch.count) || 0;
            if (n > 0) leaves.push({
              group: g.name, subject: subj.content, chapter: ch.content,
              catalogId: ch.id, count: n, questionTypeId: g.questionTypeId,
            });
          }
        } else {
          const n = Number(subj.count) || 0;
          if (n > 0) leaves.push({
            group: g.name, subject: subj.content, chapter: subj.content,
            catalogId: subj.id, count: n, questionTypeId: g.questionTypeId,
          });
        }
      }
    }
    env.writeJsonAtomic(F_LEAF, leaves, 2);
    log('chapters:', leaves.length, 'expected questions:', leaves.reduce((a, b) => a + b.count, 0));
    if (!leaves.length) {
      log('目录为空：可能站点接口/类目 ID 变动（见 references/api_reference.md），或该卷次确实没有错题');
      return 1;
    }

    // ---------- 阶段 2.2 每章题目 ----------
    let sets = env.readJson(F_SET, {});
    if (!sets || typeof sets !== 'object' || Array.isArray(sets)) sets = {};
    let setFails = 0;
    let authLost = false;
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
        setFails++;
        if (/登录/.test(r.msg || '')) {
          log('AUTH LOST at chapter ' + l.chapter + ' —— 请重跑 01_login.js');
          authLost = true;
          break;
        }
      } else {
        const questions = (r.data.questions || []).map(q => ({ id: q.id, kind: q.kind }));
        if (!questions.length && l.count > 0) {
          // 200 但空列表且章节预期有题：按软失败处理，不缓存完成态，重跑会自动重试
          log('SET EMPTY', l.subject, '/', l.chapter, `—— 预期 ${l.count} 题但返回空列表，下轮重试`);
          sets[key] = { error: `empty question list (expected ${l.count})` };
          setFails++;
        } else {
          sets[key] = {
            answerErrorId: r.data.answerErrorId,
            expected: l.count,
            questions,
          };
        }
      }
      env.writeJsonAtomic(F_SET, sets);
      await sleep(120);
    }
    // 只统计本次目标卷次的章节，避免混入历史 --groups 的数据导致虚高
    let totalQ = 0;
    for (const l of leaves) {
      const s = sets[l.group + '#' + l.catalogId];
      if (s && s.questions) totalQ += s.questions.length;
    }
    log('stage 2.2 done. questions collected:', totalQ, 'setFails:', setFails);

    // ---------- 阶段 2.3 逐题详情 ----------
    const todo = [];
    const seenQ = new Set();
    let dupQ = 0;
    for (const l of leaves) {
      const s = sets[l.group + '#' + l.catalogId];
      if (!s || !s.questions) continue;
      for (const q of s.questions) {
        if (seenQ.has(q.id)) { dupQ++; continue; } // 跨章节重复题只抓一次
        seenQ.add(q.id);
        todo.push({
          group: l.group, subject: l.subject, chapter: l.chapter,
          questionId: q.id, answerRecordId: s.answerErrorId,
        });
      }
    }
    if (dupQ) log('跨章节重复题（按 id 去重，只抓一次）：', dupQ);
    let done = env.readJson(F_Q, {});
    if (!done || typeof done !== 'object' || Array.isArray(done)) done = {};
    const pending = todo.filter(t => !done[t.questionId]);
    log('stage 2.3: total', todo.length, 'pending', pending.length);

    let i = 0, fails = 0, consec = 0, notedUserOptions = false;
    try {
      for (const t of pending) {
        const r = await call('/api/error/question/getErrorQuestionAnalysisByIdV2', {
          questionId: t.questionId, answerRecordId: t.answerRecordId,
        });
        i++;
        if (r.code === 200 && r.data) {
          consec = 0;
          done[t.questionId] = Object.assign({}, r.data, {
            _group: t.group, _subject: t.subject, _chapter: t.chapter,
          });
          if (i % 20 === 0) env.writeJsonAtomic(F_Q, done);
          if (i % 25 === 0) log(`  [${i}/${pending.length}] stored ${Object.keys(done).length}`);
          // 全局性结论只在第一条成功响应时判定一次，不做事后抽样
          if (!notedUserOptions) {
            notedUserOptions = true;
            const uo = r.data.userOptions;
            if (uo === null || uo === undefined || (Array.isArray(uo) && !uo.length)) {
              log('NOTE: userOptions/userAnswer 为空 —— 竹马不保存"我错选了哪个选项"，这部分拿不到。');
            }
          }
        } else {
          fails++; consec++;
          if (fails <= 8) log('  FAIL q=' + t.questionId, r.code, r.msg);
          if (/登录/.test(r.msg || '')) {
            log('AUTH LOST at q=' + t.questionId + ' —— 请重跑 01_login.js');
            authLost = true;
            break;
          }
          if (consec >= BREAKER_LIMIT) {
            log(`连续失败 ${consec} 次，熔断中止 —— 稍后重跑本脚本可从断点续抓`);
            break;
          }
          // 指数退避，避免持续失败时打穿全部待抓题目
          await sleep(Math.min(DELAY * Math.pow(2, consec), 8000));
          continue;
        }
        await sleep(DELAY);
      }
    } finally {
      // 无论正常结束、熔断还是异常，都把已抓数据落盘
      env.writeJsonAtomic(F_Q, done);
    }
    log('stage 2.3 done. stored:', Object.keys(done).length, 'fails:', fails);

    if (authLost) return 2;
    if (setFails > 0 || fails > 0) {
      log(`本次有失败未完成（章节失败 ${setFails}、题目失败 ${fails}，退出码 1）—— 直接重跑本脚本即可从断点续抓`);
      return 1;
    }
    return 0;
  } finally {
    // 任何路径都关闭浏览器，避免孤儿 Chrome 锁死 profile 目录
    if (ctx) await ctx.close().catch(() => {});
    env.releaseLock(LOCK);
  }
})()
  .then(c => { process.exitCode = c || 0; })
  .catch(e => { console.error('FATAL', (e && e.stack) || e); process.exitCode = 1; });
