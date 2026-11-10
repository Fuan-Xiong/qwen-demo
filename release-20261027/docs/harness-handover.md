# harness-handover.md —— agent-server 交接文档（封版 v1）

> 交接方：B1（Agent Harness + SSE）｜交接日期：2026-10-24 ｜ 状态：封版检查通过（108/108 测试 + 端到端 curl 验证）
> 位置：`agent-server/`（与旧 `src/harness/` 并行；技能侧见 `docs/parse-document-handover.md`）

## 1. 模块用途

评审编排器 + HTTP(SSE) 服务：接收一份评审请求（docIds/ruleSetId/options），沿
状态机 **INIT → PARSING → RULE_LOADING → PLANNING → EXECUTING → VERIFYING → DONE/FAILED**
编排各业务阶段，实时推送 SSE 事件；支持 Abort（用户取消/前端断开/超时）后 3 秒内停止调度；
单规则失败/超时只标记矩阵（review/failed）不终止整体。**只编排，不实现业务规则**（能力经 deps 注入）。

## 2. 导出签名

| 模块 | 导出 |
|---|---|
| `src/config/env.js` | `loadEnv(env?) → {config, snapshot}`；模块级 `config`（深冻结）、`snapshot()`；`ConfigError` |
| `src/server.js` | `createApp()`（http.Server，测试用 listen(0)）；直接运行（`node src/server.js`）监听 `config.server` |
| `src/sse.js` | `createSSE(res, {keepaliveMs, events}?) → {send, close, closed}`；`SSE_EVENTS` |
| `src/harness.js` | `runReview(req, sse, signal, deps?) → {ok, runId, aborted, summary?, coverage?, metrics?, error?}` |
| `src/state/abort.js` | `createAbortController({signal, timeoutMs}) → {signal, aborted(), timedOut(), abort(), cleanup()}` |
| `src/state/runState.js` | `createRunState(req)`、`stage(run, name, fn)`、`STAGES/PHASE_STAGES`、`abortStageError()` |
| `src/sdk/client.js` | `chat({messages, tools, stream, signal, onDelta, timeoutMs}) → {text, usage, finishReason, raw}` |
| `src/sdk/errors.js` | `SdkError`、`httpErrorToSdkError`、`normalizeSdkError`、`SDK_ERROR_CODES` |
| `src/sdk/tokenCounter.js` | `countTokens({usage, text, model}) → {input, output, total, estimated}` |
| `src/agents/planner.js` | `planRules(rules, {useLlmPlan, deps}) → {tasks, groups, order}` |
| `src/agents/executor.js` | `executeTasks({tasks, concurrency, taskTimeoutMs, maxAttempts, signal, sse, deps}) → {results, matrix}` |
| `src/agents/verifier.js` | `verifyCoverage({results, matrix, sse, runId, deps}) → {results, coverage, matrix}`；`defaultVerifyCoverage` |
| `src/metrics/metrics.js` | `createMetrics()`（addTokens/addLlmCall/addStage/addRuleResult/addSkill/elapsedMs/snapshot） |
| `src/metrics/logger.js` | `createLogger({stream})`（一行一条 JSON，key 脱敏）；`logger`（stderr 默认实例）；`redact` |
| `src/utils/timeout.js` | `withTimeout(promise, ms, label)`（超时抛 `SkillError("TIMEOUT")`）；`SkillError` |
| `src/utils/retry.js` | `callWithRetry(fn, {retries, baseDelayMs, maxAttempts, onRetry})`；`isRetryable` |

## 3. 事件协议（agent-server 实际实现）

端点：`POST /api/review`（JSON body → SSE）；`POST /api/review/abort`（`{runId}`）→ 202/400/404。

| event | 时机 | data 关键字段 |
|---|---|---|
| `run_started` | 首帧 | `{runId, stages[]}` |
| `progress` | 每阶段进入/结束 | `{runId, stage, status: running\|done, durationMs?}` |
| `message` | 执行期模型流式消息（业务层转发） | 业务定义（`{role, content}` 等） |
| `result` | 每条规则 1 次（executor） | `{ruleId, ruleName, status, severity, evidence[], confidence, reason}` |
| `metrics` | 结束前 | `{tokens{prompt,completion,total,estimated}, stages{}, rules{pass,fail,review,failed}, llmCalls, skills{}, elapsedMs, runId, maxRounds}` |
| `warning` | 规则超时/失败/需复核/空规则集 | `{code, ruleId?, message}` |
| `error` | 失败/中止（终态，不发 done） | `{runId, code, message, retryable, stage, aborted?}` |
| `done` | 正常结束（末帧） | `{runId, summary, coverage, metrics}` |

