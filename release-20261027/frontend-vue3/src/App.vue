<script setup>
// App.vue —— 前端整体集成（F Owner）
// 区域：顶部 Toolbar / 进度条 / 左侧 ChatBox(60%) / 右侧 TraceViewer(40%) / 底部 MetricsPanel+SeverityChart
// 状态：documents / results / metrics / coverage / activeEvidence / activeRuleId / progress / errorObj / mode
// 流程：点「开始核查」→ 进度推进 → 消息流式 → 结果卡片 → 指标图表 → done；点证据右侧滚动高亮；中断/重试可用
import { onMounted, ref, watch } from 'vue'
import { useSSE } from './composables/useSSE'
import { buildRequestPayload } from './mock/requestPayload.js'
import Toolbar from './components/Toolbar.vue'
import ProgressBar from './components/ProgressBar.vue'
import ErrorBanner from './components/ErrorBanner.vue'
import ChatBox from './components/ChatBox.vue'
import TraceViewer from './components/TraceViewer.vue'
import MetricsPanel from './components/MetricsPanel.vue'
import SeverityChart from './components/SeverityChart.vue'

const sse = useSSE()
const mode = ref('mock') // 数据源：mock | real
const runId = ref('') // 当前 run 的 runId（run_started 事件取得；real 中断时发给 /api/review/abort）
const documents = ref([])
const results = ref([]) // result 事件聚合（按 ruleId upsert）
const metrics = ref(null)
const coverage = ref(null)
const activeEvidence = ref(null) // TraceViewer 定位
const activeRuleId = ref('') // ResultCard active 样式
const progress = ref({ stage: '', percent: 0, message: '' })
const errorObj = ref(null) // { code, message }（ErrorBanner 展示）

// watch events：聚合各事件
watch(
  () => sse.events.value.length,
  () => {
    let lastMetrics = null
    let lastError = null
    for (const ev of sse.events.value) {
      switch (ev.event) {
        case 'run_started':
          runId.value = ev.data?.runId ?? ''
          break
        case 'documents':
          documents.value = ev.data?.documents ?? []
          break
        case 'progress':
          progress.value = {
            stage: ev.data?.stage ?? '',
            percent: ev.data?.percent ?? 0,
            message: ev.data?.message ?? '',
          }
          break
        case 'result': {
          const idx = results.value.findIndex((r) => r.ruleId === ev.data?.ruleId)
          if (idx >= 0) results.value.splice(idx, 1, ev.data)
          else results.value.push(ev.data)
          break
        }
        case 'metrics':
          lastMetrics = ev.data
          break
        case 'done':
          coverage.value = ev.data?.coverage ?? null
          if (ev.data?.metrics) lastMetrics = ev.data.metrics
          break
        case 'error':
          lastError = { code: ev.data?.code ?? 'UNKNOWN', message: ev.data?.message ?? '' }
          break
      }
    }
    if (lastMetrics) metrics.value = lastMetrics
    if (lastError) errorObj.value = lastError
  },
)

// status 变化：离开 error/aborted 时清理错误横幅
watch(
  () => sse.status.value,
  (s) => {
    if (s === 'streaming') errorObj.value = null
    else if (s === 'done') errorObj.value = null
  },
)

const start = () => {
  errorObj.value = null
  if (mode.value === 'real') {
    // 真实后端：POST /api/review，请求体来自 requestPayload（documents 路径 + ruleManifest + options）
    sse.connect({ url: '/api/review', body: buildRequestPayload(), mode: 'real' })
  } else {
    sse.connect({ mode: 'mock' })
  }
}
const abort = () => {
  if (mode.value === 'real' && runId.value) {
    // real 模式：先通知服务端中止（按 runId 定位 activeRun），再本地断开流
    fetch('/api/review/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: runId.value }),
    }).catch((e) => console.warn('[abort] 服务端中止请求失败', e))
  }
  sse.abort()
  errorObj.value = { code: 'ABORT', message: '已中断' }
}
const retry = start
const toggleMock = () => {
  mode.value = mode.value === 'mock' ? 'real' : 'mock'
}

function onEvidenceClick(evidence) {
  activeEvidence.value = evidence // TraceViewer 滚动高亮
}
function onSelect(ruleId) {
  activeRuleId.value = ruleId // ResultCard active 样式
}
function onResultClick(result) {
  console.log('[result-click]', result)
}

onMounted(() => {
  // 不自动连接：按流程由用户点「开始核查」触发
})
</script>

<template>
  <div class="app">
    <Toolbar
      :status="sse.status"
      :mock-mode="mode === 'mock'"
      @start="start"
      @abort="abort"
      @retry="retry"
      @toggle-mock="toggleMock"
    />
    <ProgressBar
      :percent="progress.percent ?? 0"
      :stage="progress.stage ?? ''"
      :visible="sse.status === 'streaming'"
    />
    <ErrorBanner :error="errorObj" @retry="retry" />

    <main class="body">
      <section class="chat">
        <ChatBox
          :events="sse.events"
          :status="sse.status"
          :active-rule-id="activeRuleId"
          @result-click="onResultClick"
          @evidence-click="onEvidenceClick"
          @select="onSelect"
        />
      </section>
      <aside class="trace">
        <TraceViewer :documents="documents" :active-evidence="activeEvidence" />
      </aside>
    </main>

    <footer class="metrics">
      <div class="metrics-grid">
        <MetricsPanel :metrics="metrics" :coverage="coverage" :results="results" />
        <SeverityChart :results="results" />
      </div>
    </footer>
  </div>
</template>

<style scoped>
.app {
  position: relative; /* ErrorBanner absolute 定位基准 */
  height: 100%;
  display: flex;
  flex-direction: column;
}

.body {
  flex: 1;
  display: grid;
  grid-template-columns: 3fr 2fr; /* ChatBox 60% / TraceViewer 40% */
  gap: 12px;
  padding: 12px 16px;
  min-height: 0;
}

.chat {
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  overflow: hidden; /* ChatBox 内部自行滚动 */
  min-height: 0;
}

.trace {
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  overflow: auto;
}

.metrics {
  flex: none;
  padding: 12px 16px;
  border-top: 1px solid var(--color-border);
}

.metrics-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

@media (max-width: 1000px) {
  .body {
    grid-template-columns: 1fr;
  }
  .metrics-grid {
    grid-template-columns: 1fr;
  }
}
</style>
