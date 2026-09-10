/**
 * 阶段 6：把笔记 Markdown 渲染成 PDF（在 05_review_aggregate.js 完成修订后运行）
 *
 * 用法：
 *   node scripts/04_render_pdf.js --work <工作目录>                    # 每科一份 PDF
 *   node scripts/04_render_pdf.js --work <工作目录> --volume            # 同时生成总册
 *   node scripts/04_render_pdf.js --work <工作目录> --volume --desktop  # 总册另存到桌面
 *   node scripts/04_render_pdf.js --work <工作目录> --no-volume         # 只要单科
 * 不传 --volume / --no-volume 时，按 study_profile.json 的 output_granularity 决定：
 * per_subject → 不生成总册；volume / both → 生成总册。
 *
 * 说明：
 *  - 排版密度从 study_profile.json 的 layout 读取（compact/normal/loose）
 *  - 渲染前自动剥离修订记录行（<修订记录：…>）与 HTML 注释，它们不会出现在 PDF 里
 *  - 缺失/空的笔记分片会逐个告警，封面按"实际收录"计数，绝不虚报
 *  - 需要 playwright-core >= 1.42（page.pdf 的 outline/tagged 选项）
 *
 * 退出码：0 成功 / 1 完成但存在缺失笔记或个别科目渲染失败 / 2 缺输入文件
 */
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');
const env = require('./lib/env.js');
const { chromium } = env.loadPlaywright();

const args = env.parseArgs(process.argv);
const WORK = env.workDir(args);
const SC = env.scrapeDir(WORK);
const NOTES = env.ensureDir(path.join(SC, 'notes'));
const PDFS = env.ensureDir(path.join(SC, 'pdf'));
const profile = env.readProfile(WORK);
const LOCK = path.join(SC, '.render.lock');

// 总册开关：命令行显式参数 > study_profile.json 的 output_granularity > 默认生成
if (args.volume && args['no-volume']) {
  console.error('--volume 与 --no-volume 互相矛盾，只能传一个');
  process.exit(2);
}
const wantVolume = args.volume ? true
  : args['no-volume'] ? false
    : (profile.output_granularity !== 'per_subject');

// 排版变量一次算好（此前在一次运行中被重复计算 5 次）
const LV = env.layoutVars(profile.layout);
const MV = LV['--margin-v'];
const MH = LV['--margin-h'];

const log = env.log;

const esc = s => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');
const inline = s => esc(s)
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/【(.+?)】/g, '<span class="tag">$1</span>');

/** 渲染前剥离：HTML 注释与修订记录行（修订员写在笔记末尾的 <修订记录：…>），两者都不应出现在 PDF */
function stripNonRendered(md) {
  return md
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter(ln => !/^\s*<?\s*修订记录[：:]/.test(ln))
    .join('\n');
}

