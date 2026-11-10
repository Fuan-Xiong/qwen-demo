# RELEASE.md —— archComply 封版快照

## 1. 版本信息

| 项 | 值 |
|---|---|
| 版本号 | **v1.0.0**（`archcomply@1.0.0`） |
| 封版时间 | 2026-10-27 |
| 封版人 | （待填写） |
| 快照目录 | `release-20261027/` |
| 基准报告 | `docs/test-report.md`（真实链路接入后整体回归，PASS 8 层 / FAIL 0） |

## 2. 启动命令

**后端（agent-server，Harness + SSE）**
```bash
cd agent-server
PORT=3001 QWEN_API_KEY=<你的key> MODEL_NAME=<模型名> node src/server.js
# 监听 127.0.0.1:3001；GET /health；POST /api/review（SSE）；POST /api/review/abort
```
> 注意：`agent-server/` 无独立 package.json，`npm start` 不适用；依赖（js-tiktoken/pdfjs-dist 等）在完整仓库根 package.json 声明，快照内运行前需先在完整仓库 `npm install`（见 §6 已知限制）。

**前端（frontend-vue3，Vue3 + Vite）**
```bash
cd frontend-vue3
npm install
npm run dev          # http://localhost:5173（vite proxy /api → http://localhost:3001）
```

**Mock 模式（无需后端）**
```bash
cd frontend-vue3 && npm run dev
# 页面默认 mock（buildMockEvents 14 事件本地回放），Toolbar 可切换 real（连真实后端）
```

## 3. 环境变量清单（不含真实 key；全部见 agent-server/.env.example）

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `QWEN_API_KEY` | ✅ 必填 | — | API Key（缺失 → 启动 fail fast） |
| `MODEL_NAME` | ✅ 必填 | — | 模型名（缺省 qwen-max 示例） |
| `QWEN_BASE_URL` | 可选 | 空 | SDK 网关地址，留空用 SDK 默认 |
| `HOST` / `PORT` | 可选 | 127.0.0.1 / 4170 | 监听地址；联调用 `PORT=3001` |
| `MODEL_TEMPERATURE` | 可选 | 0.2 | 模型温度 |
| `MODEL_MAX_TOKENS` | 可选 | 4096 | 单次输出上限 |
| `HARNESS_TIMEOUT_MS` | 可选 | 90000 | 编排超时 |
| `HARNESS_RETRIES` | 可选 | 2 | 可重试调用次数 |
| `HARNESS_CONCURRENCY` | 可选 | 2 | 规则执行并发 |
| `HARNESS_MAX_ROUNDS` | 可选 | 3 | 单规则最大轮次（MAX_ROUNDS） |
| `SSE_KEEPALIVE_MS` | 可选 | 15000 | SSE 心跳间隔 |
| `LOG_LEVEL` | 可选 | info | debug/info/warn/error/silent |
| `WORKSPACE_DIR` | 可选 | ./.agent-runs | 工作区目录 |

## 4. 复跑参数（与基准一致）

| 参数 | 值 | 来源 |
|---|---|---|
| model | test-model（演示值；生产用 MODEL_NAME 配置） | config snapshot |
| temperature | 0.2 | MODEL_TEMPERATURE |
| maxTokens | 4096 | MODEL_MAX_TOKENS |
| concurrency | 2（请求 `options.concurrency` 可覆盖） | HARNESS_CONCURRENCY |
| stepTimeoutMs | 30000（请求 `options.stepTimeoutMs` 默认；=1 触发 RULE_TIMEOUT） | harness 接线 |
| maxRetries | 2 | HARNESS_RETRIES |
| maxRounds | 3 | HARNESS_MAX_ROUNDS |

## 5. 基准运行结果（2026-10-27 e2e 实测，POST /api/review）

| 指标 | 值 |
|---|---|
| 文档数 | 1（testword.docx，PARSING 91ms，真实解析） |
| 规则数 | 3（R001 五常线/deterministic、R002 工井/deterministic、R003 付款/semantic） |
| tokens | `{prompt:0, completion:0, total:0, estimated:false}`（注册表链路无 LLM 调用） |
| elapsedMs | 394（EXECUTING 303ms） |
| coverage | `{total:3, done:3, review:0, failed:0, details:{R001:"done", R002:"done", R003:"done"}}` |
| 事件序列 | `run_started → progress×10 → result×3 → warning(REVIEW_RESULT) → metrics → done` |
| 单测 / 契约 / build | 108/108 ✅ ｜ npm run validate ✅ ｜ vite build 1.82s ✅ |

异常层基准（实测 code）：`UNSUPPORTED_FORMAT`（txt）｜ `READ_FAILED`（不存在文件，原码透传已拍板）｜ 空规则 `coverage.total=0` ｜ `RULE_TIMEOUT`（stepTimeoutMs=1）｜ `ABORTED`（abort 3 秒内）。

## 6. 已知限制与剩余风险（摘要，详见 docs/test-report.md §5）

1. **semantic 规则走兜底**：registry 未接 runSemantic，semantic/cross_doc 判定为 review + REVIEW_RESULT warning（演示中显示"需人工复核"）。
2. **证据溯源空**：executor `locateEvidence` 缺省 `[]`；documents/message 事件不发 → 前端 TraceViewer 空态、聊天流无模型消息。
3. **无 LLM 表现**：tokens=0 / llmCalls=0 / done.summary=null（registry 链路未接模型调用）。
4. **依赖安装**：快照不含根 package.json（agent-server 与 skills 的依赖在完整仓库根 package.json 声明）——快照内运行前需先从完整仓库 `npm install`；skills/mcp 的 `@modelcontextprotocol/sdk` 在根 package.json 未声明（node_modules 不完整）。
5. **脚本缺失**：`scripts/run-all-tests.sh` 与 `scripts/e2e-*.mjs` 不存在（快照仅含 `scripts/verify-test1-pdf.mjs`）；`test/contract.test.js` 不存在（契约校验用 `npm run validate`）。
6. **前端主 chunk 689KB > 500KB**：未 code-split（非阻塞）。
7. **启动端口**：agent-server 默认 4170，联调/前端 proxy 需 `PORT=3001`。
8. **旧组件 `MessageList.vue` 残留**（frontend-vue3，未引用）。

## 7. 校验口径

- 所有 `package.json`/`*.json` 可 JSON 解析；
- 无 `.env`（仅有占位模板 `.env.example`）、无 `node_modules`、无 `dist`、无临时日志；
- 无硬编码真实 API key（`.env.example` 中的 `sk-your-key-here` 为占位符模板）。