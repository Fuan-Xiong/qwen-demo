// mock/mockSse.js —— Mock SSE 流（F Owner）
// 导出 createMockSseStream({ events, signal, intervalMs }) → { stream, abort }：
// 返回 ReadableStream，按事件顺序 enqueue SSE 文本帧；intervalMs 缺省时每事件间隔 300-800ms 随机；
// signal.aborted 时停止并 close；abort() 由调用方主动停止。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// SSE 帧以 UTF-8 字节（Uint8Array）入队：与真实 fetch body 语义一致，
// 解析层（useSSE）统一按 TextDecoder.decode(value) 处理，不区分 mock/real
const encoder = new TextEncoder()
const frame = (event, data) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

const DELTA_CHUNK = 8

/** message 长 delta 拆成多帧（模拟真实 SSE 流式逐块推送），其余事件一帧 */
function toFrames(ev) {
  const delta = ev?.data?.delta
  if (ev?.event === 'message' && typeof delta === 'string' && delta.length > 1) {
    const out = []
    for (let i = 0; i < delta.length; i += DELTA_CHUNK) {
      out.push({ event: 'message', data: { delta: delta.slice(i, i + DELTA_CHUNK) } })
    }
    return out
  }
  return [{ event: ev.event, data: ev.data }]
}

/**
 * 构建 mock SSE 可读流。
 * @param {object} opts
 * @param {Array<{event:string, data:object}>} opts.events 事件序列（mockEvents.buildMockEvents）
 * @param {AbortSignal} [opts.signal] 外部中止信号
 * @param {number} [opts.intervalMs] 事件间隔（固定值）；缺省 300-800ms 随机
 * @returns {{stream:ReadableStream, abort:()=>void}}
 */
export function createMockSseStream({ events, signal, intervalMs } = {}) {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  const stream = new ReadableStream({
    async start(ctrl) {
      for (const ev of events ?? []) {
        if (controller.signal.aborted) break // 中止：停止推送
        for (const f of toFrames(ev)) { // message 长 delta 拆帧，模拟流式
          if (controller.signal.aborted) break
          const ms = intervalMs ?? 300 + Math.random() * 500 // 模拟真实流的随机间隔
          await sleep(ms) // 每帧前延迟（含首帧）：真实连接的首字节等待窗口，connecting 状态可观察
          if (controller.signal.aborted) break // sleep 期间可能已 abort：enqueue 前复查，阻断"迟到帧"
          try {
            ctrl.enqueue(frame(f.event, f.data))
          } catch {
            return // 流已取消（reader.cancel）：清理路径，不再推送
          }
        }
      }
      try {
        ctrl.close() // 事件推完（或被中止）都正常结束，reader 收到 done
      } catch { /* 流已关闭：幂等 */ }
    },
    cancel() {
      controller.abort()
      signal?.removeEventListener('abort', onAbort)
    },
  })

  return { stream, abort: () => controller.abort() }
}