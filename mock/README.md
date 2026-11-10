# mock/README.md —— 前端不等后端的 Mock 方案

> 目的：前端 F 在 13:50—14:10 就能把页面跑通，B1 的真实 SSE 一上线只换 BASE，不改代码。

## 方式一：本地假服务（推荐，协议 100% 真实）

```bash
node mock/sse-server.mjs          # 默认 8787，可用 PORT=9000 改
# 加速回放：MOCK_STEP_MS=100 node mock/sse-server.mjs
```

| 接口 | 说明 |
|---|---|
| `POST /api/review` | 返回真实 SSE 流，事件顺序与 `docs/sse-events.md` 完全一致 |
| `POST /api/upload` | 假上传，返回 `{docId, docName, pageCount}` |
| `GET /healthz` | 健康检查，`{"ok":true,"mode":"mock"}` |

前端配置：

```js
const BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8787'
```

真实后端好了，只把 `VITE_API_BASE` 换成 `http://localhost:8080`（或 B1 的端口），**代码零改动**。

自测整条流（不写前端也能验）：

```bash
curl -N -X POST http://localhost:8787/api/review \
  -H 'Content-Type: application/json' \
  -d '{"docIds":["doc-001"]}'
```

## 方式二：纯内存 Mock（最轻，无服务）

```js
import { mockRun } from '@/mock/mock-sse.mjs'

const ac = new AbortController()
await mockRun(
  { docIds: ['doc-001'] },
  { onEvent: (event, data) => handleEvent(event, data), signal: ac.signal },
)
```

- 与 `runReview` 同签名 `(body, { onEvent, signal })`，把 import 一行切回来就是真实接口。
- 支持 `signal`：点中断按钮 → `ac.abort()` → 收到 `error{code:"aborted"}`，和真实服务行为一致。

## 回放数据

`fixtures/review-sample.json` 是一份完整 `result.schema.json` 实例，包含：

- 2 条 `fail`（R001 报价有效期、R002 预付款比例，都有 blockId 证据）
- 1 条 `review`（R005 违约条款，语义含糊、低置信度）
- 5 条 `pass` + 1 条 `pending`（R008 未覆盖 → 覆盖矩阵告警）

正好覆盖前端三种卡片的渲染状态和"未覆盖告警"红色状态，**路演演示数据直接用它**。

## 契约校验（改 Mock 后必跑）

```bash
node mock/validate.mjs
```

校验：必填字段齐全、`fail` 必须带证据、ruleId 格式 `R\d{3}`、coverage 计数自洽、summary 计数与 issues 一致。CI 化与否随意，封版前跑一次。
