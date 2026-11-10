<script setup>
// SeverityChart.vue —— 结果图表（F Owner）
// props: results（result 事件聚合）
// ECharts 按需引入：BarChart / PieChart + Grid / Tooltip / Legend + CanvasRenderer
// 柱状图：按 severity 统计 fail（高/中/低）；饼图：按 status 分布（pass/fail/review/not_applicable）
// 生命周期：init 一次（onMounted 或有数据时），数据变化 setOption 更新；resize 自适应；空数据不 init。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as echarts from 'echarts/core'
import { BarChart, PieChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([BarChart, PieChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])

const props = defineProps({
  results: { type: Array, default: () => [] },
})

const hasData = computed(() => (props.results ?? []).length > 0)
const barEl = ref(null)
const pieEl = ref(null)
let barChart = null
let pieChart = null

/** 柱状图数据：按 severity 统计 fail（高/中/低） */
function buildBarOption(results) {
  const c = { high: 0, medium: 0, low: 0 }
  for (const r of results ?? []) {
    if (r.status === 'fail' && r.severity in c) c[r.severity] += 1
  }
  return {
    title: { text: '不合规（按严重级别）', textStyle: { fontSize: 12, color: '#98a2b3' } },
    tooltip: {},
    grid: { left: 40, right: 16, top: 36, bottom: 28 },
    xAxis: { type: 'category', data: ['高', '中', '低'], axisLabel: { color: '#98a2b3' } },
    yAxis: { type: 'value', minInterval: 1, axisLabel: { color: '#98a2b3' } },
    series: [{ type: 'bar', barWidth: 40, data: [c.high, c.medium, c.low], itemStyle: { color: '#ef4444' } }],
  }
}

/** 饼图数据：按 status 分布 */
function buildPieOption(results) {
  const counts = {}
  for (const r of results ?? []) {
    const s = r.status ?? 'other'
    counts[s] = (counts[s] ?? 0) + 1
  }
  const label = { pass: '合规', fail: '不合规', review: '需复核', not_applicable: '不适用' }
  return {
    title: { text: '结果分布', textStyle: { fontSize: 12, color: '#98a2b3' } },
    tooltip: { trigger: 'item' },
    legend: { bottom: 0, textStyle: { color: '#98a2b3' } },
    series: [{
      type: 'pie',
      radius: ['40%', '70%'],
      label: { color: '#98a2b3' },
      data: Object.entries(counts).map(([k, v]) => ({ name: label[k] ?? k, value: v })),
    }],
  }
}

function ensureCharts() {
  if (barChart || !barEl.value || !pieEl.value) return
  barChart = echarts.init(barEl.value)
  pieChart = echarts.init(pieEl.value)
}

function render() {
  if (!hasData.value) return // 空数据：不 init 空图
  ensureCharts()
  barChart?.setOption(buildBarOption(props.results), { notMerge: true })
  pieChart?.setOption(buildPieOption(props.results), { notMerge: true })
}

const onResize = () => {
  barChart?.resize()
  pieChart?.resize()
}

onMounted(() => {
  window.addEventListener('resize', onResize)
  if (hasData.value) render()
})

// 数据变化：已 init 则 setOption 更新；从空到有数据时补 init
watch(() => props.results.length, render)

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  barChart?.dispose()
  pieChart?.dispose()
  barChart = null
  pieChart = null
})
</script>

<template>
  <div class="sc">
    <p v-if="!hasData" class="empty">暂无图表数据</p>
    <div v-else class="charts">
      <div ref="barEl" class="chart"></div>
      <div ref="pieEl" class="chart"></div>
    </div>
  </div>
</template>

<style scoped>
.sc { width: 100%; }
.empty { color: var(--color-muted); font-size: 13px; text-align: center; margin: 20px 0; }
.charts { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.chart { height: 220px; min-width: 0; } /* 220px 高度，宽度自适应 */
</style>
