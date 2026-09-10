# 典型示例：从一句话到 18 份 PDF

## 示例：用户丢来一个链接

> 用户：`https://www.zhumavip.com/w/my/errorbooks?businessType=104&...&queType=错题本&mineType=01`
> 你能看到错题吗？

### 1. 触发与初步判断

识别出 `zhumavip.com` + `errorbooks` → 命中本技能。先说明该页面需登录，匿名看不到内容，并给出路径选项。

### 2. 阶段 0 需求对齐（示范提问）

用 `AskUserQuestion`，一次 3–4 个：

```
Q1 笔记排版要多密？
  · 紧凑（推荐）—— 打印随身背
  · 标准
  · 宽松 —— 平板批注

Q2 输出成几份？
  · 每科一份
  · 合成一本总册
  · 两者都要（推荐）

Q3 内容侧重？
  · 知识点梳理 / 易错点辨析 / 法条期限速记 / 综合（推荐）

Q4 你目前最薄弱的科目是？（多选）
```

第二轮补：复习进度、每日可投入时长 + 学习习惯、距考天数。
结果写入 `study_profile.json`。

### 3. 阶段 1 登录

```bash
node scripts/01_login.js --work D:\fakao-2026
```

- 脚本生成 `qr_login.png`；
- 用 `present_files` 发给用户，提示"用**竹马 APP** 扫码，不是微信"；
- 轮询检测到登录成功，落盘 `scrape/profile/`。

### 4. 阶段 2 抓取

```bash
node scripts/02_scrape.js --work D:\fakao-2026 --groups 1,2
```

输出示例：

```
catalog 客观题一 -> 200 成功
catalog 客观题二 -> 200 成功
chapters: 180 expected questions: 1661
stage 2.2 done. questions collected: 1661
stage 2.3: total 1661 pending 1661
  [25/1661] ... [1650/1661] ...
stage 2.3 done. stored: 1655 fails: 0
NOTE: userOptions/userAnswer 为空 —— 竹马不保存"我错选了哪个选项"
```

**必须向用户报告**：总量是 1661（含重复题），去重后 1655；且"我的错选"拿不到。

### 5. 阶段 3 切分

```bash
node scripts/03_build_units.js --work D:\fakao-2026 --chunk 55
```

```
题目总数：1655
单元数：41（每单元 <= 55 题）
 客观题一_刑法_part1of5.json 55 题
 ...
```

### 6. 阶段 4 生成笔记（subagent 扇出）

按 manifest 派发，**每批 7–8 个并行**，提示词用 `assets/note_prompt_template.md`。

```
Agent #1  → units/客观题二_经济法_part1of2.json
...
Agent #8  → units/客观题二_商法_part2of3.json
```

每个只回复一行：`notes/xxx.md — 知识点 27 个`

39 个单元约 5 批完成。

### 7. 阶段 5 审查与修订（新增）

**5.1 分派审查 subagent**，按「科目 × 维度」：

```
刑法（5 个 part，大科目）→
  reviewer #1  D1 法条准确性
  reviewer #2  D2 答案与解析一致性
  reviewer #3  D3 知识点覆盖完整性
  reviewer #4  D4 结构与格式合规
  reviewer #5  D5 学员适配
  reviewer #6  D6 跨单元去重与衔接

环境与自然资源法（9 题，小科目）→
  reviewer #7  D1+D2
  reviewer #8  D3+D4+D5+D6
```

每个输出到 `scrape/reviews/<科目>__<维度>.md`，只报告不改文件。

**5.2 汇总**

```bash
node scripts/05_review_aggregate.js --work D:\fakao-2026
```

```
审查报告： 47
问题统计： {"P0":6,"P1":23,"P2":38,"P3":11}
需修订科目： 9
已写入： scrape/reviews/_fixlist.md
```

**5.3 修订**：对 9 个有 P0/P1 的科目各派一个修订 subagent（模板 B），只改报告点到的地方。

**5.4 复审**：对 6 条 P0 做验证。

### 8. 阶段 6 渲染

```bash
node scripts/04_render_pdf.js --work D:\fakao-2026 --volume --desktop
```

```
PDF: 客观题一_刑法.pdf 821KB questions=252
...
单科 PDF 完成： 18
总册： 法考错题知识点笔记_总册.pdf 4261KB 科目=18 题=1655
已另存到桌面： C:\Users\xxx\OneDrive\桌面\法考错题知识点笔记_总册.pdf
```

### 9. 阶段 7 交付

`present_files` 一次传 19 个路径（18 单科 + 总册），并在回复里给出：

- 按科目的题量统计表；
- 审查结论（P0 全部修复、遗留 N 条 P2）；
- 限制说明（我的错选拿不到）；
- 可选后续（薄弱点优先级清单 / Anki 卡片 / 增量更新）。

## 第二个示例：考前一周的增量复盘

> 用户：距考试还有 8 天，把上次笔记改成冲刺版

- 读取已有 `study_profile.json`，只问变化项（确认 `review_round=考前一周`、`days_to_exam=8`）；
- 直接复用已登录的 `scrape/profile` 与已有 `questions.json`（若未过期）；
- 重新切单元、重新生成笔记（提示词带上冲刺设定：只留高频结论与口诀）；
- 对**变化最大的科目**做 D5（学员适配）与 D1 审查；
- 渲染新版 PDF。

这样不用重新扫码、不用重新抓题，几分钟就能出一版新笔记。
