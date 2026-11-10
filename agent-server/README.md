# agent-server —— 档案合规审查助手（Agent Harness + SSE 服务）

与旧 `src/harness/`（B1 初版）并行的独立实现模块，按新规格分模块交付：
`config → state → sdk → metrics → agents → skills → harness → sse → server`。
当前进度：**config/env.js（含 fail fast）与 server.js 骨架（health/占位路由/CORS）**。

## 启动

```bash
# 1. 配置必填环境变量（缺 QWEN_API_KEY / MODEL_NAME 会启动失败）
export QWEN_API_KEY=sk-xxx
export MODEL_NAME=qwen-max
# 2. 启动（默认 http://127.0.0.1:4170）
node src/server.js
```

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `QWEN_API_KEY` | **是** | — | qwen code SDK API Key（缺失 → 启动失败） |
| `MODEL_NAME` | **是** | — | 模型名（缺失 → 启动失败） |
| `QWEN_BASE_URL` | 否 | '' | SDK 网关地址；留空用 SDK 默认 |
| `HOST` / `PORT` | 否 | 127.0.0.1 / 4170 | 监听地址（与 B1 的 8080 隔离） |
| `MODEL_TEMPERATURE` / `MODEL_MAX_TOKENS` | 否 | 0.2 / 4096 | 模型温度 / 输出上限 |
| `HARNESS_TIMEOUT_MS` / `HARNESS_RETRIES` | 否 | 90000 / 2 | 外部调用超时（ms）/ 重试次数 |
| `HARNESS_CONCURRENCY` / `HARNESS_MAX_ROUNDS` | 否 | 2 / 3 | LLM 并发上限 / 最大轮次 |
| `SSE_KEEPALIVE_MS` | 否 | 15000 | SSE 心跳间隔（ms） |
| `LOG_LEVEL` | 否 | info | debug/info/warn/error/silent |
| `WORKSPACE_DIR` | 否 | ./.agent-runs | 工作目录（每个任务独立子目录） |

启动时控制台会打印**复跑参数快照**（`snapshot()`，可 JSON 序列化、不含密钥明文），用于日志记录复跑条件。

## 健康检查

```bash
curl http://127.0.0.1:4170/health
# → {"status":"ok","service":"agent-server","time":"..."}（200）
```

## 当前路由（骨架阶段）

| 方法 | 路径 | 现状 |
|---|---|---|
| GET | `/health` | 200 健康检查（含 CORS 头） |
| POST | `/api/review` | **501 占位**（等待 harness 模块接入） |
| POST | `/api/review/abort` | **501 占位** |
| OPTIONS | 任意 | 204 CORS 预检（`Access-Control-Allow-*`） |
| 其他 | — | 404 统一 JSON |

## 测试

```bash
# 在 agent-server/ 目录内（或 node --test test/server.test.js）
node --test test/env.test.js
node --test test/server.test.js
# 全量
node --test test/
```

测试说明：`server.test.js` 会先注入测试用 `QWEN_API_KEY`/`MODEL_NAME` 再动态加载 `server.js`；
"缺 key 启动失败"用例通过**子进程**运行 `src/server.js` 并清空必填变量断言退出码非 0。

## 目录规划

```
agent-server/
  src/
    config/env.js      ✅ 环境变量解析（fail fast + snapshot）
    server.js          ✅ HTTP 骨架（health/501 占位/CORS）
    sse.js             ⏳ 待交付（SSE 事件：run_started/progress/message/result/metrics/warning/error/done）
    harness.js         ⏳ 待交付（只编排，不实现业务规则）
    sdk/{client,errors,tokenCounter}.js  ⏳ 待交付（@qwen-code/sdk 封装：超时/重试/abort）
    agents/{planner,executor,verifier}.js ⏳ 待交付
    skills/registry.js ⏳ 待交付
    state/{runState,abort}.js ⏳ 待交付
    metrics/{metrics,logger}.js ⏳ 待交付
  test/                （node:test，每模块先测后进）
```