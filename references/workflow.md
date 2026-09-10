# 端到端流程详解、环境约定与踩坑清单

## 一、为什么走接口而不是爬页面

点击章节会跳转到做题页 `/w/doErrorExercises?...`，该页面**初始只显示题干与选项**，答案与解析要"交卷"后才出。而交卷会**写入用户的作答记录**，有动到错题本数据的风险 —— 不能碰。

接口路线完全只读，且一次返回全部内容（题干 + 选项 + 正确答案 + 官方解析 + 来源），1661 道题约 9 分钟抓完。

## 二、环境约定与避坑

### 1. 用本机 Chrome，不要下载 Chromium

`agent-browser install` 从 `storage.googleapis.com` 下载 Chrome for Testing（约 196MB），国内极易超时（实测下到 30% 断流）。

改为指定本机 Chrome：

```js
chromium.launchPersistentContext(profileDir, { executablePath: '<本机 chrome.exe>' })
```

若必须走 agent-browser，用环境变量 `AGENT_BROWSER_EXECUTABLE_PATH` 指向本机 Chrome 即可跳过下载。

### 2. 固定 userDataDir，避免登录态丢失

无头浏览器工具默认每次用**临时 profile**，进程重启后 cookie 全没，长任务中途掉线会前功尽弃。`--session-name` 之类机制未必真正落盘（实测失效）。

因此登录与抓取都用**同一个固定目录** `<工作目录>/scrape/profile`。

### 3. Node 版本目录会被轮换

托管 Node 位于 `~/.workbuddy/binaries/node/versions/<版本>/`，版本号会变（实测 `22.22.2-2` 被移除、换成 `22.22.2-3`），导致脚本突然报 `command not found (127)`。

**不要在命令里硬编码版本**，或先探测存在性再执行。

### 4. bash 外部命令可能整体失效

曾出现 `ls` / `rm` / `dirname` 全部 `command not found`（shell 引导脚本报 `dirname: command not found` + `cd: null directory`），此时：

- `rm` 走的是 `safe-bin/rm` 包装脚本，同样失效；
- **改用绝对路径调用 node**，文件操作交给 Node 的 `fs`（最稳），或改用 PowerShell。

### 5. PowerShell 输出捕获可能为空

命令确实执行了，但 stdout 读不到、exit code 也可能是 1。因此**验证类操作一律让脚本把结果写进文件，再用 Read 工具读**。

### 6. 桌面目录在 OneDrive 下

不要假设 `~/Desktop`。用 `[Environment]::GetFolderPath('Desktop')` 取值；实测常见为 `C:\Users\<用户>\OneDrive\桌面`。

### 7. 不要用 `| tail` 读长跑脚本输出

管道会缓冲，进程不结束就什么都看不到。重定向到文件再读。

## 三、登录环节的关键细节

- 登录页 `https://www.zhumavip.com/w/qrlogin` **默认显示手机号登录**，需要点右上角图标切到扫码模式。
- 那个图标是 `<img>`，但 onclick 是**通过 JS 属性绑定**的，不是 HTML 属性 —— **CSS 选择器 `img[onclick]` 匹配不到**，必须用属性过滤：
  ```js
  const cands = [...document.querySelectorAll('img')].filter(i => i.onclick);
  ```
- 二维码是 `data:image/png;base64,...`（约 212×212），取出后解码存成 PNG 发给用户扫。
- 扫码方是**竹马 APP**，不是微信。
- 二维码有效期短（通常几分钟），若用户没及时扫，重新跑一次 `01_login.js` 生成新码即可。
- 检测登录成功：URL 不再包含 `qrlogin`，或页面文本出现「退出」。

## 四、抓取环节的关键细节

- 接口参数与鉴权头见 `references/api_reference.md`。
- **逐题加延迟**（默认 150ms），避免触发限流。
- **每 20 题落盘**，支持断点续跑；`questions.json` 以题目 id 为 key，重跑自动跳过。
- 章节题数与 `questions.json` 唯一 id 数可能略有出入（存在跨章节重复题，被 id 去重），这是正常的，交付时按唯一题数统计。
- 若中途出现「登录信息错误」，说明登录态过期 —— 重跑 `01_login.js`，然后直接重跑 `02_scrape.js`（已抓部分会保留）。

## 五、笔记生成环节的关键细节

- **必须扇出 subagent**，每批 7–8 个并行。串行自己写会非常慢且耗主上下文。
- 让 subagent 自己读单元文件，**不要把题目塞进 prompt**。
- 明确要求「只回复一行」，否则大量结果会撑爆上下文。
- 遇到 429 限流：记录重置时间，可先手写 1–2 个小科目当样板，重置后继续。

## 六、审查环节的关键细节

- **审查员绝对不能改文件**，只出报告；修订统一由修订员做。这是为了避免多人并发写同一文件产生冲突、以及"顺手重写"引入未审查内容。
- D2 维度（答案一致性）要求 reviewer **回读原始 JSON** 逐题比对，只看笔记无法判断。
- 大科目的 D6（跨单元衔接）必须单独派，因为它需要同时看多个 part。
- 修订员只能改报告点到的问题，并在文件末尾追加 HTML 注释形式的修订记录（渲染器会忽略注释）。

## 七、PDF 渲染环节的关键细节

- 用 Chrome 的 `page.pdf()`，中文自动可用（Microsoft YaHei 等系统字体），无需额外装字体。
- 开 `outline: true, tagged: true` 生成 PDF 书签，总册里能按「科目 → 知识点」跳转。
- **合并多 part 时把所有标题降一级**，否则同科目会出现多个重复的一级标题、书签层级错乱。
- 第 2 部分起插入「第 N 部分（续）」分隔标题。
- 表格加 `page-break-inside: avoid`，避免跨页断开。
- 排版密度由 CSS 变量控制，改 `study_profile.json` 的 `layout` 即可切换，不必改样式文件。

## 八、典型规模参考

一次完整运行（客观题一 + 客观题二）的实测数据：

| 指标 | 数值 |
|---|---|
| 科目数 | 18（客观题一 9 + 客观题二 9） |
| 有题章节 | 180 |
| 唯一错题数 | 1655 |
| 处理单元（≤55 题） | 41 |
| 抓取耗时 | 约 9 分钟 |
| 笔记生成 subagent | 39 个（5 批并行） |
| 单科 PDF | 18 份，合计约 8.3MB |
| 总册 | 129 页，约 4.2MB |
