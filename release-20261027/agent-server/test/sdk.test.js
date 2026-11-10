// agent-server/test/sdk.test.js —— sdk 层测试（node:test + node:assert/strict）
// 覆盖：mock SDK 返回 usage；流式逐块回调；abort 生效；超时 TIMEOUT；错误归一化；tokenCounter；不打印 apiKey。

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'

// env.js 顶层 fail fast：先注入必填项再动态加载
process.env.QWEN_API_KEY = process.env.QWEN_API_KEY ?? 'test-key'
process.env.MODEL_NAME = process.env.MODEL_NAME ?? 'test-model'
const { config } = await import('../src/config/env.js')
const { chat } = await import('../src/sdk/client.js')
const { countTokens } = await import('../src/sdk/tokenCounter.js')
const { SdkError, httpErrorToSdkError, normalizeSdkError } = await import('../src/sdk/errors.js')

const realFetch = globalThis.fetch

function mockFetch(handler) { globalThis.fetch = handler }
function mockJson(status, body) {
  mockFetch(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}
function mockSse(text) {
  mockFetch(async () => new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
}
/** 挂起直到 opts.signal 触发 abort（模拟真实 fetch 的取消行为） */
function mockAbortablePending() {
  mockFetch((_url, opts) => new Promise((_resolve, reject) => {
    opts.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  }))
}

afterEach(() => { globalThis.fetch = realFetch })

// ── chat：非流式 ────────────────────────────────────────

test('chat 非流式：mock 返回 usage → text/finishReason/usage 正确且请求带 key 头', async () => {
  let captured = null
  mockFetch(async (url, opts) => {
    captured = { url, auth: opts.headers.Authorization, body: JSON.parse(opts.body) }
    return new Response(JSON.stringify({
      choices: [{ message: { content: '解析完成' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })

  const r = await chat({ messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(r.text, '解析完成')
  assert.equal(r.finishReason, 'stop')
  assert.deepEqual(r.usage, { input: 10, output: 5, total: 15, estimated: false })
  assert.ok(r.raw.choices)
  // 参数来自 config：模型/温度/上限/端点
  assert.equal(captured.auth, `Bearer ${config.qwen.apiKey}`)
  assert.equal(captured.body.model, config.model.name)
  assert.equal(captured.body.max_tokens, config.model.maxTokens)
  assert.equal(captured.body.temperature, config.model.temperature)
  assert.match(captured.url, /^https?:\/\/.+\/chat\/completions$/)
  // 输出不得包含 apiKey 明文
  assert.ok(!JSON.stringify(r).includes(config.qwen.apiKey), '结果不得包含 apiKey')
})

test('chat 非流式：tools 随请求下发', async () => {
  mockJson(200, { choices: [{ message: { content: '', tool_calls: [{ id: '1', type: 'function' }] }, finish_reason: 'tool_calls' }] })
  let captured = null
  mockFetch(async (_url, opts) => { captured = JSON.parse(opts.body); return new Response('{}', { status: 200 }) })
  await chat({ messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'f' } }] })
  assert.ok(Array.isArray(captured.tools) && captured.tools.length === 1)
})

// ── chat：流式 ──────────────────────────────────────────

test('chat 流式：逐块 onDelta 拼接 + 末尾 usage chunk 优先', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"role":"assistant","content":"报价"}, "finish_reason":null}]}',
    'data: {"choices":[{"delta":{"content":"有效期"}, "finish_reason":null}]}',
    'data: {"choices":[{"delta":{"content":"90 天"}, "finish_reason":"stop"}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4}}',
    'data: [DONE]',
    '',
  ].join('\n')
  mockSse(sse)

  const deltas = []
  const r = await chat({ messages: [{ role: 'user', content: 'x' }], stream: true, onDelta: (d) => deltas.push(d) })
  assert.equal(r.text, '报价有效期90 天')
  assert.deepEqual(deltas, ['报价', '有效期', '90 天'])
  assert.equal(r.finishReason, 'stop')
  assert.deepEqual(r.usage, { input: 9, output: 4, total: 13, estimated: false })
})

test('chat 流式：无 usage chunk → 用 text 估算并标 estimated', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"条款"}, "finish_reason":"stop"}]}',
    'data: [DONE]',
    '',
  ].join('\n')
  mockSse(sse)
  const r = await chat({ messages: [{ role: 'user', content: 'x' }], stream: true, onDelta: () => {} })
  assert.equal(r.text, '条款')
  assert.equal(r.usage.estimated, true)
  assert.ok(r.usage.total > 0)
})

// ── chat：abort / 超时 ──────────────────────────────────

test('chat：AbortSignal 生效 → 抛 ABORT', async () => {
  mockAbortablePending()
  const ctrl = new AbortController()
  const p = chat({ messages: [{ role: 'user', content: 'hi' }], signal: ctrl.signal })
  setTimeout(() => ctrl.abort(), 10)
  await assert.rejects(p, (e) => e instanceof SdkError && e.code === 'ABORT' && e.retryable === false)
})

