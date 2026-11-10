<script setup>
// ErrorBanner.vue —— 错误横幅（F Owner）
// props: error({code, message}|null)；显示 code + message，带重试按钮 emit('retry')
defineProps({
  error: { type: Object, default: null },
})
const emit = defineEmits(['retry'])
</script>

<template>
  <div v-if="error" class="errorbanner">
    <span class="code">{{ error.code }}</span>
    <span class="msg">{{ error.message }}</span>
    <button class="retry" @click="emit('retry')">重试</button>
  </div>
</template>

<style scoped>
.errorbanner {
  position: absolute;
  top: 64px; /* Toolbar 高度下方 */
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 90%;
  padding: 8px 14px;
  background: #2a1418;
  border: 1px solid #4a2024;
  border-radius: var(--radius);
  color: var(--color-danger);
  font-size: 13px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
}
.code {
  flex: none;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px;
  background: rgba(239, 68, 68, 0.15);
  border-radius: 4px;
  padding: 1px 6px;
}
.msg { word-break: break-all; }
.retry {
  flex: none;
  background: transparent;
  border: 1px solid #4a2024;
  color: var(--color-danger);
  border-radius: var(--radius-sm);
  padding: 3px 10px;
  font-size: 12px;
  cursor: pointer;
}
.retry:hover { background: rgba(239, 68, 68, 0.12); }
</style>
