# qa-cheatsheet.md —— 路演答辩问答速查

> 用途：路演/答辩备用，答案 ≤3 行，附数据或代码位置。生成 2026-10-27（封版 v1.0.0 后）。

---

## Q1. 为什么用多 SubAgent（规划/执行/校验）？

**答**：按职责拆成三个可独立注入的 Agent —— Planner 只产出固定任务集、Executor 只并发执行并更新矩阵、Verifier 只做覆盖度收尾，任一环节可替换实现而不动编排，符合"编排与业务分离"。

**位置**：`agent-server/src/agents/{planner,executor,verifier}.js`，由 `agent-server/src/harness.js` 编排。

---

## Q2. 怎么防死循环？

**答**：三层兜底 —— 全局 `MAX_ROUNDS`（HARNESS_MAX_ROUNDS=3，runReview 级封顶）；单规则 `attempts` 超限即标 failed 并发 `MAX_ATTEMPTS` warning；Planner 任务集固定生成（无迭代重规划），杜绝自举循环。

**数据**：单测「attempts 超限 → failed」通过（`agent-server/test/agents.test.js`）；实测 `maxRounds:3` 写入每次 metrics。

---

## Q3. 怎么省 Token？

**答**：确定性规则全部代码化（关键词检索 + 命中判定，零 LLM）；semantic/cross_doc 才走比对器；文档批量并发解析，规则任务并发执行；结果缓存（parse cacheHit 设计）。

**数据**：基准运行 tokens = `{prompt:0, completion:0, total:0}`（registry 链路无模型调用，`docs/baseline/metrics.json`）。

---

## Q4. 怎么保证复跑一致？

**答**：模型/温度/超时/并发/轮次全部环境变量化（`MODEL_TEMPERATURE`、`HARNESS_*` 等），启动即打印"复跑参数"JSON 到日志；一次性日志一行一条 JSON（runId/stage/ruleId/elapsedMs/tokens，密钥脱敏）。

**位置**：`agent-server/src/config/env.js`（`loadEnv→snapshot`）+ `src/metrics/logger.js`；启动日志实测输出完整复跑参数。

---

## Q5. 溯源怎么精准？

**答**：每个 Block 携带 `blockId`（md5(docId:序号:标题:文本)）+ 全文偏移 `charStart/charEnd` + PDF 的页/`bbox`；前端 TraceViewer 按区块相对偏移切 before/highlight/after 三段 `<mark>` 高亮并 scrollIntoView 定位。

**位置**：`skills/parse-document/utils/block.js`（finalizeBlocks）；`frontend-vue3/src/components/TraceViewer.vue`（watch activeEvidence 高亮）。

---

## Q6. 规则覆盖怎么保证？

**答**：`initCoverageMatrix` 启动即给每条规则铺 pending 单元格 → Executor 逐条更新 done/review/failed → Verifier 统计 `{total, done, review, failed, details}`（空规则 total=0 不落 null）；review 单元格同时发 `REVIEW_RESULT` warning 便于人工追踪。

**数据**：基准 coverage `{total:3, done:3, review:0, failed:0, details:{R001..R003:done}}`（`docs/baseline/metrics.json`）。

---

## Q7. abort 怎么实现？

**答**：server 持 `activeRuns: Map<runId, AbortController>`；`POST /api/review/abort {runId}` 取出 controller 触发 abort，signal 贯穿 runReview，下一阶段入口检查即抛 `ABORTED`；finally 清理 Map 并打印"剩余 0"防泄漏。

**数据**：实测 abort → 202 + SSE `error {code:"ABORTED", stage:"EXECUTING"}`（3 秒内）；Map 清理日志 `剩余 0`（`agent-server/src/server.js`）。

---

## Q8. 单规则失败怎么办？

**答**：Executor 的失败/超时只落在矩阵单元格内（标 failed/review + `RULE_FAILED`/`RULE_TIMEOUT` warning），不向编排层抛出，worker 池继续执行其余任务；最终 Verifier 兜底统计覆盖度。

**数据**：单测「R2 崩溃后 R1/R3 照常 done、results 仍 3 条」通过（`agent-server/test/agents.test.js`）。

---

## Q9. 多文档怎么处理？

**答**：解析按 `maxConcurrency=2` 分批并发（顺序稳定）；所有文档 blocks 合并进统一 `blockIndex`，`blockId` 全局唯一（含 docId）；`cross_doc` 规则走语义比对支持跨文档证据核查。

**数据**：基准两文档（docx+PDF）PARSING 580ms 一次完成（`docs/baseline/summary.md`）。

---

## Q10. 创新点是什么？

**答**：① 覆盖矩阵（total/done/review/failed + 逐规则 details，空规则也非 null）；② 确定性规则引擎（关键词检索+判定，Token 零开销）；③ Token 压缩（计算回归代码化、仅语义判走比对）；④ 全链路可观测 metrics（tokens/stages/rules/elapsedMs/llmCalls 快照 JSON）。

**位置**：`skills/registry.js`（矩阵+确定性技能）+ `agent-server/src/metrics/metrics.js`（snapshot）。