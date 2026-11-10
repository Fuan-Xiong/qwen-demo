# test-report.md —— 整体回归测试报告（真实链路接入后）

> 测试执行：2026-10-27 ｜ 回归方式：CLI 逐层执行（脚本缺失处用等效命令替代，见 §5）
> 环境：Node v24.14.0 / npm 11.9.0 / macOS ｜ 模型：`test-model`（测试 key，无真实 LLM 调用，llmCalls=0）
> 本期变更：skills/registry 接入（阶段 1 PARSING+RULE_LOADING / 阶段 2 EXECUTING / 阶段 3 VERIFYING）+ abort 链路修复（runId 透传 / ABORTED / RUN_NOT_FOUND）
> 原则：不改解析 skill、不改前端组件、不改 SSE 事件协议与 Result/Evidence 字段；后台服务测试结束即 kill 释放 3001/5173

## 1. 各层 PASS/FAIL 表

| 层 | 命令 | 结果 | 判定 |
|---|---|---|---|
| 环境 | 目录/fixture/依赖/端口检查 | 三目录齐、fixtures 2 个、3001/5173 可用 | ✅ PASS |
| 单测（后端+解析） | `node --test`（= agent-server `npm test` 实际入口） | tests 108 / pass 108 / fail 0 / duration 2423ms / exit=0 | ✅ PASS |
| 解析 skill | 24 用例（含于 108）+ `scripts/verify-test1-pdf.mjs`（8 checks PASS） | 全过 | ✅ PASS |
| 契约 | `npm run validate` | `✅ 契约校验通过：3 条问题、覆盖 6/8、Token 7600` | ✅ PASS |
| 异常层 | 5 项 curl 实测（真实解析/规则链路） | **5 项全 PASS**（见 §2） | ✅ PASS |
| e2e（HTTP/SSE） | curl `POST /api/review` 全链路（`scripts/e2e-*.mjs` 不存在，等效 curl） | 事件序列完整逐帧到达、done 携 coverage/metrics（见 §3） | ✅ PASS |
| 前端 build | `cd frontend-vue3 && npm run build` | 664 modules / built 1.82s / exit=0（chunk 689KB 警告非阻塞） | ✅ PASS |
| 前端静态检查 | grep EventSource / TODO / console.log | 无 EventSource、无 TODO/FIXME、console.log 1 条 | ✅ PASS |

**汇总：PASS 8 层 / FAIL 0 层**（异常层 5 项全部 PASS）

## 2. 异常层 5 项实际结果（真实链路）

| # | 场景 | 实测 code | 判定 |
|---|---|---|---|
| 1 | txt 文件 | `error.code=UNSUPPORTED_FORMAT`（`UNSUPPORTED_FORMAT：暂不支持的格式：.txt（仅 .docx/.pdf）`） | ✅ PASS |
| 2 | 不存在路径 | `error.code=READ_FAILED`（`READ_FAILED：ENOENT…`）——技能对不存在文件的**原码**（parse-document 测试断言），已按用户拍板接受原码透传（非 FILE_NOT_FOUND） | ✅ PASS |
| 3 | 空规则 | `done.coverage={total:0, done:0, review:0, failed:0, details:{}}`——**total=0 非 null** | ✅ PASS |
| 4 | 单规则超时（stepTimeoutMs=1） | `warning {code:"RULE_TIMEOUT", ruleId:"R001", message:"执行超时"}` + done 正常（coverage.details.R001=review） | ✅ PASS |
| 5 | abort | abort → 202 `{ok:true,aborted:true}`；流 error `{code:"ABORTED", stage:"EXECUTING", aborted:true}`（3 秒内） | ✅ PASS |

错误码透传要求（UNSUPPORTED_FORMAT/READ_FAILED/ABORTED 原码，不统一成 SKILL_FAILED/INTERNAL）✅ 满足。

## 3. e2e 实测（真实链路 metrics）

来源：`POST http://127.0.0.1:3001/api/review`（1 文档 testword.docx + 3 规则：R001 五常线规格/deterministic、R002 工井尺寸/deterministic、R003 付款语义/semantic，实测 2026-10-27）

- **事件序列**：`run_started → progress×10（5 阶段 running+done）→ result×3（R001 pass / R002 pass / R003 review）→ warning（REVIEW_RESULT）→ metrics → done`——逐帧到达、done 后连接关闭
- **文档数**：请求 1 / 解析成功 **1**（testword.docx，PARSING 91ms）
- **规则数**：请求 3 / 执行 **3**（EXECUTING 303ms，并发 2）
- **tokens**：`{prompt:0, completion:0, total:0, estimated:false}`（registry 无 LLM 调用）
- **elapsedMs**：394 ｜ **llmCalls**：0 ｜ **maxRounds**：3
- **stages**：`{PARSING:91, RULE_LOADING:0, PLANNING:0, EXECUTING:303, VERIFYING:0}`
- **metrics.rules**：`{total:3, pass:2, fail:0, review:1, failed:0}`（R003 semantic 走兜底→review）

