// useSSE.js —— SSE 客户端组合式（F Owner）
// 导出 useSSE()：{ events, status, error, connect, abort, reset }
// - mode='mock'：createMockSseStream 本地回放；mode='real'：fetch POST 直连
// - 帧解析：跨 chunk 半帧缓存、多行 data 拼接、': ping' 心跳跳过、流末残留解析
// - 解析层不吞错：JSON.parse 失败等上抛 → error ref

import { ref } from 'vue'
import { createMockSseStream } from '../mock/mockSse.js'
import { buildMockEvents } from '../mock/mockEvents.js'

/**
 * SSE 连接状态机组合式。
 * @returns {{
 *   events: import('vue').Ref<Array<{event:string, data:object, at:number}>>,
 *   status: import('vue').Ref<'idle'|'connecting'|'streaming'|'done'|'error'|'aborted'>,
 *   error: import('vue').Ref<string|null>,
 *   connect:(opts)=>Promise<void>, abort:()=>void, reset:()=>void
 * }}
 */
export function useSSE() {
  const events = ref([])
  const status = ref('idle')
  const error = ref(null)

  let controller = null
  let externalSignal = null
  let onExternalAbort = null

  /**
   * 连接并消费 SSE 流。
   * @param {object} opts
   * @param {string} [opts.url] real 模式：POST 目标（默认 '/api/review'）
   * @param {object} [opts.body] real 模式：JSON 请求体
   * @param {'mock'|'real'} [opts.mode] 数据源
   * @param {AbortSignal} [opts.signal] 外部取消信号（联动内部 AbortController）
   */
  const connect = async ({ url = '/api/review', body = {}, mode, signal } = {}) => {
    events.value = []
    error.value = null
    status.value = 'connecting'

    controller = new AbortController()
    externalSignal = signal ?? null
    onExternalAbort = () => controller?.abort()
    if (externalSignal) {
      if (externalSignal.aborted) {
        status.value = 'aborted'
        return
      }
      externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }

    try {
      let stream
      if (mode === 'mock') {
        stream = createMockSseStream({ events: buildMockEvents(), signal: controller.signal }).stream
      } else {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        if (!res.ok || !res.body) {
          // 非 200：把响应文本带进错误（error ref 展示给 ErrorBanner）
          const text = await res.text().catch(() => '')
          throw new Error(`HTTP ${res.status}${text ? `：${text.slice(0, 300)}` : ''}`)
        }
        stream = res.body
      }

      const reader = stream.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // 按空行分隔完整帧；跨 chunk 的半帧留在 buffer
        let idx
        while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const raw = buffer.slice(0, idx)
          buffer = buffer.slice(idx + (buffer[idx] === '\r' ? 4 : 2))
          const parsed = parseFrame(raw)
          if (!parsed) continue // 心跳/空帧：不产生事件
          events.value.push({ event: parsed.event, data: parsed.data, at: Date.now() })
          if (status.value === 'connecting') status.value = 'streaming'
          if (parsed.event === 'done') {
            status.value = 'done'
            await reader.cancel().catch(() => {}) // 主动关闭，不再消费后续
            return
          }
        }
      }

      // 流自然结束：buffer 残留（最后帧无结尾空行）仍尝试解析
      if (buffer.trim()) {
        const parsed = parseFrame(buffer)
        if (parsed) {
          events.value.push({ event: parsed.event, data: parsed.data, at: Date.now() })
          if (status.value === 'connecting') status.value = 'streaming'
          if (parsed.event === 'done') { status.value = 'done'; return }
        }
      }
      // 未见 done 但流已结束（真实后端不发 done 的兜底）
      if (status.value === 'connecting' || status.value === 'streaming') status.value = 'done'
    } catch (err) {
      if (err?.name === 'AbortError') {
        status.value = 'aborted'
      } else {
        status.value = 'error'
        error.value = err?.message ?? String(err)
      }
    } finally {
      externalSignal?.removeEventListener('abort', onExternalAbort)
    }
  }

  /** 中止当前连接（幂等；mock 流收到信号即停） */
  const abort = () => {
    controller?.abort()
    if (status.value === 'connecting' || status.value === 'streaming') status.value = 'aborted'
  }

  /** 复位到 idle（不做任何请求） */
  const reset = () => {
    events.value = []
    error.value = null
    status.value = 'idle'
  }

  return { events, status, error, connect, abort, reset }
}

/**
 * 解析单个 SSE 帧文本：提取 event 与 data。
 * - 注释行（: 开头，如 ': ping'）跳过
 * - data 多行以 '\n' 拼接
 * - 无 data 的帧（纯心跳）返回 null
 * - JSON.parse 失败向上抛（不吞错，由 connect 捕获暴露到 error）
 * @param {string} raw 一帧文本（不含结尾空行）
 * @returns {{event:string, data:object}|null}
 */
function parseFrame(raw) {
  let event = 'message'
  const dataLines = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(':')) continue // 心跳/注释行
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (dataLines.length === 0) return null
  return { event, data: JSON.parse(dataLines.join('\n')) }
}