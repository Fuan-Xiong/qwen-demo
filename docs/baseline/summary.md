# 基准运行摘要（baseline_001）

> 生成时间：2026-10-27 ｜ 环境：Node v24.14.0 / npm 11.9.0 ｜ 模型：`base-model`（占位 key，registry 链路无真实 LLM 调用）
> 原始数据：`sse.log`（完整 SSE 事件流）/ `metrics.json` / `results.json`（同目录）

## 输入

- **文档 2 份**（真实 fixture）：`testword.docx`（contract_A，143K）、`test1.pdf`（annex_B，1.8MB）
- **规则 3 条**：R001 deterministic「五常线规格存在」（keywords: 五常）、R002 deterministic「履约保函金额」（keywords: 履约保函）、R003 semantic「付款条款语义」

## 事件序列

```
run_started → progress×10（5 阶段 running+done，穿插于执行期前后）
→ result×3（R001 pass / R002 fail / R003 review）
→ warning×1（REVIEW_RESULT R003）
→ metrics → done
```

（sse.log 实测 51 行，无心跳帧——连接在 15s 首心跳前完成；done 后连接正常关闭）

## 规则 results（status / evidence 数量）

| ruleId | ruleName | status | evidence 数 | confidence | reason |
|---|---|---|---|---|---|
| R001 | 五常线规格存在 | **pass** | 0 | 0.9 | 规则 R001 命中关键词上下文 |
| R002 | 履约保函金额 | **fail** | 0 | 0.8 | 未检索到规则 R002 要求的内容 |
| R003 | 付款条款语义 | **review** | 0 | null | 未注入 semantic 比对器 |

> evidence 均为 0：`locateEvidence` 未接入（已知限制，见 docs/test-report.md §5）。

## Coverage 统计

```
{ total: 3, done: 3, review: 0, failed: 0,
  details: { R001: "done", R002: "done", R003: "done" } }
```

（矩阵 cell：执行完成态；判定结果见 results）

## Tokens 明细

```
{ prompt: 0, completion: 0, total: 0, estimated: false }
```

（registry 链路零 LLM 调用，占位 key 跑通）

## 阶段耗时（ms）

| PARSING | RULE_LOADING | PLANNING | EXECUTING | VERIFYING | elapsedMs |
|---|---|---|---|---|---|
| 580 | 0 | 0 | 303 | 1 | 884 |

- metrics.rules：`{ total: 3, pass: 1, fail: 1, review: 1, failed: 0 }` ｜ maxRounds：3

## 复跑参数

| 参数 | 值 | 说明 |
|---|---|---|
| model | base-model | 本次基准占位值；生产用 MODEL_NAME |
| temperature | 0.2 | MODEL_TEMPERATURE |
| maxTokens | 4096 | MODEL_MAX_TOKENS |
| concurrency | 2 | HARNESS_CONCURRENCY / 请求 options.concurrency |
| stepTimeoutMs | 30000 | 请求 options.stepTimeoutMs 默认 |
| maxRetries | 2 | HARNESS_RETRIES |
| maxRounds | 3 | HARNESS_MAX_ROUNDS |

复跑命令（等价）：
```bash
cd agent-server && PORT=3001 QWEN_API_KEY=<key> MODEL_NAME=<model> node src/server.js
curl -N -X POST http://127.0.0.1:3001/api/review -H "Content-Type: application/json" -d @docs/baseline/request.json
```