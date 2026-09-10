/**
 * 阶段 6：把笔记 Markdown 渲染成 PDF
 *
 * 用法：
 *   node scripts/04_render_pdf.js --work <工作目录>                 # 每科一份 PDF
 *   node scripts/04_render_pdf.js --work <工作目录> --volume         # 追加一本总册
 *   node scripts/04_render_pdf.js --work <工作目录> --volume --desktop  # 总册另存到桌面
 *
 * 排版密度从 <工作目录>/study_profile.json 的 layout 字段读取（compact/normal/loose）。
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const env = require('./lib/env.js');

const args = env.parseArgs(process.argv);
const WORK = env.workDir(args);
const SC = env.scrapeDir(WORK);
const NOTES = env.ensureDir(path.join(SC, 'notes'));
const PDFS = env.ensureDir(path.join(SC, 'pdf'));
const profile = env.readProfile(WORK);

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = s => esc(s)
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/【(.+?)】/g, '<span class="tag">$1</span>');

/** 所有标题降一级（用于合并到总册时保持层级） */
function demoteHeadings(md, startAtFirst = true) {
  return md.split('\n').map(ln => {
    const m = ln.match(/^(#{1,5})\s+(.*)$/);
    if (!m) return ln;
    if (!startAtFirst && m[1].length === 1) return ln;
    return '#'.repeat(m[1].length + 1) + ' ' + m[2];
  }).join('\n');
}

/** 轻量 Markdown → HTML：只支持标题、列表、加粗、表格、引用（与给 subagent 的格式约束一致） */
function md2html(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0, stack = [];
  const close = d => { while (stack.length > d) out.push(stack.pop() === 'ul' ? '</ul>' : '</ol>'); };
  while (i < lines.length) {
    const ln = lines[i]; let m;
    if (/^\s*$/.test(ln)) { close(0); i++; continue; }
    if ((m = ln.match(/^(#{1,6})\s+(.*)$/))) { close(0); const lv = m[1].length; out.push(`<h${lv}>${inline(m[2])}</h${lv}>`); i++; continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(ln)) { close(0); out.push('<hr>'); i++; continue; }
    if ((m = ln.match(/^\s*>\s?(.*)$/))) { close(0); out.push(`<blockquote>${inline(m[1])}</blockquote>`); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(ln) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      close(0);
      const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(ln); i += 2; const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      out.push('<table><thead><tr>' + head.map(h => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    if ((m = ln.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) {
      const indent = Math.floor(m[1].length / 2);
      const type = /^[-*+]$/.test(m[2]) ? 'ul' : 'ol';
      if (stack.length < indent + 1) { out.push(type === 'ul' ? '<ul>' : '<ol>'); stack.push(type); }
      else if (stack.length > indent + 1) close(indent + 1);
      out.push(`<li>${inline(m[3])}</li>`); i++; continue;
    }
    close(0); out.push(`<p>${inline(ln)}</p>`); i++;
  }
  close(0);
  return out.join('\n');
}

function loadCss() {
  const f = path.join(__dirname, '..', 'assets', 'pdf_style.css');
  return fs.readFileSync(f, 'utf8') + '\n' + env.layoutCssVars(profile.layout);
}

const PAGE_OPTS = (marginV, marginH) => ({
  format: 'A4', printBackground: true, outline: true, tagged: true,
  displayHeaderFooter: true, headerTemplate: '<div></div>',
  footerTemplate: '<div style="width:100%;font-size:7.5pt;color:#999;text-align:center;">'
    + '<span class="pageNumber"></span> / <span class="totalPages"></span></div>',
  margin: { top: marginV, bottom: marginV, left: marginH, right: marginH },
});

(async () => {
  const manifest = env.readJson(path.join(SC, 'units_manifest.json'), []);
  if (!manifest.length) { console.error('未找到 units_manifest.json，请先运行 03_build_units.js'); process.exit(2); }

  const CSS = loadCss();
  const CHROME = env.findChrome();
  const ctx = await chromium.launchPersistentContext(path.join(SC, 'profile-pdf'), {
    executablePath: CHROME, headless: true,
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  const bySubject = {};
  for (const m of manifest) (bySubject[m.subjectKey] = bySubject[m.subjectKey] || []).push(m);

  // ---------- 单科 PDF ----------
  const results = [];
  for (const [key, parts] of Object.entries(bySubject)) {
    const bodies = [];
    let found = 0, seq = 0;
    for (const p of parts) {
      const f = path.join(NOTES, p.noteFile);
      if (!fs.existsSync(f)) continue;
      const t = fs.readFileSync(f, 'utf8').trim();
      if (!t) continue;
      let md = t;
      if (seq > 0) { md = demoteHeadings(t); md = `## 第 ${seq + 1} 部分（续）\n\n` + md; }
      bodies.push(md); seq++; found++;
    }
    if (!found) { console.log('SKIP (no notes):', key); continue; }

    const count = parts.reduce((a, b) => a + b.count, 0);
    const subject = parts[0].subject;
    const body = `<div class="cover"><h1>${esc(subject)}</h1>`
      + `<div class="sub">法考错题知识点笔记</div>`
      + `<div class="sub">${esc(parts[0].group)} · 共 ${count} 道错题</div>`
      + `<div class="meta">生成日期 ${new Date().toISOString().slice(0, 10)}</div></div>`
      + md2html(bodies.join('\n\n'));
    const name = parts[0].file.replace(/\.json$/, '').replace(/_part\d+of\d+$/, '');
    const htmlPath = path.join(PDFS, name + '.html');
    const pdfPath = path.join(PDFS, name + '.pdf');
    fs.writeFileSync(htmlPath, `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(subject)}</title><style>${CSS}</style></head><body>${body}</body></html>`, 'utf8');
    await page.goto('file:///' + htmlPath.replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForTimeout(400);
    const mv = env.layoutVars(profile.layout)['--margin-v'];
    const mh = env.layoutVars(profile.layout)['--margin-h'];
    await page.pdf(Object.assign({ path: pdfPath }, PAGE_OPTS(mv, mh)));
    console.log('PDF:', name + '.pdf', Math.round(fs.statSync(pdfPath).size / 1024) + 'KB', 'questions=' + count);
    results.push({ subject, group: parts[0].group, file: pdfPath, count });
  }

  // 复制到交付目录
  const deliver = env.ensureDir(path.join(WORK, `法考错题笔记_${results.length}科`));
  for (const r of results) fs.copyFileSync(r.file, path.join(deliver, path.basename(r.file)));
  fs.writeFileSync(path.join(SC, 'pdf_manifest.json'), JSON.stringify(results, null, 2), 'utf8');
  console.log('单科 PDF 完成：', results.length, '→', deliver);

  // ---------- 总册 ----------
  if (args.volume) {
    const rank = g => (g === '客观题一' ? 0 : 1);
    const subjects = Object.entries(bySubject).map(([key, parts]) => ({
      key, parts, subject: parts[0].subject, group: parts[0].group,
      count: parts.reduce((a, b) => a + b.count, 0),
    })).sort((a, b) => rank(a.group) - rank(b.group) || b.count - a.count);

    const totalQ = subjects.reduce((a, b) => a + b.count, 0);
    let html = `<div class="cover"><h1>法考错题知识点笔记</h1><div class="line"></div>`
      + `<div class="sub">客观题一 + 客观题二 · 全 ${subjects.length} 科</div>`
      + `<div class="meta">共 ${totalQ} 道错题<br>生成日期 ${new Date().toISOString().slice(0, 10)}</div></div>`;

    html += `<div class="toc"><h1>目录</h1><table><thead><tr><th>科目</th><th>所属卷</th>`
      + `<th style="text-align:right">错题数</th></tr></thead><tbody>`
      + subjects.map(s => `<tr><td>${esc(s.subject)}</td><td class="vol">${esc(s.group)}</td>`
        + `<td class="num">${s.count} 道</td></tr>`).join('')
      + `</tbody></table><div class="hint">提示：PDF 左侧书签面板可按科目与知识点跳转。</div></div>`;

    subjects.forEach((s, idx) => {
      const bodies = []; let seq = 0;
      for (const p of s.parts) {
        const f = path.join(NOTES, p.noteFile);
        if (!fs.existsSync(f)) continue;
        const t = fs.readFileSync(f, 'utf8').trim();
        if (!t) continue;
        let md = demoteHeadings(t);
        if (seq > 0) md = `## 第 ${seq + 1} 部分（续）\n\n` + md;
        bodies.push(md); seq++;
      }
      html += `<section class="subj${idx === 0 ? ' first' : ''}"><h1>${esc(s.subject)}</h1>`
        + `<div class="subjmeta">${esc(s.group)} · 共 ${s.count} 道错题 · 分 ${seq} 部分</div>`
        + md2html(bodies.join('\n\n')) + `</section>`;
    });

    const vHtmlPath = path.join(SC, 'volume.html');
    fs.writeFileSync(vHtmlPath, `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>法考错题知识点笔记（总册）</title><style>${CSS}</style></head><body>${html}</body></html>`, 'utf8');
    await page.goto('file:///' + vHtmlPath.replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForTimeout(1000);
    const mv = env.layoutVars(profile.layout)['--margin-v'];
    const mh = env.layoutVars(profile.layout)['--margin-h'];
    const vol = path.join(SC, '法考错题知识点笔记_总册.pdf');
    await page.pdf(Object.assign({ path: vol }, PAGE_OPTS(mv, mh)));
    const kb = Math.round(fs.statSync(vol).size / 1024);
    console.log('总册：', vol, kb + 'KB', '科目=' + subjects.length, '题=' + totalQ);

    if (args.desktop) {
      const d = env.desktopDir();
      if (d) {
        const dest = path.join(d, '法考错题知识点笔记_总册.pdf');
        fs.copyFileSync(vol, dest);
        console.log('已另存到桌面：', dest);
      } else console.log('未定位到桌面目录，跳过另存');
    }
  }

  await ctx.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
