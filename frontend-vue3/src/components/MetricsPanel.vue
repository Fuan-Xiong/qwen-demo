<script setup>
// MetricsPanel.vue —— 指标面板（F Owner）
// props: metrics（SSE metrics 事件）、coverage（done.coverage）、results（result 事件聚合）
// 展示：规则概览四卡 / 覆盖率 / Token / 耗时+阶段 / 问题数（按 severity 的 fail 统计）；无指标时空状态。
import { computed } from 'vue'
import { formatMs, formatTokens } from '../utils/format.js'

const props = defineProps({
  metrics: { type: Object, default: null },
  coverage: { type: Object, default: null },
  results: { type: Array, default: () => [] },
})

const m = computed(() => props.metrics ?? null)

/** 规则概览：metrics.rules 优先，回退 coverage */
const rules = computed(() => {
  if (m.value?.rules) return m.value.rules
  if (props.coverage) return { total: props.coverage.total, done: props.coverage.done, review: props.coverage.review, failed: props.coverage.failed }
  return null
})

/** 覆盖率百分比（coverage.done/total） */
const coverageRate = computed(() => {
  const c = props.coverage
  if (!c || !(c.total > 0)) return null
  return Math.round((c.done / c.total) * 100)
})

/** 问题数：按 severity 统计 fail（high/medium/low） */
const failBySeverity = computed(() => {
  const c = { high: 0, medium: 0, low: 0 }
  for (const r of props.results ?? []) {
    if (r.status === 'fail' && r.severity in c) c[r.severity] += 1
  }
  return c
})

/** 各阶段耗时（stages 对象 {stage: ms}） */
const stageEntries = computed(() => {
  const s = m.value?.stages
  if (!s || typeof s !== 'object') return []
  return Object.entries(s)
})
</script>

<template>
  <div class="mp">
    <p v-if="!m" class="empty">等待指标...</p>

    <template v-else>
      <!-- 1. 规则概览四卡 -->
      <div class="cards">
        <div class="card"><b>{{ rules?.total ?? '—' }}</b><span>规则数</span></div>
        <div class="card ok"><b>{{ rules?.done ?? '—' }}</b><span>已完成</span></div>
        <div class="card warn"><b>{{ rules?.review ?? '—' }}</b><span>需复核</span></div>
        <div class="card bad"><b>{{ rules?.failed ?? '—' }}</b><span>失败</span></div>
      </div>

      <!-- 2. 覆盖率 -->
      <div v-if="coverageRate != null" class="cov">
        <span class="cov-label">覆盖率 {{ coverageRate }}%（{{ props.coverage?.done }}/{{ props.coverage?.total }}）</span>
        <div class="covbar"><div class="covfill" :style="{ width: coverageRate + '%' }"></div></div>
      </div>

      <!-- 3. Token -->
      <div class="row">
        <b>Token {{ formatTokens(m?.tokens?.total ?? 0) }}</b>
        <span class="sub">
          prompt {{ formatTokens(m?.tokens?.prompt ?? 0) }} · completion {{ formatTokens(m?.tokens?.completion ?? 0) }}
          <em v-if="m?.tokens?.estimated" class="est">估算</em>
        </span>
      </div>

      <!-- 4. 耗时 + 阶段 -->
      <div class="row">
        <b>耗时 {{ (m?.elapsedMs ?? 0) >= 1000 ? `${((m?.elapsedMs ?? 0) / 1000).toFixed(1)}s` : `${m?.elapsedMs ?? 0}ms` }}</b>
        <span v-if="stageEntries.length" class="sub stages">
          <span v-for="[name, ms] in stageEntries" :key="name">{{ name }} {{ formatMs(ms) }}</span>
        </span>
      </div>

      <!-- 5. 问题数（按 severity 的 fail） -->
      <div class="row">
        <b>不合规</b>
        <span class="sub">
          <span class="chip high">高 {{ failBySeverity.high }}</span>
          <span class="chip medium">中 {{ failBySeverity.medium }}</span>
          <span class="chip low">低 {{ failBySeverity.low }}</span>
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.mp { display: flex; flex-direction: column; gap: 10px; }
.empty { color: var(--color-muted); font-size: 13px; text-align: center; margin: 20px 0; }

.cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.card { background: #10131a; border-radius: var(--radius-sm); padding: 8px; text-align: center; }
.card b { display: block; font-size: 18px; }
.card span { font-size: 11px; color: var(--color-muted); }
.card.ok b { color: var(--color-success); }
.card.warn b { color: var(--color-warning); }
.card.bad b { color: var(--color-danger); }

.cov .cov-label { font-size: 12px; color: var(--color-muted); }
.covbar { height: 6px; background: var(--color-border); border-radius: 3px; margin-top: 4px; overflow: hidden; }
.covfill { height: 100%; background: var(--color-success); }

.row { font-size: 13px; }
.row b { margin-right: 8px; }
.sub { color: var(--color-muted); font-size: 12px; }
.est { color: var(--color-warning); font-style: normal; font-size: 11px; margin-left: 4px; border: 1px solid #4a3820; border-radius: 4px; padding: 0 4px; }
.stages { display: inline-flex; flex-wrap: wrap; gap: 6px; }
.chip { border: 1px solid var(--color-border); border-radius: 4px; padding: 0 6px; margin-right: 4px; font-size: 11px; }
.chip.high { color: var(--color-danger); }
.chip.medium { color: #f59e0b; }
.chip.low { color: #60a5fa; }
</style>
