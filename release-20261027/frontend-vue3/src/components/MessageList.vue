<script setup>
// MessageList.vue —— 聊天流（text / thinking 两种通道）
import { nextTick, ref, watch } from 'vue'

const props = defineProps({ messages: { type: Array, default: () => [] } })
const box = ref(null)

watch(
  () => props.messages.map((m) => m.text.length).join(','),
  async () => {
    await nextTick()
    if (box.value) box.value.scrollTop = box.value.scrollHeight
  },
)

const isThinking = (m) => m.channel === 'thinking'
</script>

<template>
  <div ref="box" class="chat">
    <p v-if="!messages.length" class="empty">点击「开始评审」后，Agent 的执行过程会实时显示在这里。</p>
    <div v-for="(m, i) in messages" :key="i" :class="['bubble', { thinking: isThinking(m) }]">
      <img v-if="!isThinking(m)" class="avatar" alt="agent" />
      <span class="text">{{ m.text }}</span>
      <code v-if="m.ruleId" class="tag">{{ m.ruleId }}</code>
    </div>
  </div>
</template>

<style scoped>
.chat {
  background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: 12px; height: 300px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px;
}
.empty { color: var(--muted); font-size: 13px; text-align: center; margin: auto; }
.bubble { display: flex; gap: 8px; align-items: baseline; }
.bubble.thinking { color: var(--muted); font-size: 12px; font-style: italic; }
.avatar {
  width: 22px; height: 22px; border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), #8b5cf6); flex: none; align-self: flex-start;
}
.text { white-space: pre-wrap; }
.tag { font-size: 10px; color: var(--accent); border: 1px solid #2c3a55; border-radius: 4px; padding: 0 4px; }
</style>
