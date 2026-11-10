<script setup>
// Toolbar.vue —— 顶栏：开始/中断/重试 + Mock 切换 + 状态徽章（F Owner）
// props: status、mockMode；emit: start/abort/retry/toggle-mock
import { computed } from 'vue'

const props = defineProps({
  status: { type: String, default: 'idle' },
  mockMode: { type: Boolean, default: true },
})
const emit = defineEmits(['start', 'abort', 'retry', 'toggle-mock'])

const STATUS_TEXT = {
  idle: '待开始', connecting: '连接中…', streaming: '评审中…',
  done: '已完成', error: '出错', aborted: '已中断',
}

const canStart = computed(() => props.status === 'idle')
const canAbort = computed(() => ['connecting', 'streaming'].includes(props.status))
const canRetry = computed(() => ['error', 'aborted'].includes(props.status))
</script>

<template>
  <div class="toolbar">
    <h1>档案合规审查助手</h1>

    <div class="actions">
      <button :disabled="!canStart" @click="emit('start')">开始核查</button>
      <button class="ghost" :disabled="!canAbort" @click="emit('abort')">中断</button>
      <button class="ghost" :disabled="!canRetry" @click="emit('retry')">重试</button>

      <label class="switch" title="数据源切换">
        <input type="checkbox" :checked="mockMode" @change="emit('toggle-mock')" />
        <span>{{ mockMode ? 'Mock' : '真实' }}</span>
      </label>
    </div>

    <span :class="['badge', status]">{{ STATUS_TEXT[status] ?? status }}</span>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
}
h1 { font-size: 16px; margin-right: auto; }
.actions { display: flex; align-items: center; gap: 8px; }

button {
  background: var(--color-primary);
  color: #fff;
  border: 0;
  border-radius: var(--radius-sm);
  padding: 6px 14px;
  cursor: pointer;
  font-size: 13px;
}
button:disabled { opacity: 0.4; cursor: not-allowed; }
button.ghost { background: transparent; border: 1px solid var(--color-border); color: var(--color-text); }

.switch { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--color-muted); cursor: pointer; }
.switch input { accent-color: var(--color-primary); }

.badge {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 12px;
  border: 1px solid var(--color-border);
  color: var(--color-muted);
}
.badge.connecting, .badge.streaming { color: var(--color-primary); border-color: #2c3a55; }
.badge.done { color: var(--color-success); border-color: #1d3a26; }
.badge.error { color: var(--color-danger); border-color: #4a2024; }
.badge.aborted { color: var(--color-warning); border-color: #4a3820; }
</style>
