# zhuma-fakao-review · 竹马法考错题复习助手

把竹马法考（zhumavip.com）错题本里的**全部错题**，变成一份**按科目分册、可直接背诵的知识点笔记（PDF）**。

> 不是"把题目抄一遍"。它从错题反推反复考的重点知识点，补上**易错/易混点**，并结合你自己的薄弱科目、复习进度、学习习惯调整详略。

## 它解决什么问题

| 痛点 | 本技能的做法 |
|---|---|
| 错题散在 App 里，没法系统复习 | 全量抓取（客观题一 + 客观题二），结构化落盘 |
| 只知道"错了"，不知道"为什么错" | 官方解析 + 易错点辨析 |
| 错题几百上千道，根本看不完 | 按知识点合并去重，标注「考查 N 次」，按考频排序 |
| 笔记千人一面 | 先问学情（薄弱科目/轮次/时长/习惯），再生成 |
| 笔记可能写错 | 六个维度并行审查 + 修订 + 复审，P0 问题必须修 |
| 排版难看、打印费纸 | 紧凑排版（正文 9.3pt / 行高 1.45 / 页边距 11mm），可选三档密度 |

## 快速开始

```bash
# 0. 准备：本机需有 Google Chrome；安装 playwright-core
npm install playwright-core --prefix <隔离目录>
export NODE_PATH=<隔离目录>/node_modules

# 1. 登录（生成二维码，用竹马 APP 扫）
node scripts/01_login.js --work D:\fakao-2026

# 2. 全量抓取
node scripts/02_scrape.js --work D:\fakao-2026 --groups 1,2

# 3. 切分处理单元
node scripts/03_build_units.js --work D:\fakao-2026 --chunk 55

# 4. 生成笔记 —— 由主 Agent 按 units_manifest.json 派发 subagent 并行完成
#    提示词模板：assets/note_prompt_template.md

# 5. 审查 —— 由主 Agent 按「科目 × 六个维度」派发 subagent
#    模板：assets/review_prompt_template.md
node scripts/05_review_aggregate.js --work D:\fakao-2026   # 汇总修订清单

# 6. 渲染 PDF（--volume 生成总册，--desktop 另存桌面）
node scripts/04_render_pdf.js --work D:\fakao-2026 --volume --desktop
```

**注意**：第 4、5 步是 subagent 编排步骤，由 AI Agent 执行而非纯脚本；脚本负责前后的数据准备与汇总。

## 目录结构

```
zhuma-fakao-review/
├── SKILL.md                          # 技能主入口（目标/场景/输入输出/七阶段流程）
├── README.md                         # 本文件
├── scripts/
│   ├── lib/env.js                    # 环境探测（Chrome/Node/桌面）与公共工具
│   ├── 01_login.js                   # 扫码登录（固定 profile）
│   ├── 02_scrape.js                  # 全量抓取（断点续跑）
│   ├── 03_build_units.js             # 切分处理单元
│   ├── 04_render_pdf.js              # 渲染单科 PDF / 总册
│   └── 05_review_aggregate.js        # 汇总审查报告 → 修订清单
├── references/
│   ├── api_reference.md              # 竹马内部接口：鉴权头、参数、返回字段、错误码
│   ├── workflow.md                   # 端到端详解、环境约定、踩坑清单
│   ├── review_dimensions.md          # 六个审查维度定义与严重度分级
│   └── student_profile.md            # 学情问卷全文与笔记风格映射
├── assets/
│   ├── note_prompt_template.md       # 笔记生成 subagent 提示词
│   ├── review_prompt_template.md     # 审查/修订/复审 subagent 提示词
│   └── pdf_style.css                 # 排版样式（紧凑/标准/宽松）
└── examples/
    └── example_run.md                # 完整走查示例
```

## 七个阶段

| 阶段 | 内容 | 形式 |
|---|---|---|
| 0 | 需求对齐：排版偏好 + 学情采集 | 主 Agent 提问（`AskUserQuestion`） |
| 1 | 扫码登录 | 脚本 `01_login.js` |
| 2 | 全量抓取题面/答案/解析 | 脚本 `02_scrape.js` |
| 3 | 按科目切分处理单元 | 脚本 `03_build_units.js` |
| 4 | 并行生成知识点笔记 | subagent 扇出（每批 7–8 个） |
| 5 | 六维并行审查 → 汇总 → 修订 → 复审 | subagent 扇出 + `05_review_aggregate.js` |
| 6 | 渲染 PDF（单科 / 总册） | 脚本 `04_render_pdf.js` |
| 7 | 集中交付与复盘 | 主 Agent |

## 六个审查维度

| 编号 | 维度 | 说明 |
|---|---|---|
| D1 | 法条准确性 | 规则错误、已废止法条、期限/比例/人数等数字错误 |
| D2 | 答案与解析一致性 | 笔记结论是否与官方正确答案矛盾 |
| D3 | 知识点覆盖完整性 | 高频考点是否漏掉 |
| D4 | 结构与格式合规 | 是否破坏 PDF 渲染、表格是否规整 |
| D5 | 学员适配 | 是否符合采集到的学情 |
| D6 | 跨单元去重与衔接 | 多 part 之间是否重复、结论是否打架 |

## 已知限制

1. **拿不到"我的错选"** —— 竹马接口 `userOptions` / `userAnswer` 恒为 `null`，只记录"哪些题错了"，不保存你当时勾了哪个选项。正确答案与官方解析是完整的。
2. **仅覆盖客观题**（客观题一 / 客观题二）。
3. **依赖竹马内部接口**，前端改版可能失效；届时按 `references/api_reference.md` 的「接口变动时如何重新发现」处理。
4. 合并型 PDF 中，各单元内部章节编号彼此独立，会出现编号重起（已用「第 N 部分（续）」缓解）。

## 隐私与合规

- 全程**只读**：不提交任何作答、不交卷、不修改账号数据。
- 所有数据（登录态、题目、笔记）都落在**你自己的 `<工作目录>/scrape/`**，不上传任何第三方。
- 脚本不含任何外发逻辑；仅访问 `zhumavip.com` 及其官方资源域。
- 登录态保存在本地 profile 中，可随时删除整个工作目录彻底清除。

## 一次完整运行的实测规模

| 指标 | 数值 |
|---|---|
| 科目数 | 18（客观题一 9 + 客观题二 9） |
| 有题章节 | 180 |
| 唯一错题数 | 1655 |
| 处理单元 | 41 |
| 抓取耗时 | 约 9 分钟 |
| 笔记生成 subagent | 39 个（5 批并行） |
| 产出 | 18 份单科 PDF（8.3MB）+ 总册 129 页（4.2MB） |

## 许可

MIT。欢迎 fork 与改进 —— 若竹马接口变动，请同步更新 `references/api_reference.md`。
