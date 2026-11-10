// agent-server/test/sse.test.js —— SSE 写入器测试（node:test + node:assert/strict）
// 覆盖：响应头、事件帧格式、心跳与定时器清理、重复 close 幂等、res close 事件自动清理。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

// env.js 顶层 fail fast：先注入必填项再动态加载
process.env.QWEN_API_KEY = process.env.QWEN_API_KEY ?? 'test-key'
process.env.MODEL_NAME = process.env.MODEL_NAME ?? 'test-model'
const { createSSE } = await import('../src/sse.js')

/** 最小 ServerResponse mock：writableEnded / end→close 事件 / flushHeaders / write 收集 */
function mockRes() {
  const state = { chunks: [], code: null, headers: null, writableEnded: false, flushed: 0 }
  const closeHandlers = []
  return {
    state,
    get writableEnded() { return state.writableEnded },
    writeHead(code, headers) { state.code = code; state.headers = headers },
    write(chunk) { if (!state.writableEnded) state.chunks.push(String(chunk)); return true },
    end() {
      state.writableEnded = true
      queueMicrotask(() => { for (const fn of closeHandlers) { try { fn() } catch {} } })
    },
    flushHeaders() { state.flushed += 1 },
    on(event, fn) { if (event === 'close') closeHandlers.push(fn); return this },
    /** 模拟客户端断开（不经 end） */
    emitClose() { for (const fn of closeHandlers) { try { fn() } catch {} } },
  }
}

test('响应头正确：text/event-stream + 缓存/连接/代理相关头 + CORS', () => {
  const res = mockRes()
  createSSE(res, { keepaliveMs: 60_000 })
  assert.equal(res.state.code, 200)
  assert.match(res.state.headers['Content-Type'], /^text\/event-stream/)
  assert.equal(res.state.headers['Cache-Control'], 'no-cache, no-transform')
  assert.equal(res.state.headers.Connection, 'keep-alive')
  assert.equal(res.state.headers['X-Accel-Buffering'], 'no')
  assert.equal(res.state.headers['Access-Control-Allow-Origin'], '*')
  assert.equal(res.state.flushed, 1) // flushHeaders 已调用
})

test('事件帧格式：event: x\\ndata: {...}\\n\\n，多事件顺序拼接', () => {
  const res = mockRes()
  const sse = createSSE(res, { keepaliveMs: 60_000 })
  assert.equal(sse.send('run_started', { runId: 'r1' }), true)
  assert.equal(sse.send('progress', { ruleId: 'R1', done: 1, total: 3 }), true)
  assert.equal(
    res.state.chunks.join(''),
    'event: run_started\ndata: {"runId":"r1"}\n\n' + 'event: progress\ndata: {"ruleId":"R1","done":1,"total":3}\n\n',
  )
})

test('字符串 data 原样透传；对象 data JSON 序列化', () => {
  const res = mockRes()
  const sse = createSSE(res, { keepaliveMs: 60_000 })
  sse.send('message', '纯文本消息')
  sse.send('metrics', { total: 2, durationMs: 10 })
  assert.equal(res.state.chunks[0], 'event: message\ndata: 纯文本消息\n\n')
  assert.equal(res.state.chunks[1], 'event: metrics\ndata: {"total":2,"durationMs":10}\n\n')
})

test('非法事件名与多行 data → 抛错，不发出帧', () => {
  const res = mockRes()
  const sse = createSSE(res, { keepaliveMs: 60_000 })
  assert.throws(() => sse.send('unknown_event', {}), /非法 SSE 事件名/)
  assert.throws(() => sse.send('message', '第一行\n第二行'), /必须是单行/)
  assert.equal(res.state.chunks.length, 0)
})

test('close：幂等不报错，closed=true，之后 send 返回 false 且不再写入', () => {
  const res = mockRes()
  const sse = createSSE(res, { keepaliveMs: 60_000 })
  assert.equal(sse.closed, false)
  sse.send('run_started', { runId: 'r1' })
  sse.close()
  assert.equal(sse.closed, true)
  const lenBefore = res.state.chunks.length
  sse.close() // 幂等
  assert.equal(sse.send('progress', {}), false)
  assert.equal(res.state.chunks.length, lenBefore, 'close 后不得再写入任何帧')
})

test('心跳：按 keepaliveMs 周期性输出 : ping，close 后定时器被清理', async () => {
  const res = mockRes()
  const sse = createSSE(res, { keepaliveMs: 20 })
  await sleep(55) // 约 2~3 个心跳周期
  const pings = res.state.chunks.filter((c) => c === ': ping\n\n')
  assert.ok(pings.length >= 2, `应至少收到 2 个心跳，实收 ${pings.length}`)

  const lenBefore = res.state.chunks.length
  sse.close()
  await sleep(45)
  assert.equal(res.state.chunks.length, lenBefore, 'close 后心跳定时器必须被清理')
})

test('res close 事件（客户端断开）→ 自动关闭：closed=true、send=false、定时器清理', async () => {
  const res = mockRes()
  const sse = createSSE(res, { keepaliveMs: 20 })
  res.emitClose()
  assert.equal(sse.closed, true)
  assert.equal(sse.send('message', 'x'), false)

  const lenBefore = res.state.chunks.length
  await sleep(40)
  assert.equal(res.state.chunks.length, lenBefore, '连接断开后心跳必须停止')
})

test('res end 触发的 close 事件 → 重复清理不发生异常', async () => {
  const res = mockRes()
  const sse = createSSE(res, { keepaliveMs: 60_000 })
  sse.close() // end → 异步触发 close 事件 → 内部 close 幂等
  await sleep(10)
  assert.equal(sse.closed, true)
})