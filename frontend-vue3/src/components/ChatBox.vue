<script setup>
// ChatBox.vue —— 评审聊天流（F Owner）
// props: events（useSSE.events）、status（useSSE.status）、activeRuleId（与 TraceViewer 联动高亮）、uploading（上传/OCR 解析中）
// 行为：message delta 合并为同一条 assistant 消息（流式追加）；progress 显示 stage+percent+message；
//       result 渲染 ResultCard（evidence-click/select 冒泡到 App）；warning/error 为黄色消息；
//       done 显示 summary。自动滚动贴底（用户上滚时暂停）。
// 输入栏：选择本地文件（含图片/扫描 PDF，OCR 由后端 /api/upload 完成）→ files-change 冒泡 App.load；
//        「上传并核查」→ start-upload 冒泡 App（强制 real 模式）。纯收集与冒泡，不含上传逻辑。
import { computed, nextTick, ref, watch } from 'vue'
import StreamMessage from './StreamMessage.vue'
import ResultCard from './ResultCard.vue'

const props = defineProps({
  events: { type: Array, default: () => [] },
  status: { type: String, default: 'idle' },
  activeRuleId: { type: String, default: '' },
  uploading: { type: Boolean, default: false },
})
const emit = defineEmits(['result-click', 'evidence-click', 'select', 'files-change', 'start-upload'])

const CONN_STATUS = {
  idle: '待开始', connecting: '连接中…', streaming: '评审中…',
  done: '已完成', error: '出错', aborted: '已中断',
}

/** 后端支持的文档格式（含图片，OCR 在 /api/upload 完成） */
const ACCEPT = '.docx,.pdf,.txt,.md,.jpg,.jpeg,.png,.webp,.bmp'
const picked = ref([]) // 已选择 File 列表（提交信号由 App 决定，这里不读文件内容）
const fileInput = ref(null)
const statusLabel = computed(() => CONN_STATUS[props.status] ?? props.status)
const busy = computed(() => props.status === 'connecting' || props.status === 'streaming')

function onPick(e) {
  picked.value = [...(e.target.files ?? [])]
  emit('files-change', picked.value)
  // 允许重复选择同一文件（每次 change 都触发）
  if (fileInput.value) fileInput.value.value = ''
}

/** events → 消息列表（纯转换；result 事件额外经 watch 抛出 result-click） */
const messages = computed(() => {
  const out = []
  let cur = null // 正在流式追加的 assistant 消息
  for (const ev of props.events ?? []) {
    switch (ev.event) {
      case 'message': {
        const delta = ev.data?.delta ?? ''
        if (!delta) break
        if (cur) {
          cur.content += delta // 连续 delta 合并到同一条（流式追加）
          cur.streaming = true
        } else {
          cur = { id: `m${out.length}`, role: 'assistant', variant: 'normal', content: delta, streaming: true }
          out.push(cur)
        }
        break
      }
      case 'progress': {
        cur = null
        out.push({
          id: `m${out.length}`, role: 'system', variant: 'progress',
          content: `${ev.data?.stage ?? ''} ${ev.data?.percent ?? 0}% ${ev.data?.message ?? ''}`,
        })
        break
      }
      case 'result': {
        cur = null
        // 渲染 ResultCard（不再是一行文本）
        out.push({ id: `m${out.length}`, kind: 'result', result: ev.data })
        break
      }
      case 'warning':
      case 'error': {
        cur = null
        out.push({
          id: `m${out.length}`, role: 'system', variant: 'warning',
          content: `${ev.data?.code ?? ''}：${ev.data?.message ?? ''}`,
        })
        break
      }
      case 'done': {
        cur = null
        out.push({ id: `m${out.length}`, role: 'system', variant: 'normal', content: ev.data?.summary ?? '' })
        break
      }
      default:
        break // run_started / documents / metrics 不渲染
    }
  }
  return out
})

// result 事件 → emit（事件驱动，不在 computed 内 emit）
watch(
  () => props.events.length,
  (len, oldLen) => {
    for (let i = oldLen ?? 0; i < len; i += 1) {
      const ev = props.events[i]
      if (ev?.event === 'result') emit('result-click', ev.data)
    }
  },
)

// 自动滚动贴底：用户上滚（距底 > 40px）时暂停跟随
const box = ref(null)
const stick = ref(true)
function onScroll() {
  const el = box.value
  if (!el) return
  stick.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}
watch(
  () => props.events.length,
  async () => {
    await nextTick()
    const el = box.value
    if (el && stick.value) el.scrollTop = el.scrollHeight
  },
)
</script>

<template>
  <div class="chatbox">
    <div ref="box" class="scroll" @scroll="onScroll">
      <p v-if="!messages.length" class="empty">
        {{ CONN_STATUS[status] ?? status }}——点击开始后，Agent 执行过程将实时显示。
      </p>
      <template v-for="m in messages" :key="m.id">
        <ResultCard
          v-if="m.kind === 'result'"
          :result="m.result"
          :active="m.result.ruleId === activeRuleId"
          @evidence-click="(e) => emit('evidence-click', e)"
          @select="(id) => emit('select', id)"
        />
        <StreamMessage
          v-else
          :role="m.role"
          :variant="m.variant"
          :content="m.content"
          :streaming="m.streaming"
        />
      </template>
    </div>
    <div class="inputbar">
      <input
        ref="fileInput"
        type="file"
        class="hidden-input"
        :accept="ACCEPT"
        multiple
        :disabled="uploading || busy"
        @change="onPick"
      />
      <span v-if="picked.length" class="picked" :title="picked.map((f) => f.name).join('\n')">
        已选 {{ picked.length }} 个：{{ picked.map((f) => f.name).join('、') }}
      </span>
      <span v-else class="hint">{{ statusLabel }}——选择本地文件（图片/扫描 PDF 自动 OCR）</span>
      <button class="btn" :disabled="uploading || busy" @click="fileInput?.click()">选择文件</button>
      <button
        class="btn primary"
        :disabled="uploading || busy || !picked.length"
        @click="() => emit('start-upload')"
      >
        {{ uploading ? '解析中（OCR 较慢，耐心等待）…' : '上传并核查' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.chatbox {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.scroll {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  min-height: 0;
}
.empty {
  color: var(--color-muted);
  font-size: 13px;
  text-align: center;
  margin: 24px 0;
}
.inputbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--color-border);
  background: var(--color-panel);
}
.hidden-input {
  display: none;
}
.picked {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text, #e5e7eb);
  font-size: 12px;
}
.hint {
  flex: 1;
  color: var(--color-muted);
  font-size: 12px;
}
.btn {
  flex: none;
  background: #10131a;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text, #e5e7eb);
  font-size: 12px;
  padding: 8px 12px;
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn.primary {
  background: #2563eb;
  border-color: #2563eb;
  color: #fff;
}
</style>
