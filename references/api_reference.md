# 竹马内部接口参考

工作流不爬 DOM，而是直接调竹马的内部 JSON 接口。所有接口以 `/java-api` 为前缀，在**已登录页面上下文**内用 `fetch` 调用（自动带 cookie）。

> 实测于 2026-09。前端改版后接口可能变动，见文末「接口变动时如何重新发现」。

## 一、鉴权：必须复用真实请求头

**只带 cookie 不够**，服务端会校验一组请求头。做法：打开错题本页面时监听 `request`，从任意一次 `java-api` 请求里抓下这些头，之后复用：

| Header | 说明 |
|---|---|
| `token` / `mtoken` / `stoken` | 登录凭证（三个值通常相同，长度 256） |
| `appname` | `zhuma` |
| `channel` | `zhumaWeb` —— **缺失会返回 `406 无效的channel`** |
| `clienttype` | `web` |
| `accept-q` | 前端生成的校验串，原样带上即可 |
| `Content-Type` | **必须显式设为 `application/json`** —— 否则 fetch 默认 `text/plain`，服务端报 `Content type 'text/plain;charset=UTF-8' not supported` |
| `ts` | 毫秒时间戳，每次请求刷新为 `Date.now()` |
| `nonce` | 随机串 |

抓头代码模式：

```js
let real = null;
page.on('request', r => {
  if (/java-api/.test(r.url()) && !real && r.headers()['token']) real = r.headers();
});
// 之后构造 H：保留上表字段 + Content-Type=application/json + ts=Date.now()
```

## 二、三个核心接口

### 1. 获取目录树

```
POST /java-api/api/error/question/list/selectCatalogByUserIdV2
```

请求体：

```json
{
  "catId": 267, "kindId": "1", "mineType": "01",
  "pageNum": 1, "pageSize": 200,
  "questionTypeId": "702",
  "depthType": 0, "recursionFlag": false,
  "includeSingleJudgeQuestions": true, "isKnowledgePointsRepeat": true
}
```

| 试卷 | `catId` | `questionTypeId` |
|---|---|---|
| 客观题一 | `267` | `"702"` |
| 客观题二 | `268` | `"703"` |

> 这两个 id 来自 `/api/p3/question/list/questionTypeV2?businessType=104&kindId=1&legalQuestionType=0&mineType=01&parentTypeId=0`。写死通常没问题，若返回空可先查该接口确认。

返回 `data`：`[{ content, count, id, subList: [{ content, count, id }] }]`
- 顶层 = 科目（`content` 科目名，`count` 该科错题数）
- `subList` = 章节

### 2. 获取某章节的题目列表

```
POST /java-api/api/error/question/getQuestionSetFromKnowledgeListV2
```

请求体：

```json
{
  "mineType": "01", "kindId": "1",
  "catalogId": "<章节 id>",
  "questionTypeId": "702",
  "businessTypeId": "104",
  "includeSingleJudgeQuestions": true, "isKnowledgePointsRepeat": true
}
```

⚠️ 参数名是 **`catalogId`**（字符串），不是 `catId`。写错会返回「目录不存在」。

返回 `data` 关键字段：

- `answerErrorId` —— **下一接口的 `answerRecordId`**
- `questions[]` —— 每项 `{ id, kind, question, options, ... }`

### 3. 获取单题详情（答案 + 解析）

```
POST /java-api/api/error/question/getErrorQuestionAnalysisByIdV2
```

请求体：`{ "questionId": <题目 id>, "answerRecordId": <上一接口的 answerErrorId> }`

返回 `data` 的关键字段：

| 字段 | 含义 |
|---|---|
| `question` | 题干 |
| `optionsStr` | 选项 JSON 字符串 `[{id,text}]` |
| `answer` | **正确答案**（可能是对象数组，也可能是 JSON 字符串） |
| `cautionDesc` | **官方解析**（笔记结论的权威依据） |
| `snText` / `questionName` | 来源，如「法考2012年卷二第51题」 |
| `tagName` | 题型（单选题/多选题/不定项） |
| `difficulty` | 难度（1–5） |
| `score` | 分值 |
| `noteValue` | 用户自己写的笔记（可能为空） |
| `videoUrl` | 讲解视频地址 |
| `userOptions` / `userAnswer` | **恒为 null** —— 竹马不保存错选的具体选项 |

**解析 `answer` 的稳妥写法**：

```js
let correct = [];
if (Array.isArray(q.answer) && q.answer.length && typeof q.answer[0] === 'object') {
  correct = q.answer.map(o => o.id);
} else {
  try { const a = JSON.parse(q.answer || '[]'); correct = a.map(o => o.id || o); } catch (e) {}
}
```

## 三、常见错误码

| code | msg | 原因与处理 |
|---|---|---|
| 406 | 无效的channel | 缺 `channel: zhumaWeb` 头 |
| — | `Content type 'text/plain;charset=UTF-8' not supported` | 没显式设 `Content-Type: application/json` |
| 30007 | 登录信息错误 | 缺 `token`/`mtoken`/`stoken`，或登录态过期 → 重跑 `01_login.js` |
| 1 | 目录不存在 | `catalogId` 参数名写错，或章节 id 不属于当前 `questionTypeId` |
| 1 | questionId不能为空, answerRecordId不能为空 | 参数名/值为 null（多半是上一步失败了） |
| 1 | Request method 'GET' not supported | 这些接口只接受 POST |

## 四、已知不可获取的数据

- **"我的错选"** —— `userOptions` / `userAnswer` 恒为 `null`。竹马只记录"哪些题做错了"，不保存当时勾选的选项。这一限制必须在交付时明确告知用户。

## 五、接口变动时如何重新发现

1. 打开错题本或练习页，用 `page.on('response')` 抓取所有 `java-api` 响应，打印 URL 与 `postData`。
2. 从前端 JS 批量提取接口清单：
   ```js
   const scripts = await page.evaluate(() =>
     performance.getEntriesByType('resource').filter(r => r.name.endsWith('.js')).map(r => r.name));
   // 逐个下载，用 /["'`][^"'`]*\/api\/[A-Za-z0-9_\-\/{}.$]{3,80}["'`]/g 提取
   ```
3. 按关键词筛选：`question` / `answer` / `analysis` / `error` / `report`。
4. 新接口的参数形状，用「抓真实请求的 `postData`」确定 —— 比猜可靠。