## 4. coverage（e2e 实测）

- `done.coverage`：`{total:3, done:3, review:0, failed:0, details:{R001:"done", R002:"done", R003:"done"}}`
- 说明：矩阵 cell.status 表示执行完成态（3 条均 done）；result.status 表示判定结果（R003 判定 review）——二者分层：覆盖度=执行覆盖，rules.review=判定需复核。

## 5. 剩余风险（真实存在）

1. **semantic 规则无真实比对器**：registry 未接 runSemantic 技能，semantic/cross_doc 规则走兜底 → result=review + REVIEW_RESULT warning（演示中体现为"需人工复核"）。
2. **evidence 定位未接**：executor 的 `locateEvidence` 缺省返回 `[]` → result.evidence 为空，前端溯源高亮无数据。
3. **documents / message 事件不发**：harness 未转发 documents 事件、executor 不产 message → 前端 TraceViewer 空态、聊天流无模型消息。
4. **done.summary=null**：verify 未产出摘要（rules 概览前端有指标面板兜底，summary 位空）。
5. **tokens=0 / llmCalls=0**：registry 链路无 LLM 调用（模型未接线），指标面板 Token 显示 0。
6. **前端主 chunk 689KB > 500KB**：未 code-split（non-blocking）。
7. **测试/脚本缺失**：`test/contract.test.js` 与 `scripts/run-all-tests.sh`、`scripts/e2e-smoke.mjs`、`scripts/e2e-http.mjs`、`scripts/e2e-abnormal.mjs` 均不存在（本期以等效 node --test / npm run validate / curl 替代）；可固化自动化需另行创建（未确认不创建）。
8. **agent-server 无独立 package.json**：`npm start` 解析根脚本启动旧架构服务（8080）；启动须用 `PORT=3001 QWEN_API_KEY=… MODEL_NAME=… node src/server.js`。
9. **旧模块 `src/rules/parser/pdf.js`**：`doc.destroy` 崩溃（pdfjs v6）+ 缺 cMapUrl + 标题吞并正文行（skills 版已修，src 版重构时同步）。
10. **`@modelcontextprotocol/sdk` 未声明**且 node_modules 不完整（skills MCP 服务依赖，环境风险）。
11. **旧组件 `MessageList.vue` 残留**（未引用，不影响运行）。

## 6. 是否可进入演示

**是（真实链路可演示，带条件）。**

可演示（本次实测闭环）：真实解析（docx/pdf）→ 规则加载/规划/执行（deterministic 判定、result 事件）→ 覆盖度矩阵（coverage.details）→ 中断（ABORTED）→ 重试；异常处理（UNSUPPORTED_FORMAT/READ_FAILED/RULE_TIMEOUT）也真实可触发。

条件（演示时需说明的边界）：
- semantic 规则显示"需人工复核"（兜底 review）；证据溯源空（evidence=[]、documents 事件不发）；
- 无 LLM 相关表现（tokens 0、无模型消息、summary null）；
- 建议演示走 deterministic 规则 + 中断/重试 + 覆盖度，暂不演示 semantic/溯源/指标 Token。

## 7. 端口与清理

- ✅ 3001/5173 均已释放（`lsof` 无占用），后端进程已退出；abort Map 清理日志无残留（各请求 `剩余 0`）。

## 8. 本期涉及改动（真实链路接入，非回归破坏）

- `agent-server/src/skills/registry.js`（新建）：invokeSkill 分发（parseDocument/loadRules/retrieveContext/runDeterministic/verifyCoverage）+ initCoverageMatrix
- `agent-server/src/harness.js`：PARSING/RULE_LOADING/PLANNING/EXECUTING/VERIFYING 缺省接 registry（deps 优先保 mock 测试）；SkillError 原码透传
- `agent-server/src/agents/executor.js`：blockIndex/stepTimeoutMs 参数、缺省技能接线、withTimeout 统一 stepMs、超时 reason"执行超时"
- `agent-server/src/server.js`：透传 documents/ruleManifest、删除 defaultDeps、runId Map 保持（含清理日志）
- 单测断言伴随更新（error code：RUN_NOT_FOUND / ABORTED）——未删测试、未放宽断言