阶段名：`PARSING / RULE_LOADING / PLANNING / EXECUTING / VERIFYING`。
错误码：`RATE_LIMIT / TIMEOUT / AUTH / BAD_REQUEST / SERVER_ERROR / CONTENT_FILTER / ABORT`。

> **协议对齐状态**：与 `docs/sse-events.md`（队长契约 v1.0）在**传输层与请求体一致**（text/event-stream、单行 JSON、禁 gzip、`req close→abort`、`{docIds, ruleSetId, options}`），但**事件命名/字段/枚举存在差异**（见第 6 节风险 #1）。封版未擅自改动任一侧。

## 4. 环境变量（`.env.example`）

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `QWEN_API_KEY` / `MODEL_NAME` | 是 | — | 缺失 → 启动失败（fail fast） |
| `QWEN_BASE_URL` | 否 | ''（默认 OpenAI 端点） | SDK 网关 |
| `HOST` / `PORT` | 否 | 127.0.0.1 / 4170 | 监听（与 B1 8080 隔离） |
| `MODEL_TEMPERATURE` / `MODEL_MAX_TOKENS` | 否 | 0.2 / 4096 | 模型参数 |
| `HARNESS_TIMEOUT_MS` / `HARNESS_RETRIES` | 否 | 90000 / 2 | 外部调用超时/重试 |
| `HARNESS_CONCURRENCY` / `HARNESS_MAX_ROUNDS` | 否 | 2 / 3 | 执行并发 / 全局轮次（MAX_ROUNDS）上限 |
| `SSE_KEEPALIVE_MS` | 否 | 15000 | 心跳 |
| `LOG_LEVEL` / `WORKSPACE_DIR` | 否 | info / ./.agent-runs | 日志级别 / 工作目录 |

启动会打印 `snapshot()`（可 JSON 序列化复跑参数，apiKey 只输出 hasApiKey）。

## 5. 前端集成方式

```js
// 基础型：转发式（确认接收）
const res = await fetch(`${BASE}/api/review`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ docIds: ['doc-001'], ruleSetId: 'default', options: { maxRounds: 3 } }),
  signal, // AbortController.signal：前端取消
})
const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
// 逐帧解析 "event: <name>\ndata: <JSON>\n\n"，详见 docs/sse-events.md 第 5 节范式
// 推荐渲染映射：run_started→初始化；progress→进度条（stage/status）；result→规则卡片；
// metrics→Token/耗时面板；warning→黄色提示；done→完成页（summary/coverage/metrics）；
// error→错误页（code retryable 决定是否显示"重试"）
```

- **中止**：前端 `AbortController.abort()` 或调用 `POST /api/review/abort {runId}`（runId 来自 `run_started`），服务端 3 秒内停止调度并补发 `error{code:"ABORT"}`。
- **健康检查**：`GET /health` → 200 `{status:"ok", service:"agent-server"}`。

## 6. 已知限制 / 剩余风险

1. **事件协议与 `docs/sse-events.md` v1.0 不一致**：事件名（run_started/warning vs meta/rule_result）、错误码枚举、阶段枚举、metrics 字段名均有差异；需队长/前端拍板统一方向（agent-server 对齐契约 or 契约升级 v1.1），封版未擅改。
2. **`/api/review` 当前为"空跑骨架"**：PARSING/RULE_LOADING 用 defaultDeps（空解析 + 空规则 + NO_RULES 告警）跑通状态机；真实解析/规则引擎需接 `skills/registry`（parse-document 技能已就绪，见 `docs/parse-document-handover.md`）。
3. **超时重试的落点**：`chat` 的超时/取消（AbortError）不重试（同 controller 已 abort，重试无意义）；可重试的 HTTP 错误（429/5xx）走 `callWithRetry` 指数退避（0.7–1.3 jitter）。
4. **llmCalls/skills 计数**：harness 已内置 metrics 聚合，但 `llmCalls`/`skills` 目前仅当业务 deps 显式回报时非零（registry 接入后启用）。

## 7. 测试

```bash
cd agent-server && node --test      # agent-server 全量（68 用例）
npm test                            # 根目录全量（108 用例，含 B2 技能）
```