test('chat：超时 → 抛 TIMEOUT（可重试）', async () => {
  mockAbortablePending()
  await assert.rejects(
    chat({ messages: [{ role: 'user', content: 'hi' }], timeoutMs: 30 }),
    (e) => e instanceof SdkError && e.code === 'TIMEOUT' && e.retryable === true,
  )
})

// ── chat：错误归一化 ─────────────────────────────────────

test('chat：HTTP 状态码归一化 + retryable 判定', async () => {
  const cases = [
    { status: 429, body: { error: { message: 'rate limited', type: 'rate_limit_error' } }, code: 'RATE_LIMIT', retryable: true },
    { status: 408, body: { error: { message: 'timeout', type: 'server_error' } }, code: 'TIMEOUT', retryable: true },
    { status: 401, body: { error: { message: 'bad key', type: 'authentication_error' } }, code: 'AUTH', retryable: false },
    { status: 403, body: { error: { message: 'forbidden', type: 'permission_error' } }, code: 'AUTH', retryable: false },
    { status: 500, body: { error: { message: 'boom', type: 'server_error' } }, code: 'SERVER_ERROR', retryable: true },
    { status: 400, body: { error: { message: 'prompt filtered', type: 'content_filter' } }, code: 'CONTENT_FILTER', retryable: false },
  ]
  for (const c of cases) {
    mockJson(c.status, c.body)
    const err = await chat({ messages: [{ role: 'user', content: 'hi' }] }).catch((e) => e)
    assert.ok(err instanceof SdkError, `status=${c.status} 应为 SdkError`)
    assert.equal(err.code, c.code, `status=${c.status} 的 code`)
    assert.equal(err.retryable, c.retryable, `status=${c.status} 的 retryable`)
    // 归一化信息的 message 不得泄露 apiKey
    assert.ok(!err.message.includes(config.qwen.apiKey))
  }
})

test('chat：200 但 finish_reason=content_filter → CONTENT_FILTER（流式与非流式）', async () => {
  mockJson(200, { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }], usage: {} })
  const err1 = await chat({ messages: [{ role: 'user', content: 'x' }] }).catch((e) => e)
  assert.equal(err1.code, 'CONTENT_FILTER')

  mockSse('data: {"choices":[{"delta":{"content":""},"finish_reason":"content_filter"}]}\ndata: [DONE]\n')
  const err2 = await chat({ messages: [{ role: 'user', content: 'x' }], stream: true, onDelta: () => {} }).catch((e) => e)
  assert.equal(err2.code, 'CONTENT_FILTER')
})

test('normalizeSdkError：透传 SdkError，其余归 SERVER_ERROR', () => {
  const se = new SdkError('RATE_LIMIT', '限流', true)
  assert.equal(normalizeSdkError(se), se)
  const wrapped = normalizeSdkError(new Error('boom'))
  assert.ok(wrapped instanceof SdkError)
  assert.equal(wrapped.code, 'SERVER_ERROR')
  assert.equal(wrapped.retryable, true)
  const aborted = normalizeSdkError(Object.assign(new Error('x'), { name: 'AbortError' }))
  assert.equal(aborted.code, 'ABORT')
})

test('httpErrorToSdkError：响应体 JSON 与状态码组合', () => {
  const e = httpErrorToSdkError(429, { error: { message: 'slow down', type: 'rate_limit_error' } })
  assert.equal(e.code, 'RATE_LIMIT')
  assert.match(e.message, /slow down/)
})

// ── tokenCounter ────────────────────────────────────────

test('countTokens：usage 优先（estimated:false）', () => {
  const r = countTokens({ usage: { prompt_tokens: 100, completion_tokens: 50 } })
  assert.deepEqual(r, { input: 100, output: 50, total: 150, estimated: false })
  // OpenAI 新命名兼容
  const r2 = countTokens({ usage: { input_tokens: 7, output_tokens: 3 } })
  assert.deepEqual(r2, { input: 7, output: 3, total: 10, estimated: false })
})

test('countTokens：usage 缺失 → js-tiktoken 估算并标 estimated', () => {
  const r = countTokens({ text: '报价有效期不得少于 90 天。' })
  assert.equal(r.estimated, true)
  assert.ok(r.input > 0)
  assert.equal(r.total, r.input)
})

test('countTokens：未知模型回退通用编码器，不抛错', () => {
  const r = countTokens({ text: 'hello world', model: 'no-such-model-xyz' })
  assert.equal(r.estimated, true)
  assert.ok(r.total > 0)
})

test('chat 输出 JSON 可序列化（含 raw）', async () => {
  mockJson(200, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
  const r = await chat({ messages: [{ role: 'user', content: 'x' }] })
  assert.doesNotThrow(() => JSON.stringify(r))
})