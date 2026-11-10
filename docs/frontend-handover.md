# frontend-handover.md —— 前端交接文档（封版 v1）

> 交接方：F（前端）｜交接日期：2026-10-26 ｜ 状态：封版检查通过（build 成功 + mock/real 全流程验证）
> 位置：`frontend-vue3/`（Vue3 + Vite + Composition API，fetch+ReadableStream，原生 CSS 变量，ECharts 按需引入）

## 1. 组件职责

| 组件 | 职责 | 关键 props | emit |
|---|---|---|---|
| `Toolbar.vue` | 顶栏：开始/中断/重试 + Mock 切换 + 状态徽章 | `status(String)`、`mockMode(Boolean)` | `start`/`abort`/`retry`/`toggle-mock` |
| `ProgressBar.vue` | 细进度条（stage + percent%，done 淡出） | `percent(Number)`、`stage(String)`、`visible(Boolean)` | — |
| `ErrorBanner.vue` | 浮顶错误横幅（code + message + 重试） | `error({code,message}\|null)` | `retry` |
| `ChatBox.vue` | 评审聊天流：delta 合并流式消息、progress 提示、渲染 ResultCard、warning/done 消息、自动滚动 | `events(Array)`、`status(String)`、`activeRuleId(String)` | `result-click`/`evidence-click`/`select` |
| `StreamMessage.vue` | 单条消息气泡（markdown 渲染、streaming 光标、variant） | `role`、`content`、`streaming`、`variant` | — |
| `ResultCard.vue` | 规则结果卡片（status/severity 徽章、证据列表、confidence、review reason） | `result(Object)`、`active(Boolean)` | `evidence-click`/`select` |
| `TraceViewer.vue` | 原文溯源：文档 tab、block 渲染、evidence 高亮定位（scrollIntoView + mark 高亮 + flash） | `documents(Array)`、`activeEvidence(Object\|null)` | — |
| `MetricsPanel.vue` | 指标面板：规则概览/覆盖率/Token/耗时+阶段/问题数 | `metrics(Object\|null)`、`coverage(Object\|null)`、`results(Array)` | — |
| `SeverityChart.vue` | ECharts 图表：柱状图（fail by severity）+ 饼图（status 分布） | `results(Array)` | — |

**核心组合式**：`src/composables/useSSE.js` —— `useSSE()` 返回 `{events, status, error, connect, abort, reset}`；`connect({url, body, mode, signal})`：mock 本地回放 / real fetch POST；帧解析含跨 chunk 缓存、多行 data、心跳跳过、流末残留；非 200 时把 `response.text()` 带进 error。

**数据层**：`src/mock/mockEvents.js`（buildMockEvents，14 事件双文档）、`src/mock/mockSse.js`（createMockSseStream：ReadableStream + **message delta 拆帧模拟流式** + abort 停止）、`src/mock/requestPayload.js`（real 模式请求体：documents fixture 路径 + 3 条规则 + options）。

**工具**：`src/utils/markdown.js`（markdown-it 单例，html:false/linkify/breaks，`renderMarkdown`）、`src/utils/format.js`（`formatMs`/`formatTokens`/`severityLabel`/`statusLabel`）。

## 2. Mock/真实切换

- **Toolbar switch**：切 `mode = 'mock' | 'real'`（App.vue `toggleMock`），点「开始核查」触发。
- mock：`connect({ mode:'mock' })` 本地回放 `buildMockEvents()`（事件间 300-800ms 随机、message 8 字符拆帧）。
- real：`connect({ url:'/api/review', body: buildRequestPayload(), mode:'real' })` —— vite proxy `/api → http://localhost:3001` 转发 agent-server。

## 3. 真实后端字段（联调实测，2026-10-26）

真实事件流（`POST :3001/api/review`）：`run_started → progress×10（5 阶段 running/done）→ warning → metrics → done`，与前端兼容性：

| 事件 | 真实后端字段 | 前端消费 | 状态 |
|---|---|---|---|
| run_started | `{runId, stages[]}` | runId | ✅ |
| progress | `{runId, stage, status:'running'\|'done', durationMs}` | stage | ⚠️ 无 percent/message（前端映射 stage，percent 显示 0/100 由 status 推导） |
| warning | `{code, message}` | 黄色消息 | ✅ |
| metrics | `{tokens, stages, rules, llmCalls, skills, elapsedMs, runId, maxRounds}` | tokens/elapsedMs/stages/rules | ✅ |
| done | `{runId, summary, coverage, metrics}` | coverage/metrics | ⚠️ summary/coverage 为 null（后端空跑所致） |
| documents/message/result | **当前不发** | ChatBox 卡片/TraceViewer | ⚠️ 后端未接 registry（空跑） |

## 4. 已知限制

1. **后端空跑**：agent-server `/api/review` 未接 `skills/registry`（B2 解析/规则引擎），不产 documents/message/result 事件、done.summary/coverage 为 null——前端卡片区与溯源为空态。接 registry 后即可闭环。
2. **progress 字段差异**：真实后端无 `percent/message`，进度条百分比由 `status='done' → 100` 推导（mock 有完整字段）。
3. **构建体积**：echarts 按需引入后主 chunk 689KB（>500KB 提示），未做 code-split（可用 `manualChunks` 或动态 import 优化，非阻塞）。
4. **`npm start`（agent-server）不可用**：`agent-server/` 无独立 package.json，启动需 `PORT=3001 QWEN_API_KEY=… MODEL_NAME=… node src/server.js`。
5. **旧组件残留**：`MessageList.vue`（旧契约版）保留未删，与当前 9 组件并存（未引用）。
6. **v-html 约束**：仅 `StreamMessage` 用 `v-html`（内容经 `renderMarkdown`）；`TraceViewer` 已改纯插值（Vue 自动转义）。

## 5. 测试

```bash
cd frontend-vue3 && npm run dev     # 开发（http://localhost:5173）
npm run build                       # 生产构建（664 modules，无报错）
```
封版检查验证（CLI 等价）：mock/real 完整跑、中断 301ms 内 aborted、重试/error 后重试、溯源高亮 + 未命中提示、指标字段 + 空数据、message delta 3 帧合并 1 条——全部 PASS。