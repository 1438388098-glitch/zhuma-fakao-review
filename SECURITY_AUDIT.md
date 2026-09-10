# 安全审计报告

- **审计对象**：`zhuma-fakao-review`（竹马法考错题复习助手）
- **审计时间**：2026-09-10
- **审计范围**：`SKILL.md`、`README.md`、`scripts/`（6 个 JS）、`references/`、`assets/`、`examples/`
- **审计方法**：关键词扫描（命令执行 / 隐蔽执行 / 网络请求 / 敏感路径 / 凭证 / 文件操作 / 权限提升 / 依赖安装）+ 语义判定（是否构成"下载+执行""读取敏感信息+外发"等危险组合）

## 执行摘要

| 等级 | 数量 | 结论 |
|---|---|---|
| 🔴 P0 阻断级 | **0** | 无 |
| ⚠️ P1 需关注 | **1** | 已说明并给出建议 |
| **安全评分** | **95 / 100** | ✅ 可安全使用 |

## 🔴 P0 阻断级风险

✅ **未发现**。

具体核查结果：

- **无"下载 + 执行"**：全仓库不含 `curl` / `wget` / `bash` / `eval(` / `exec(` / `child_process` / `subprocess` / `os.system` / `popen`。不存在远程脚本下载后执行的行为。
- **无"读取敏感信息 + 外发"**：不含 `~/.ssh`、`/etc/passwd`、`.env`、`credentials`（仅 `fetch` 的 `credentials:'include'` 选项）、`private_key`、`password` 等敏感路径或凭证读取。
- **无破坏性命令**：不含 `rm -rf`、`sudo`、`chmod`、`chown`。
- **无隐蔽执行**：不含 `2>/dev/null`、`nohup`、`--silent`、`-q` 等屏蔽输出的写法。
- **无权限提升**：不涉及 `sudo` / `root`。

## ⚠️ P1 需关注

**1. 脚本会清空自身生成目录**

- **位置**：`scripts/03_build_units.js:71`
- **代码**：`for (const f of fs.readdirSync(UNITS)) fs.unlinkSync(path.join(UNITS, f));`
- **说明**：重跑切分时会清空 `<工作目录>/scrape/units/`，防止旧单元残留污染。
- **风险评估**：路径由 `UNITS = <work>/scrape/units` 硬约束，**不接触工作目录以外的任何位置**，不含通配符，不构成破坏性删除。
- **建议**：若希望更保守，可改为把旧单元移动到一个 `units_bak_<时间戳>/` 目录而非删除。

## 详细检查结果

### 命令执行

- 关键词：`curl` / `wget` / `eval(` / `exec(` / `child_process` / `spawn` / `os.system` / `subprocess` / `sudo` / `chmod`
- **命中：0 次**

### 网络请求

| 目标 | 用途 | 判定 |
|---|---|---|
| `https://www.zhumavip.com/w/qrlogin` | 扫码登录 | 技能目标站点本身 |
| `https://www.zhumavip.com/w/my/errorbooks?...` | 错题本入口 | 同上 |
| `/java-api/api/...` | 抓取题目（同源相对路径） | 同上 |
| `file:///` | 本地 HTML → PDF 渲染 | 本地，无外发 |
| `storage.googleapis.com` | 仅出现在 `references/workflow.md` 的**说明**中（说明"不要从该地址下载 Chromium"），无任何代码请求 | 无害 |

- **外发目标仅限 `www.zhumavip.com`** —— 即用户本人的账号所在站点。
- 未发现动态拼接的第三方 URL；未发现可疑 Base64 编码串。

### 敏感路径与凭证

- `process.env.USERPROFILE` / `LOCALAPPDATA`：仅用于**定位 Chrome 可执行文件与桌面目录**（`scripts/lib/env.js:18–41`），不读取这些目录下的任何数据文件。
- **无硬编码密钥 / Token**：登录凭证来自用户在浏览器中的扫码登录，保存在本地 profile 中，脚本不写入、不打印、不外发。
- `credentials: 'include'`（`02_scrape.js:76`）是 fetch 的**同源 Cookie 携带选项**，用于维持已登录会话，非凭证泄露。

### 文件操作

- 读取：笔记 Markdown、单元 JSON、审查报告 —— 均位于 `<工作目录>/scrape/` 内。
- 写入：题目 JSON、笔记、HTML、PDF —— 均位于 `<工作目录>/` 内。
- 删除：仅 `03_build_units.js:71` 一处，范围限定为 `scrape/units/`。
- **不写入系统目录、用户主目录或工作目录之外的任何位置**（`--desktop` 参数需显式传入，且只复制总册 PDF 一个文件）。

### 依赖安装

- 仅 `playwright-core` 一个依赖。
- 文档给出的安装方式为 **`npm install playwright-core --prefix <隔离目录>`**（README、SKILL.md），**非 `npm install -g`**，并配套 `NODE_PATH` 说明 —— 属于隔离安装，不构成全局环境污染。
- 未指定非官方 registry。
- 全仓库未出现 `pip install`。

### 元数据

- `name`：`zhuma-fakao-review` —— 合法 kebab-case，无特殊字符。
- `description`：约 230 字中文，无重复字符刷屏、未超 500 字符上限。
- `agent_created: true` 已声明。

### 描述与实际行为一致性

`description` 声明为"引导扫码登录 → 抓取错题本 → 对齐学情 → subagent 生成笔记 → 渲染 PDF"。核对实际流程（阶段 0–7）与脚本实现，**完全一致**，无隐藏行为：

- 未发现除抓取错题之外的任何数据收集；
- 未发现任何外发用户数据的通道；
- 全流程**只读**（不交卷、不提交作答、不修改账号数据），这一点在 `references/workflow.md` 中也作为设计原则写明。

## 总体建议

1. 保持依赖隔离安装（`--prefix`），勿改为 `-g`。
2. 若对删除动作介意，按 P1 建议改为备份式清理。
3. 分发 zip 前确认不含 `scrape/profile/`（登录态）等本地产物 —— 当前打包内容仅含文档与脚本，已符合。

## 审计结论

**风险等级：P2（安全）**，附带 1 项 P1 提示（已说明）。

**使用建议：✅ 可以安全使用。**

- 无供应链投毒风险；
- 无自动执行的危险操作组合；
- 唯一的外部交互是访问用户本人的竹马账号，且为只读抓取。
