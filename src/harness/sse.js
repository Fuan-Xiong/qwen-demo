// src/sse.js —— SSE 发送器（协议实现方：docs/sse-events.md）
// 铁律：data 单行 JSON、不压缩、事件后空一行、只由这里发帧（禁止别处 res.write）

const HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
  'Access-Control-Allow-Origin': '*',
}

export const EVENTS = [
  'meta', 'progress', 'message', 'rule_result', 'metrics', 'result', 'done', 'error',
]

export function createSseWriter(res) {
  let closed = false

  res.writeHead(200, HEADERS)
  res.flushHeaders?.()
  // 心跳：防中间层 60s 断流（不影响协议，前端 data 为空会跳过）
  const heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(': ping\n\n')
  }, 15_000)

  const send = (event, data) => {
    if (closed || res.writableEnded) return false
    if (!EVENTS.includes(event)) throw new Error(`非法事件名: ${event}`)
    const line = typeof data === 'string' ? data : JSON.stringify(data)
    if (line.includes('\n')) throw new Error(`data 必须是单行 JSON（事件 ${event}）`)
    res.write(`event: ${event}\ndata: ${line}\n\n`)
    return true
  }

  const close = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    if (!res.writableEnded) res.end()
  }

  return {
    send,
    close,
    get closed() { return closed },
  }
}
