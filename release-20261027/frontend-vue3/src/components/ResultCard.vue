<script setup>
// ResultCard.vue —— 单条规则核查结果卡片（F Owner）
// props: result（契约字段：ruleId/ruleName/status/severity/evidence[]/suggestion?/confidence?/reason?）、active
// 交互：点击 evidence → emit('evidence-click', evidence)；点击卡片 → emit('select', ruleId)
import { computed } from 'vue'

const props = defineProps({
  result: { type: Object, required: true },
  active: { type: Boolean, default: false },
})
const emit = defineEmits(['evidence-click', 'select'])

const STATUS_TEXT = { pass: '合规', fail: '不合规', review: '需复核', not_applicable: '不适用' }
const SEVERITY_TEXT = { high: '高', medium: '中', low: '低' }
const MAX_EVIDENCE = 200 // 证据片段展示上限（字）

const statusText = computed(() => STATUS_TEXT[props.result.status] ?? props.result.status)
const severityText = computed(() => SEVERITY_TEXT[props.result.severity] ?? props.result.severity)

/** 置信度归一化 0~1；非法/缺失返回 null（不显示） */
const confidence = computed(() => {
  const c = props.result.confidence
  return typeof c === 'number' && Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : null
})

const truncate = (t) => (t && t.length > MAX_EVIDENCE ? `${t.slice(0, MAX_EVIDENCE)}…` : t)

const onCardClick = () => emit('select', props.result.ruleId)
</script>

<template>
  <article :class="['rc', `rc-${result.status}`, { active }]" @click="onCardClick">
    <header class="rc-head">
      <span class="rc-ruleid">{{ result.ruleId }}</span>
      <span class="rc-name">{{ result.ruleName }}</span>
      <span :class="['badge', 'st', result.status]">{{ statusText }}</span>
      <span v-if="result.severity" :class="['badge', 'sev', result.severity]">{{ severityText }}</span>
    </header>

    <!-- 证据列表：docName + page（可能 null）+ text 片段（200 字截断） -->
    <ul v-if="result.evidence?.length" class="rc-ev">
      <li
        v-for="(e, i) in result.evidence"
        :key="i"
        class="rc-ev-item"
        title="点击定位原文"
        @click.stop="emit('evidence-click', e)"
      >
        <span class="rc-where">{{ e.docName }}<template v-if="e.page != null"> · 第{{ e.page }}页</template></span>
        <span class="rc-snippet">「{{ truncate(e.text) }}」</span>
      </li>
    </ul>

    <p v-if="result.suggestion" class="rc-suggest">建议：{{ result.suggestion }}</p>

    <!-- reason：仅 review 展示（fail 的判定理由见 chat 流，卡片聚焦人工复核） -->
    <p v-if="result.status === 'review' && result.reason" class="rc-reason">{{ result.reason }}</p>

    <!-- 置信度：进度条 + 百分比 -->
    <div v-if="confidence != null" class="rc-conf">
      <div class="rc-confbar">
        <div class="rc-conffill" :style="{ width: (confidence * 100).toFixed(1) + '%' }"></div>
      </div>
      <span class="rc-confnum">{{ Math.round(confidence * 100) }}%</span>
    </div>
  </article>
</template>

<style scoped>
.rc {
  background: var(--color-panel);
  border: 1px solid var(--color-border);
  border-left-width: 3px;
  border-radius: var(--radius);
  padding: 10px 14px;
  cursor: pointer;
  transition: box-shadow 0.15s ease;
}
.rc:hover {
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
}

/* active：左边框高亮 */
.rc.active {
  outline: 1px solid var(--color-primary);
}
.rc.pass { border-left-color: var(--color-success); }
.rc.fail { border-left-color: var(--color-danger); }
.rc.review { border-left-color: var(--color-warning); }
.rc.not_applicable { border-left-color: var(--color-muted); }

.rc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.rc-ruleid { font-weight: 700; }
.rc-name { color: var(--color-muted); font-size: 13px; flex: 1; min-width: 100px; }

.badge {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 10px;
  font-weight: 600;
}
/* status：pass 绿 / fail 红 / review 黄 / not_applicable 灰 */
.badge.st.pass { background: #10291a; color: var(--color-success); }
.badge.st.fail { background: #3a1418; color: var(--color-danger); }
.badge.st.review { background: #35260b; color: var(--color-warning); }
.badge.st.not_applicable { background: #1a1d24; color: var(--color-muted); }
/* severity：high 红 / medium 橙 / low 蓝 */
.badge.sev.high { background: #3a1418; color: var(--color-danger); }
.badge.sev.medium { background: #3a2810; color: #f59e0b; }
.badge.sev.low { background: #10213a; color: #60a5fa; }

.rc-ev { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.rc-ev-item {
  display: flex;
  gap: 8px;
  align-items: baseline;
  background: #10131a;
  border-radius: var(--radius-sm);
  padding: 6px 8px;
  font-size: 12px;
  cursor: pointer;
}
.rc-ev-item:hover { outline: 1px solid var(--color-primary); }
.rc-where { color: var(--color-muted); flex: none; }
.rc-snippet { color: #cbd5e1; word-break: break-all; }

.rc-suggest { margin: 8px 0 0; color: var(--color-muted); font-size: 13px; }
.rc-reason { margin: 8px 0 0; color: var(--color-warning); font-size: 13px; }

.rc-conf { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.rc-confbar { flex: 1; height: 6px; background: var(--color-border); border-radius: 3px; overflow: hidden; }
.rc-conffill { height: 100%; background: var(--color-primary); transition: width 0.3s; }
.rc-confnum { font-size: 12px; color: var(--color-muted); }
</style>
