<script setup>
// TraceViewer.vue —— 原文溯源查看器（F Owner）
// props: documents（SSE documents 事件）、activeEvidence（当前要高亮的证据）
// 行为：按 docId 分组 tab 切换；逐 block 渲染（heading + text；table 有 rows 时渲染表格）；
//       watch activeEvidence → 切 tab → scrollIntoView(smooth, center) → 按相对偏移切
//       before/highlight/after（<mark> 包裹）→ block 加 .flash 2 秒移除；blockId 找不到 toast 不崩溃。
import { computed, nextTick, ref, watch } from 'vue'

const props = defineProps({
  documents: { type: Array, default: () => [] },
  activeEvidence: { type: Object, default: null },
})

const root = ref(null)
const activeDocId = ref('')
const highlightMap = ref({}) // blockId -> { before, highlight, after }
const toast = ref('')
let flashTimer = null

const docList = computed(() => props.documents ?? [])
const activeDoc = computed(() => docList.value.find((d) => d.docId === activeDocId.value) ?? null)

// 默认选中第一个文档
watch(
  () => docList.value.length,
  (n) => {
    if (n && !activeDocId.value) activeDocId.value = docList.value[0].docId
  },
  { immediate: true },
)

// 切文档时清理旧高亮
watch(activeDocId, () => { highlightMap.value = {} })

/** 高亮切分：evidence 偏移相对 block.charStart 计算（同一文档全文偏移） */
function splitHighlight(block, ev) {
  const relStart = Math.max(0, (ev.charStart ?? 0) - (block.charStart ?? 0))
  const relEnd = Math.max(relStart, (ev.charEnd ?? 0) - (block.charStart ?? 0))
  return {
    before: block.text.slice(0, relStart),
    highlight: block.text.slice(relStart, relEnd),
    after: block.text.slice(relEnd),
  }
}

watch(
  () => props.activeEvidence,
  (ev) => {
    if (!ev) return
    // 1) 切到证据所在文档的 tab
    if (ev.docId && docList.value.some((d) => d.docId === ev.docId)) {
      activeDocId.value = ev.docId
    }
    // 2) 等渲染后定位 block
    nextTick(() => {
      const el = root.value?.querySelector(`[data-block-id="${ev.blockId}"]`)
      if (!el) {
        console.warn('[TraceViewer] 未找到证据 block:', ev.blockId)
        toast.value = `未找到证据块 ${ev.blockId}`
        clearTimeout(flashTimer)
        flashTimer = setTimeout(() => { toast.value = '' }, 2000)
        return
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      // 3) 按相对偏移切高亮片段
      const block = activeDoc.value?.blocks?.find((b) => b.blockId === ev.blockId)
      if (block) highlightMap.value[ev.blockId] = splitHighlight(block, ev)
      // 4) flash 2 秒后移除
      el.classList.add('flash')
      clearTimeout(flashTimer)
      flashTimer = setTimeout(() => el.classList.remove('flash'), 2000)
    })
  },
)
</script>

<template>
  <div ref="root" class="trace">
    <p v-if="!docList.length" class="empty">等待解析文档...</p>

    <template v-else>
      <!-- 文档 tab（按 docId 分组） -->
      <div class="tabs">
        <button
          v-for="d in docList"
          :key="d.docId"
          :class="['tab', { active: d.docId === activeDocId }]"
          @click="activeDocId = d.docId"
        >
          {{ d.docName }}
        </button>
      </div>

      <p v-if="toast" class="toast">{{ toast }}</p>

      <!-- 当前文档 blocks（按序渲染） -->
      <div class="blocks">
        <div
          v-for="block in activeDoc?.blocks ?? []"
          :key="block.blockId"
          class="block"
          :data-block-id="block.blockId"
        >
          <div v-if="block.heading" class="block-heading">{{ block.heading }}</div>
          <!-- 文本用插值渲染（Vue 自动转义，不经 v-html）；高亮时切三段包 <mark> -->
          <span class="block-text">
            <template v-if="highlightMap[block.blockId]">
              {{ highlightMap[block.blockId].before }}<mark>{{ highlightMap[block.blockId].highlight }}</mark>{{ highlightMap[block.blockId].after }}
            </template>
            <template v-else>{{ block.text }}</template>
          </span>
          <!-- 表格：documents 事件带 rows 时渲染，否则只显示 text -->
          <table v-if="block.rows?.length" class="block-rows">
            <tr v-for="(row, ri) in block.rows" :key="ri">
              <td v-for="(cell, ci) in row" :key="ci">{{ cell }}</td>
            </tr>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.trace { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.empty { color: var(--color-muted); font-size: 13px; text-align: center; margin: 32px 0; }

.tabs { display: flex; gap: 6px; padding: 10px 12px 0; border-bottom: 1px solid var(--color-border); }
.tab {
  background: transparent;
  border: 1px solid var(--color-border);
  border-bottom: 0;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  color: var(--color-muted);
  font-size: 12px;
  padding: 6px 14px;
  cursor: pointer;
}
.tab.active {
  background: var(--color-panel);
  color: var(--color-text);
  border-color: var(--color-border);
}

.toast {
  position: sticky;
  top: 8px;
  margin: 8px 12px 0;
  padding: 6px 10px;
  background: #2a1f12;
  border: 1px solid #4a3820;
  border-radius: var(--radius-sm);
  color: var(--color-warning);
  font-size: 12px;
}

.blocks { flex: 1; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.block {
  background: #10131a;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  font-size: 13px;
}
.block-heading { color: var(--color-primary); font-weight: 600; font-size: 12px; margin-bottom: 4px; }
.block-text { white-space: pre-wrap; word-break: break-all; }
.block-text :deep(mark) {
  background: rgba(91, 141, 239, 0.35);
  color: #fff;
  border-radius: 2px;
  padding: 0 1px;
}
/* 高亮定位闪烁 */
.block.flash {
  outline: 2px solid var(--color-primary);
  transition: outline-color 0.4s;
}
.block-rows { border-collapse: collapse; margin-top: 6px; width: 100%; }
.block-rows td { border: 1px solid var(--color-border); padding: 4px 8px; font-size: 12px; }
</style>
