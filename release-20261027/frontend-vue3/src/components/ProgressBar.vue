<script setup>
// ProgressBar.vue —— 顶部细进度条（F Owner）
// props: percent(Number)、stage(String)、visible(Boolean)
// percent 达 100 或 visible=false（done）时淡出
import { computed } from 'vue'

const props = defineProps({
  percent: { type: Number, default: 0 },
  stage: { type: String, default: '' },
  visible: { type: Boolean, default: false },
})

const shown = computed(() => Math.max(0, Math.min(100, props.percent)))
const faded = computed(() => props.percent >= 100 || !props.visible)
</script>

<template>
  <div :class="['progressbar', { faded }]">
    <div class="bar">
      <div class="fill" :style="{ width: shown + '%' }"></div>
    </div>
    <span class="label">{{ stage }} {{ Math.round(shown) }}%</span>
  </div>
</template>

<style scoped>
.progressbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 16px;
  border-bottom: 1px solid var(--color-border);
  transition: opacity 0.6s ease;
}
.progressbar.faded {
  opacity: 0;
  pointer-events: none;
}
.bar {
  flex: 1;
  height: 4px;
  background: var(--color-border);
  border-radius: 2px;
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--color-primary);
  transition: width 0.3s ease;
}
.label {
  flex: none;
  min-width: 120px;
  font-size: 12px;
  color: var(--color-muted);
}
</style>
