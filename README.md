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
# 0. 准备：本机需有 Google Chrome 或 Microsoft Edge；安装 playwright-core（建议固定版本，PDF 书签需 >= 1.42）
npm install playwright-core@1.49.1 --prefix <隔离目录>
export NODE_PATH=<隔离目录>/node_modules
node -e "require('playwright-core')"   # 验证安装，无输出即 OK

# 1. 登录（生成二维码，用竹马 APP 扫；--wait-min 可调轮询时长）
node scripts/01_login.js --work D:\fakao-2026

# 2. 全量抓取（--delay 默认 150ms、下限 100ms）
node scripts/02_scrape.js --work D:\fakao-2026 --groups 1,2

# 3. 切分处理单元（重跑会重建 units/，旧笔记需重新生成）
node scripts/03_build_units.js --work D:\fakao-2026 --chunk 55

# 4. 生成笔记 —— 由主 Agent 按 units_manifest.json 派发 subagent 并行完成
#    提示词模板：assets/note_prompt_template.md

# 5. 审查 —— 由主 Agent 按「科目 × 六个维度」派发 subagent，只出报告不改文件
#    模板：assets/review_prompt_template.md
node scripts/05_review_aggregate.js --work D:\fakao-2026   # 汇总修订清单（先于渲染！）

# 6. 修订有 P0/P1 的科目（subagent），然后渲染 PDF
#    --volume 生成总册（是否加由 study_profile.json 的 output_granularity 决定，--no-volume 可取消）
node scripts/04_render_pdf.js --work D:\fakao-2026 --volume --desktop
```

**注意**：第 4、5 步是 subagent 编排步骤，由 AI Agent 执行而非纯脚本；脚本负责前后的数据准备与汇总。**执行顺序是 01→02→03→（生成）→（审查）→ 05 →（修订）→ 04** —— 汇总脚本 05 必须在渲染脚本 04 之前运行。

**脚本退出码**：0 成功；1 完成但有失败/缺失（重跑即可续抓）；2 缺输入或未登录（按报错提示先补前置步骤）。

## 目录结构

```
zhuma-fakao-review/
├── SKILL.md                          # 技能主入口（目标/场景/输入输出/七阶段流程）
├── README.md                         # 本文件
├── SECURITY_AUDIT.md                 # 安全审计（恶意代码扫描、凭据与数据流说明）
├── LICENSE                           # MIT
├── package.json                      # 依赖声明（playwright-core，版本下限 1.42）
├── scripts/
│   ├── lib/env.js                    # 环境探测与公共工具（原子写/锁/参数校验）
│   ├── 01_login.js                   # 扫码登录（固定 profile）
│   ├── 02_scrape.js                  # 全量抓取（断点续跑/熔断/退避）
│   ├── 03_build_units.js             # 切分处理单元
│   ├── 04_render_pdf.js              # 渲染单科 PDF / 总册（在 05 之后运行）
│   └── 05_review_aggregate.js        # 汇总审查报告 → 修订清单（在 04 之前运行）
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
| 0 | 需求对齐：排版偏好 + 学情采集（含数据去向告知） | 主 Agent 提问（`AskUserQuestion`） |
| 1 | 扫码登录 | 脚本 `01_login.js` |
| 2 | 全量抓取题面/答案/解析 | 脚本 `02_scrape.js` |
| 3 | 按科目切分处理单元 | 脚本 `03_build_units.js` |
| 4 | 并行生成知识点笔记 | subagent 扇出（每批 7–8 个） |
| 5 | 六维并行审查 → 汇总（05）→ 修订 → 复审 | subagent 扇出 + `05_review_aggregate.js` |
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
4. **登录态会过期**，过期后重跑 `01_login.js` 重新扫码即可。
5. 总册 PDF 中，各单元内部章节编号彼此独立，会出现编号重起（已用「第 N 部分（续）」缓解）。

## 隐私与数据流向（请务必阅读）

- **对竹马平台只读**：不提交作答、不交卷、不修改账号数据；串行抓取且默认 150ms 间隔，仅抓取**本人账号**的错题，请遵守平台服务条款。
- **脚本网络出口仅 `zhumavip.com`**：全部 URL 硬编码官方域名，无第三方上报。
- **但工作流整体有两条"出本机"的数据通道，需要你知情**：
  1. **AI 模型服务**：阶段 4/5 的 subagent 由 LLM 驱动，错题内容与你填写的学情（薄弱科目、复习进度、目标等）会作为提示词发送给你所使用的模型服务商。数据仅用于生成笔记。
  2. **云同步盘**：`--desktop` 会把总册 PDF 复制到桌面 —— 若桌面在 OneDrive 同步范围内，该文件会同步到微软云。不需要云备份就别加 `--desktop`。
- **本地敏感数据**：登录态（会话 cookie）保存在 `<工作目录>/scrape/profile/`。请勿分享该目录、勿把它放进云同步或公共位置。清除方式：删除整个工作目录即可。
- 笔记、题目、审查报告等中间产物都落在 `<工作目录>/scrape/`，可随时删除。

## 一次完整运行的实测规模

| 指标 | 数值 |
|---|---|
| 科目数 | 18（客观题一 9 + 客观题二 9） |
| 有题章节 | 180 |
| 唯一错题数 | 1655（章节预期合计 1661，差值为跨章节重复题，按 id 去重） |
| 处理单元 | 41 |
| 抓取耗时 | 约 9 分钟 |
| 笔记生成 subagent | 39 个（5 批并行；另 2 个单元因 429 限流由主 Agent 手写） |
| 产出 | 18 份单科 PDF（8.3MB）+ 总册 129 页（4.2MB） |

## 故障排查速查

| 现象 | 处理 |
|---|---|
| `未找到 playwright-core` | 按快速开始第 0 步安装并设置 `NODE_PATH` 后重试 |
| `未找到本机 Chrome / Edge` | 安装浏览器，或设置 `CHROME_PATH` 指向可执行文件 |
| 02 退出码 2 | 未登录或登录态过期：重跑 `01_login.js` 后再跑 02（已抓数据保留） |
| 02 退出码 1（有失败） | 直接重跑 02，自动从断点续抓 |
| 05 退出码 2（零解析） | 审查报告格式不符：检查表格 6 列、严重度只写 P0–P3，重跑即可 |
| 04 退出码 1（缺笔记） | 有分片没生成笔记：重跑阶段 4 对应 subagent 后再渲染 |
| 卡在"另一个进程正在运行" | 删除 `scrape/.scrape.lock` 或 `scrape/.render.lock`（确认无并发后） |
| 终端中文乱码 | 用 Git Bash，或先执行 `chcp 65001` |

## 许可

MIT（见 [LICENSE](LICENSE)）。欢迎 fork 与改进 —— 若竹马接口变动，请同步更新 `references/api_reference.md`。
