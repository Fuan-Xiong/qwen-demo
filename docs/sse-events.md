# sse-events.md —— SSE 事件协议（契约文件，队长唯一 Owner）

> 状态：v1.0 ｜ 14:10 前必须发群
> **B1 按此发，F 按此解，谁都不许私自加字段。** 要加字段先在这里改，再通知另一方。

## 1. 传输约定

- 端点：`POST {BASE}/api/review`，`Content-Type: application/json`（**不用 EventSource**，因为要上传文档、要 Abort）。
- 响应：`Content-Type: text/event-stream; charset=utf-8`，`Cache-Control: no-cache`，`X-Accel-Buffering: no`。
- 帧格式严格 SSE：
  ```
  event: <type>
  data: <JSON 单行>

  ```
  （`data` 必须单行 JSON，不得跨行；每条事件后空一行）
- 编码 UTF-8；**禁止 gzip 压缩**（否则流式失效）。
- 中断：前端 `AbortController.abort()` → 服务端监听 `req.on('close')`，停掉 harness，尽量补发一条 `error{code:"aborted"}` 后关闭。

## 2. 请求体

```json
{
  "docIds": ["doc-001", "doc-002"],
  "ruleSetId": "default",
  "options": {
    "maxRounds": 3,
    "timeoutMs": 90000,
    "retry": 1
  }
}
```

- `docIds`：已在 `/api/upload` 上传的文档 id（多文档必填顺序按数组）。
- `ruleSetId`：规则集（默认 `default`，对应 `rules清单.md`）。
- `options` 全部可选，服务端有默认值；前端只透传，不解析含义。

## 3. 事件类型总表

| # | event | 必现 | 频率 | 用途 |
|---|---|---|---|---|
| 1 | `meta` | 是 | 1 次，首帧 | 回传 reviewId、文档列表、规则总数 |
| 2 | `progress` | 是 | 每步 | 进度条 + 阶段文案 |
| 3 | `message` | 是 | 多次 | 聊天框流式文本（含 thinking 片段） |
| 4 | `rule_result` | 是 | 每条规则 1 次 | 单条规则结论（前端增量渲染卡片） |
| 5 | `metrics` | 否 | 0—多次 | 实时 Token/耗时（前端面板） |
| 6 | `result` | 是 | 1 次，末帧前 | 完整 `result.schema.json` 对象 |
| 7 | `done` | 是 | 1 次，最后 | 正常结束 |
| 8 | `error` | 否 | 0—1 次 | 异常/中断，发出后即关闭 |

顺序硬约束：`meta` → (`progress`|`message`|`rule_result`|`metrics`)\* → `result` → `done`。
发生错误时：任意位置插入 `error` → 直接关闭，**不发 `result`/`done`**（`aborted` 除外，见第 4.8 节）。

## 4. 事件定义

### 4.1 meta

```json
{ "reviewId": "rv-20261023-001", "documents": [{"docId":"doc-001","docName":"合同.pdf","pageCount":12}], "ruleTotal": 8, "ruleSetId": "default", "startedAt": 1761200000000 }
```

### 4.2 progress

```json
{ "stage": "parse", "stageLabel": "解析文档", "percent": 15, "detail": "doc-001 已切 128 个 block" }
```

- `stage` 枚举：`parse` | `rules` | `plan` | `execute` | `verify` | `report`（与 metrics.stages 一致）。
- `percent`：0—100 整数，只增不减；前端进度条直接用。

### 4.3 message

```json
{ "role": "assistant", "channel": "text", "delta": "正在核对报价有效期……", "ruleId": null }
```

- `channel`：`text` | `thinking`（thinking 前端置灰小字，不污染正式回复）。
- `delta`：**增量**片段，前端 append，不要整段重发。
- 可选 `ruleId`：该片段属于某条规则时带上，前端可高亮对应卡片。

### 4.4 rule_result

```json
{
  "ruleId": "R001", "verdict": "fail", "severity": "high", "method": "deterministic",
  "reason": "报价有效期 60 天，低于要求的 90 天", "suggestion": "将有效期调整为不少于 90 天",
  "confidence": 0.98,
  "evidence": [{"docId":"doc-001","docName":"合同.pdf","page":3,"blockId":"p-000042","charStart":18,"charEnd":30,"snippet":"报价有效期：60 天"}]
}
```

- 字段与 `result.schema.json` 的 `issues[].*` 完全一致（去掉 title 也行，但要保持同名）。
- 一条规则一次；同一 `ruleId` 重复发送 = 覆盖（用于重试后更正）。

### 4.5 metrics

```json
{ "tokenIn": 3200, "tokenOut": 850, "tokenTotal": 4050, "durationMs": 12000, "llmCalls": 3, "deterministicCalls": 5 }
```

- 可多次发送，前端做覆盖而非累加。

### 4.6 result

```json
{ "payload": { "...": "完整 result.schema.json 对象" } }
```

- 装一层 `payload` 是为了不和事件外壳字段冲突。前端收到后整体替换状态。

### 4.7 done

```json
{ "reviewId": "rv-20261023-001", "status": "done", "durationMs": 21300 }
```

### 4.8 error

```json
{ "code": "llm_timeout", "message": "执行阶段第 2 轮超时", "retryable": true, "stage": "execute" }
```

- `code` 枚举：`bad_request` | `parse_failed` | `llm_timeout` | `llm_error` | `max_rounds` | `internal` | `aborted`。
- `retryable=true` 时前端显示"重试"按钮。
- `aborted`（用户主动中断）：可先发已有的 partial `result`（`status:"aborted"`），再发 `error{code:"aborted"}`，让前端能保留已展示内容。

## 5. 前端解析示例（useSSE.js 参考实现）

```js
export async function runReview(body, { onEvent, signal }) {
  const res = await fetch(`${BASE}/api/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += value
    let idx
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx); buf = buf.slice(idx + 2)
      let event = 'message', data = ''
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data += line.slice(5).trim()
      }
      if (!data) continue
      onEvent(event, JSON.parse(data))
    }
  }
}
```

## 6. Mock SSE（前端不等后端的唯一办法）

`mock/` 目录提供两种方式，见 `mock/README.md`：
1. `node mock/sse-server.mjs` 起本地假服务，前端把 `BASE` 改成 `http://localhost:8787` 即可，**协议与真实完全一致**。
2. 前端直接 `import { mockRun } from './mock/mock-sse.mjs'`，同参数、同回调，零网络。

按时间轴回放 `mock/fixtures/review-sample.json`，每 300ms 推一条，包含一条 fail、一条 review、一条 pass，正好覆盖三种渲染状态。
