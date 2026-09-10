# zhuma-fakao-review · 竹马法考错题复习助手

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Git%20Bash-blue)
![Node](https://img.shields.io/badge/node-%3E%3D16-brightgreen)
![playwright-core](https://img.shields.io/badge/playwright--core-%5E1.42-2CA6A4)

把竹马法考（zhumavip.com）错题本里的**全部错题**，变成一份**按科目分册、可直接背诵的知识点笔记（PDF）**——带六维 AI 审查闭环。

> 不是"把题目抄一遍"。它从错题反推反复考的重点知识点，补上**易错/易混点**，并结合你自己的薄弱科目、复习进度、学习习惯调整详略。

这同时是一个 [ZCode / Claude Code](https://code.claude.com) **技能包（Skill）**：把它放进技能目录后，AI Agent 会按 `SKILL.md` 的七阶段流程自主编排脚本与 subagent，你只需要扫码和回答几个问题。

---

## ✨ 特性

- **全量抓取**：走竹马内部只读接口（不交卷、不动作答记录），拿到题干、选项、**正确答案**与**完整官方解析**——这是页面爬取拿不到的信息密度。实测 1655 道错题约 9 分钟抓完，断点续跑、原子落盘、熔断退避。
- **个性化笔记**：先问学情（薄弱科目 / 复习轮次 / 距考天数 / 每日时长 / 习惯 / 目标），按知识点（而非题目顺序）合并去重，标注「考查 N 次」。
- **六维审查闭环**：笔记生成后由多个 subagent 按「科目 × 维度」并行审查（法条准确性 / 答案一致性 / 覆盖完整性 / 格式合规 / 学员适配 / 跨单元衔接），汇总成修订清单，P0 问题必须修订并复审。汇总脚本内置防呆：**解析不出问题条目时直接报错，绝不产出"无需修订"的假绿灯**。
- **紧凑排版 PDF**：单科分册 + 可选总册（封面 / 目录 / PDF 书签跳转），三档排版密度，中文排版优化，可直接打印或在平板上批注。
- **防御性工程**：所有 JSON 落盘原子写（中断不留截断文件）、进程锁防并发、登录态只存本地浏览器 profile、subagent 提示词内置防注入与写入路径白名单。

## 🔄 工作流程

```mermaid
flowchart LR
    A["阶段 0\n需求对齐 + 学情采集"] --> B["01_login.js\n扫码登录（固定 profile）"]
    B --> C["02_scrape.js\n全量抓取（断点续跑）"]
    C --> D["03_build_units.js\n按科目切分单元"]
    D --> E["阶段 4\nsubagent 并行生成笔记"]
    E --> F["阶段 5.1\n六维并行审查"]
    F --> G["05_review_aggregate.js\n汇总 → 修订清单"]
    G --> H["阶段 5.3–5.4\n修订 + P0 复审"]
    H --> I["04_render_pdf.js\n渲染单科 PDF / 总册"]
    I --> J["阶段 7\n集中交付"]
```

> 注意执行顺序：**汇总脚本 `05` 在渲染脚本 `04` 之前**——先审查修订、后渲染交付。每个科目最多 250+ 题会被切成 ≤55 题的单元，交给并行 subagent 分别处理。

## 🚀 快速开始

### 0. 准备环境

- Windows + 本机已装 **Google Chrome 或 Microsoft Edge**（也可用 `CHROME_PATH` 指定；macOS/Linux 探测逻辑存在但未实测）
- Node.js ≥ 16，安装 `playwright-core`（建议固定版本，PDF 书签需 ≥ 1.42）：

```bash
npm install playwright-core@1.49.1 --prefix <隔离目录>
export NODE_PATH=<隔离目录>/node_modules
node -e "require('playwright-core')"   # 验证安装，无输出即 OK
```

### 1. 安装为技能

```bash
# 克隆到你的技能目录（ZCode / Claude Code 会自动发现 SKILL.md）
git clone <本仓库地址> ~/.workbuddy/skills/zhuma-fakao-review
```

之后对 AI 说「把我的竹马错题整理成笔记」并附上错题本链接即可触发；也可以直接手动执行下面的脚本。

### 2. 手动跑流水线（可选）

```bash
# 1. 登录（生成二维码，用竹马 APP 扫；--wait-min 可调轮询时长，默认 12 分钟）
node scripts/01_login.js --work D:\fakao-2026

# 2. 全量抓取（--delay 默认 150ms、下限 100ms）
node scripts/02_scrape.js --work D:\fakao-2026 --groups 1,2

# 3. 切分处理单元（重跑会重建 units/，旧笔记需重新生成）
node scripts/03_build_units.js --work D:\fakao-2026 --chunk 55

# 4-5. 生成与审查笔记 —— 由 AI Agent 按 units_manifest.json 派发 subagent 并行完成
#      提示词模板：assets/note_prompt_template.md、assets/review_prompt_template.md
node scripts/05_review_aggregate.js --work D:\fakao-2026   # 汇总修订清单（先于渲染！）
#      对有 P0/P1 的科目派修订 subagent，必要时复审

# 6. 渲染 PDF
#    --volume 生成总册（默认由 study_profile.json 的 output_granularity 决定，--no-volume 可取消）
node scripts/04_render_pdf.js --work D:\fakao-2026 --volume --desktop
```

**脚本退出码**：`0` 成功；`1` 完成但有失败/缺失（重跑即可续抓）；`2` 前置条件不满足（各脚本文件头有精确口径，如 02 的 2=未登录、01 的 2=找不到二维码、03/05 的 2=缺输入或参数错误）。

## 📊 一次完整运行的实测规模

| 指标 | 数值 |
|---|---|
| 科目数 | 18（客观题一 9 + 客观题二 9） |
| 有题章节 | 180 |
| 唯一错题数 | 1655（章节预期合计 1661，差值为跨章节重复题，按 id 去重） |
| 处理单元 | 41（每单元 ≤ 55 题） |
| 抓取耗时 | 约 9 分钟 |
| 笔记生成 subagent | 39 个（5 批并行；另 2 个单元因 429 限流由主 Agent 手写） |
| 产出 | 18 份单科 PDF（8.3MB）+ 总册 129 页（4.2MB） |

## 📚 文档导航

| 文件 | 内容 |
|---|---|
| [SKILL.md](SKILL.md) | 技能主入口：目标 / 场景 / 输入输出 / 七阶段流程（AI Agent 按此执行） |
| [references/api_reference.md](references/api_reference.md) | 竹马内部接口：鉴权头、三个核心接口参数与返回字段、错误码、接口变动时如何重新发现 |
| [references/workflow.md](references/workflow.md) | 端到端流程详解、环境约定、踩坑清单 |
| [references/review_dimensions.md](references/review_dimensions.md) | 六个审查维度的定义、要抓的问题、严重度分级、分派方式 |
| [references/student_profile.md](references/student_profile.md) | 学情问卷全文、字段含义、如何映射到笔记风格 |
| [assets/note_prompt_template.md](assets/note_prompt_template.md) | 笔记生成 subagent 提示词模板（复制填参即用） |
| [assets/review_prompt_template.md](assets/review_prompt_template.md) | 审查 / 修订 / 复审三个 subagent 提示词模板 |
| [assets/pdf_style.css](assets/pdf_style.css) | PDF 排版样式（紧凑 / 标准 / 宽松三档，CSS 变量驱动） |
| [examples/example_run.md](examples/example_run.md) | 完整走查示例：从一句话到 18 份 PDF |
| [SECURITY_AUDIT.md](SECURITY_AUDIT.md) | 安全审计：方法学、修复记录、剩余风险 |

## 🔒 隐私与数据流向（请务必阅读）

> [!IMPORTANT]
> 工作流整体有两条"出本机"的数据通道，使用前请知情：

- **对竹马平台只读**：不提交作答、不交卷、不修改账号数据；串行抓取且默认 150ms 间隔，仅抓取**本人账号**的错题，请遵守平台服务条款。
- **脚本网络出口仅 `zhumavip.com`**：全部 URL 硬编码官方域名，无第三方上报。
- **① AI 模型服务**：阶段 4/5 的 subagent 由 LLM 驱动，错题内容与你填写的学情会作为提示词发送给你所使用的模型服务商。数据仅用于生成笔记。
- **② 云同步盘**：`--desktop` 会把总册 PDF 复制到桌面——若桌面在 OneDrive 同步范围内，该文件会同步到微软云。不需要云备份就别加 `--desktop`。
- **本地敏感数据**：登录态（会话 cookie）只保存在 `<工作目录>/scrape/profile/`。脚本不写出任何凭据文件；请勿分享该目录、勿把它放进云同步或公共位置。清除方式：删除整个工作目录。

## 🛠 故障排查

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

## ⚠️ 已知限制

1. **拿不到"我的错选"**——竹马接口 `userOptions` / `userAnswer` 恒为 `null`，只记录"哪些题错了"，不保存你当时勾了哪个选项。正确答案与官方解析是完整的。
2. **仅覆盖客观题**（客观题一 / 客观题二），主观题错题本结构不同，未适配。
3. **依赖竹马内部接口**，前端改版可能失效；届时按 `references/api_reference.md` 的「接口变动时如何重新发现」处理。
4. **登录态会过期**，过期后重跑 `01_login.js` 重新扫码即可。
5. 总册 PDF 中，各单元内部章节编号彼此独立，会出现编号重起（已用「第 N 部分（续）」缓解）。

## 🧪 质量保障

本仓库经过两轮独立代码审查 + 复审验收（安全审计、逐行代码审查、文档一致性核查），全部发现已修复，过程留痕于 git 历史。核心保证：

- 原子写 + 断点续跑：任何一步中断都能安全重跑，不产生截断数据；
- 失败可见：失败必告警、必影响退出码，不存在静默丢数据的"假绿灯"路径（汇总脚本对零解析结果直接报错）；
- 注入防御：所有渲染路径先转义再拼接；subagent 提示词含防注入条款与写入路径白名单。

详见 [SECURITY_AUDIT.md](SECURITY_AUDIT.md)。

## 📄 免责声明

- 本项目为**个人学习用途的非官方工具**，与竹马法考（zhumavip.com）及其运营方**无任何关联、合作或背书关系**。
- `references/api_reference.md` 中记录的接口信息仅为本人在使用过程中对**自己账号可见数据**所作的技术观察记录，仅供学习交流；接口的最终解释权归平台运营方所有，平台有权随时变更或关闭。
- 使用本工具即表示你理解并同意：**仅限抓取本人账号的错题数据**，遵守平台服务条款与适用法律；因使用不当（如高频抓取、用于商业用途、抓取他人数据）导致的账号限制或任何后果由使用者自行承担。
- 脚本对平台仅做只读访问（不交卷、不动作答记录），并内置限速与退避；如平台方认为本项目侵犯其权益，请提 Issue，我会立即处理（下架相关内容或归档仓库）。

## 📄 许可

[MIT](LICENSE)。欢迎 fork 与改进——若竹马接口变动，请同步更新 `references/api_reference.md`。
