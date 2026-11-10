<script setup>
// StreamMessage.vue —— 单条消息气泡（F Owner）
// role: assistant/system/user；variant: normal/progress/warning
// content 为 Markdown，经 renderMarkdown 渲染为 HTML（markdown-it 已关闭 html 防注入）
import { renderMarkdown } from '../utils/markdown.js'

const props = defineProps({
  role: { type: String, default: 'assistant' },
  content: { type: String, default: '' },
  streaming: { type: Boolean, default: false },
  variant: { type: String, default: 'normal' },
})
</script>

<template>
  <div :class="['msg', `role-${role}`, `variant-${variant}`]">
    <div class="content" v-html="renderMarkdown(content)"></div>
    <span v-if="streaming" class="cursor" aria-hidden="true"></span>
  </div>
</template>

<style scoped>
.msg {
  padding: 8px 12px;
  border-radius: var(--radius);
  max-width: 100%;
  align-self: flex-start;
}

/* 气泡底色：assistant 浅灰，system 更淡，user 用主色淡底 */
.role-assistant {
  background: #1e222b;
  border: 1px solid var(--color-border);
}
.role-system {
  background: #161922;
  border: 1px solid var(--color-border);
  color: var(--color-muted);
  font-size: 12px;
}
.role-user {
  background: rgba(91, 141, 239, 0.12);
  border: 1px solid #2c3a55;
}

/* variant：progress 小号灰字；warning 黄色左边框 */
.variant-progress {
  font-size: 12px;
  color: var(--color-muted);
  background: transparent;
  border: 0;
  padding: 4px 8px;
}
.variant-warning {
  background: #241f12;
  border-left: 3px solid var(--color-warning);
  color: #f5d78e;
}

.content :deep(p) { margin: 0 0 6px; }
.content :deep(p:last-child) { margin-bottom: 0; }
.content :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.92em;
  background: #0d0f14;
  border-radius: 4px;
  padding: 1px 5px;
}
.content :deep(pre) {
  background: #0d0f14;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 10px;
  overflow-x: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
}
.content :deep(table) {
  border-collapse: collapse;
  width: 100%;
  display: block;
  overflow-x: auto;
  margin: 6px 0;
}
.content :deep(th, td) {
  border: 1px solid var(--color-border);
  padding: 4px 8px;
  font-size: 12px;
}

/* 流式追加时的闪烁光标 */
.cursor {
  display: inline-block;
  width: 8px;
  height: 14px;
  margin-left: 2px;
  vertical-align: -2px;
  background: var(--color-primary);
  animation: blink 0.8s steps(1) infinite;
}
@keyframes blink {
  50% { opacity: 0; }
}
</style>