/** 去掉笔记开头的一级标题（科目名）—— 封面/分节标题已承担，避免 PDF 书签出现两条同名条目 */
function stripLeadingH1(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let idx = 0;
  while (idx < lines.length && /^\s*$/.test(lines[idx])) idx++;
  if (idx < lines.length && /^#\s+/.test(lines[idx])) lines.splice(idx, 1);
  return lines.join('\n');
}

/** 所有标题降一级（用于合并到总册时保持层级） */
function demoteHeadings(md, startAtFirst = true) {
  return md.split('\n').map(ln => {
    const m = ln.match(/^(#{1,5})\s+(.*)$/);
    if (!m) return ln;
    if (!startAtFirst && m[1].length === 1) return ln;
    return '#'.repeat(m[1].length + 1) + ' ' + m[2];
  }).join('\n');
}

/** 本地时区 YYYY-MM-DD（不用 UTC 的 toISOString，避免早 8 点生成时日期变成"昨天"） */
const localDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** 轻量 Markdown → HTML：只支持标题、列表、加粗、表格、引用（与给 subagent 的格式约束一致） */
function md2html(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let stack = [];   // 打开的列表栈（'ul' | 'ol'）
  let bq = null;    // 收集中的引用块行
  const close = d => { while (stack.length > d) out.push(stack.pop() === 'ul' ? '</ul>' : '</ol>'); };
  const flushBq = () => { if (bq) { out.push('<blockquote>' + bq.map(inline).join('<br>') + '</blockquote>'); bq = null; } };
  const openList = (type, startN) => {
    if (type === 'ol' && startN && startN !== '1') out.push(`<ol start="${Number(startN)}">`);
    else out.push(type === 'ul' ? '<ul>' : '<ol>');
    stack.push(type);
  };
  const isListItem = s => /^\s*([-*+]|\d+[.)])\s+/.test(s);
  const olStart = mm => (mm[2].match(/\d+/) || ['1'])[0];

  while (i < lines.length) {
    const ln = lines[i]; let m;
    if (bq && !/^\s*>\s?/.test(ln)) flushBq(); // 引用块遇非 > 行即结束
    if (/^\s*$/.test(ln)) {
      // 空行：若下一行仍是列表项/引用则不打断，否则关闭所有打开结构
      const nxt = lines[i + 1] || '';
      if (!isListItem(nxt) && !/^\s*>\s?/.test(nxt)) { close(0); flushBq(); }
      i++; continue;
    }
    if ((m = ln.match(/^(#{1,6})\s+(.*)$/))) { close(0); const lv = m[1].length; out.push(`<h${lv}>${inline(m[2])}</h${lv}>`); i++; continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(ln)) { close(0); out.push('<hr>'); i++; continue; }
    if ((m = ln.match(/^\s*>\s?(.*)$/))) { close(0); bq = bq || []; bq.push(m[1]); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(ln) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      close(0);
      // 单元格支持 \| 转义（法条引用里可能出现竖线）
      const cells = r => r.trim().replace(/^\|/, '').replace(/\|$/, '')
        .split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
      const head = cells(ln); i += 2; const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      out.push('<table><thead><tr>' + head.map(h => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    if ((m = ln.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) {
      const indent = Math.floor(m[1].replace(/\t/g, '  ').length / 2);
      const type = /^[-*+]$/.test(m[2]) ? 'ul' : 'ol';
      const want = indent + 1;
      if (stack.length > want) close(want);
      while (stack.length < want) {
        const innermost = stack.length === want - 1;
        const t = innermost ? type : (stack[stack.length - 1] === 'ol' ? 'ol' : 'ul');
        openList(t, innermost && t === 'ol' ? olStart(m) : null);
      }
      if (stack[stack.length - 1] !== type) {
        // 同层级 ul↔ol 切换：先关旧列表再开新列表
        out.push(stack.pop() === 'ul' ? '</ul>' : '</ol>');
        openList(type, type === 'ol' ? olStart(m) : null);
      }
      out.push(`<li>${inline(m[3])}</li>`); i++; continue;
    }
    flushBq(); close(0); out.push(`<p>${inline(ln)}</p>`); i++;
  }
  flushBq(); close(0);
  return out.join('\n');
}

function loadCss() {
  const f = path.join(__dirname, '..', 'assets', 'pdf_style.css');
  return fs.readFileSync(f, 'utf8') + '\n' + env.layoutCssVars(profile.layout);
}

// 页面 PDF 参数：margin 以此为准（CDP printToPDF 的 margin 参数优先于 CSS @page）
const PAGE_OPTS = {
  format: 'A4', printBackground: true, outline: true, tagged: true,
  displayHeaderFooter: true, headerTemplate: '<div></div>',
  footerTemplate: '<div style="width:100%;font-size:7.5pt;color:#999;text-align:center;">'
    + '<span class="pageNumber"></span> / <span class="totalPages"></span></div>',
  margin: { top: MV, bottom: MV, left: MH, right: MH },
};

(async () => {
  const mFile = path.join(SC, 'units_manifest.json');
  if (!fs.existsSync(mFile)) { console.error('未找到 units_manifest.json，请先运行 03_build_units.js'); process.exit(2); }
  const manifest = env.readJson(mFile, []);
  if (!manifest.length) { console.error('units_manifest.json 为空 —— 请检查 03_build_units.js 的输出'); process.exit(2); }

  if (!env.acquireLock(LOCK)) {
    log('另一个渲染进程似乎正在运行（scrape/.render.lock）。若确认没有并发，删除该文件后重试。');
    return 1;
  }

  // ctx 从创建到 close 全程在 try 内：loadCss/findChrome/启动失败也不能泄漏锁
  let ctx = null;
  try {
    const CSS = loadCss();
    const CHROME = env.findChrome();
    ctx = await chromium.launchPersistentContext(path.join(SC, 'profile-pdf'), {
      executablePath: CHROME, headless: true,
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    const page = ctx.pages()[0] || await ctx.newPage();
    const bySubject = {};
    for (const m of manifest) (bySubject[m.subjectKey] = bySubject[m.subjectKey] || []).push(m);

    /** 收集某科目各 part 的笔记 Markdown（剥离修订记录/注释），缺失分片逐个告警 */
    const collectParts = parts => {
      const bodies = [];
      const missing = [];
      let seq = 0, foundCount = 0;
      for (const p of parts) {
        const f = path.join(NOTES, p.noteFile);
        let t = null;
        if (fs.existsSync(f)) t = stripNonRendered(fs.readFileSync(f, 'utf8')).trim();
        if (!t) { missing.push(p); continue; }
        let md = t;
        if (seq > 0) { md = demoteHeadings(t); md = `## 第 ${seq + 1} 部分（续）\n\n` + md; }
        else md = stripLeadingH1(t);
        bodies.push(md); seq++; foundCount += (Number(p.count) || 0);
      }
      return { bodies, missing, found: seq, foundCount };
    };

    const renderToPdf = async (html, pdfPath) => {
      const htmlPath = pdfPath.replace(/\.pdf$/, '.html');
      env.writeFileAtomic(htmlPath, `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>法考错题笔记</title><style>${CSS}</style></head><body>${html}</body></html>`);
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
      await page.evaluate(() => (document.fonts && document.fonts.ready) || true).catch(() => {});
      await page.waitForTimeout(200);
      await page.pdf(Object.assign({ path: pdfPath }, PAGE_OPTS));
    };

    // ---------- 单科 PDF ----------
    const results = [];
    const failed = [];
    let missingParts = 0;
    const cpByKey = {}; // 缓存各科 collectParts 结果，总册复用，避免二次读文件与 missing 双计
    for (const [key, parts] of Object.entries(bySubject)) {
      try {
        const cp = collectParts(parts);
        cpByKey[key] = cp;
        const { bodies, missing, found, foundCount } = cp;
        if (missing.length) {
          missingParts += missing.length;
          for (const p of missing) console.error('WARN 缺笔记:', p.noteFile, `（manifest 题数 ${p.count}，重跑阶段 4 对应 subagent 可补齐）`);
        }
        if (!found) { console.log('SKIP (no notes):', key); continue; }

        const totalCount = parts.reduce((a, b) => a + (Number(b.count) || 0), 0);
        const countLabel = missing.length
          ? `实际收录 ${foundCount} 道错题（缺 ${missing.length} 个分片共 ${totalCount - foundCount} 题）`
          : `共 ${totalCount} 道错题`;
        const subject = parts[0].subject;
        const body = `<div class="cover"><h1>${esc(subject)}</h1>`
          + `<div class="sub">法考错题知识点笔记</div>`
          + `<div class="sub">${esc(parts[0].group)} · ${countLabel}</div>`
          + `<div class="meta">生成日期 ${localDate()}</div></div>`
          + md2html(bodies.join('\n\n'));
        const name = parts[0].file.replace(/\.json$/, '').replace(/_part\d+of\d+$/, '');
        const pdfPath = path.join(PDFS, name + '.pdf');
        await renderToPdf(body, pdfPath);
        console.log('PDF:', name + '.pdf', Math.round(fs.statSync(pdfPath).size / 1024) + 'KB', `questions=${foundCount}/${totalCount}`);
        results.push({ subject, group: parts[0].group, file: pdfPath, count: foundCount });
      } catch (e) {
        // 单科失败不拖垮整批，最后汇总退出码
        failed.push(key);
        console.error('ERROR 渲染失败:', key, (e && e.message) || e);
      }
    }

    // 复制到交付目录（固定目录名），并清理本次未产出的过期 PDF
    const deliver = env.ensureDir(path.join(WORK, '法考错题笔记'));
    for (const r of results) fs.copyFileSync(r.file, path.join(deliver, path.basename(r.file)));
    const keep = new Set(results.map(r => path.basename(r.file)));
    for (const f of fs.readdirSync(deliver)) {
      if (f.endsWith('.pdf') && !keep.has(f)) {
        try { fs.unlinkSync(path.join(deliver, f)); console.log('已清理过期交付文件:', f); } catch (e) { console.error('WARN 清理失败:', f, (e && e.message) || e); }
      }
    }
    env.writeJsonAtomic(path.join(SC, 'pdf_manifest.json'), results, 2);
    console.log('单科 PDF 完成：', results.length, '→', deliver);

    // ---------- 总册 ----------
    if (wantVolume) {
      try {
        const rank = g => (g === '客观题一' ? 0 : 1);
        // 复用单科阶段已收集的笔记内容，不再重复读文件与累计缺失
        const allSubs = Object.entries(bySubject).map(([key, parts]) => {
          const cp = cpByKey[key] || collectParts(parts);
          return { key, cp, subject: parts[0].subject, group: parts[0].group, count: cp.foundCount };
        });
        // 总册与单科口径一致：没有笔记的科目不进目录/封面/正文
        const subjects = allSubs.filter(s => s.cp.found > 0)
          .sort((a, b) => rank(a.group) - rank(b.group) || b.count - a.count);
        for (const s of allSubs.filter(s => s.cp.found === 0)) console.log('总册跳过（无笔记）:', s.subject);

        const totalQ = subjects.reduce((a, b) => a + b.count, 0);
        let html = `<div class="cover"><h1>法考错题知识点笔记</h1><div class="line"></div>`
          + `<div class="sub">客观题一 + 客观题二 · 全 ${subjects.length} 科</div>`
          + `<div class="meta">共 ${totalQ} 道错题<br>生成日期 ${localDate()}</div></div>`;

        html += `<div class="toc"><h1>目录</h1><table><thead><tr><th>科目</th><th>所属卷</th>`
          + `<th style="text-align:right">错题数</th></tr></thead><tbody>`
          + subjects.map(s => `<tr><td>${esc(s.subject)}</td><td class="vol">${esc(s.group)}</td>`
            + `<td class="num">${s.count} 道</td></tr>`).join('')
          + `</tbody></table><div class="hint">提示：PDF 左侧书签面板可按科目与知识点跳转。</div></div>`;

        subjects.forEach((s, idx) => {
          html += `<section class="subj${idx === 0 ? ' first' : ''}"><h1>${esc(s.subject)}</h1>`
            + `<div class="subjmeta">${esc(s.group)} · 共 ${s.count} 道错题 · 分 ${s.cp.found} 部分</div>`
            + md2html(s.cp.bodies.join('\n\n')) + `</section>`;
        });

        const vol = path.join(SC, '法考错题知识点笔记_总册.pdf');
        await renderToPdf(html, vol);
        const kb = Math.round(fs.statSync(vol).size / 1024);
        console.log('总册：', vol, kb + 'KB', '科目=' + subjects.length, '题=' + totalQ);

        if (args.desktop) {
          const d = env.desktopDir();
          if (d) {
            const dest = path.join(d, '法考错题知识点笔记_总册.pdf');
            if (fs.existsSync(dest)) console.log('注意：桌面已存在同名文件，已覆盖 ——', dest);
            fs.copyFileSync(vol, dest);
            console.log('已另存到桌面：', dest);
            console.log('提示：若桌面在 OneDrive 同步范围内，该 PDF 将同步到微软云。');
          } else console.log('未定位到桌面目录，跳过另存');
        }
      } catch (e) {
        // 总册失败不吞掉单科成果，计入 failed 汇总退出码
        failed.push('总册');
        console.error('ERROR 总册渲染失败:', (e && e.message) || e);
      }
    }

    console.log('渲染完成。结果清单：', path.join(SC, 'pdf_manifest.json'));
    if (failed.length || missingParts) {
      console.error(`完成但有告警：渲染失败科目 ${failed.length} 个（${failed.join('、') || '无'}），缺失笔记分片 ${missingParts} 个（见上方 WARN）`);
      console.error('建议：补齐缺失笔记后重跑本脚本，再对外交付。');
      return 1;
    }
    return 0;
  } finally {
    // 任何路径都关闭浏览器，避免孤儿 Chrome 占住 profile-pdf 的单例锁
    if (ctx) await ctx.close().catch(() => {});
    env.releaseLock(LOCK);
  }
})()
  .then(c => { process.exitCode = c || 0; })
  .catch(e => { console.error('FATAL', (e && e.stack) || e); process.exitCode = 1; });
