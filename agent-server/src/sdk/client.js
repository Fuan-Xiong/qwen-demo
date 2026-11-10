// agent-server/src/sdk/client.js —— LLM Chat Completions 客户端（OpenAI 兼容 /v1/chat/completions）
//
// 说明：标准 chat({messages, tools, stream}) 形态与 @qwen-code/sdk 的 query()（工作目录+prompt 驱动）
// 不匹配，因此本客户端用内置 fetch 直连 config.qwen.baseURL（或默认端点），全部参数来自 config/env.js。
// 核心约束：支持 AbortSignal、可超时（config.harness.timeoutMs，测试可覆盖）；apiKey 只进 Authorization
// 头，绝不打印/出现在错误信息中；返回/异常均 JSON 可序列化。

import { config } from '../config/env.js'
import { SdkError, httpErrorToSdkError } from './errors.js'
import { countTokens } from './tokenCounter.js'
import { callWithRetry } from '../utils/retry.js' // 只重试 retryable（RATE_LIMIT/TIMEOUT/SERVER_ERROR）

/** 默认端点（可被 QWEN_BASE_URL 覆盖；硬编码仅作兜底，不含任何机密） */
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

/**
 * 一次 Chat 补全调用。
 * @param {object} opts
 * @param {Array<{role:string, content?:string, tool_calls?:Array<object>}>} opts.messages
 * @param {Array<object>} [opts.tools] 函数声明（tools 协议），有则随请求下发
 * @param {boolean} [opts.stream] 流式输出；true 时必须给 onDelta
 * @param {AbortSignal} [opts.signal] 取消信号（用户主动取消 → ABORT）
 * @param {(delta:string)=>void} [opts.onDelta] 流式逐块文本回调
 * @param {number} [opts.timeoutMs] 覆盖 config.harness.timeoutMs（测试用小超时）
 * @returns {Promise<{text:string, usage:{input:number, output:number, total:number, estimated:boolean},
 *   finishReason:string, raw:object|null}>}
 * @throws {SdkError} RATE_LIMIT/TIMEOUT/AUTH/BAD_REQUEST/SERVER_ERROR/CONTENT_FILTER/ABORT
 */
export async function chat({ messages, tools, stream = false, signal, onDelta = () => {}, timeoutMs = config.harness.timeoutMs }) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new SdkError('BAD_REQUEST', 'messages 不能为空')
  }
  if (stream && typeof onDelta !== 'function') {
    throw new SdkError('BAD_REQUEST', 'stream=true 时必须提供 onDelta 回调')
  }

  const base = (config.qwen.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, '')

  // 内部控制器：合并调用方 signal 与超时
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) throw new SdkError('ABORT', '请求已中止')
    signal.addEventListener('abort', onAbort, { once: true })
  }

  const body = {
    model: config.model.name,
    messages,
    temperature: config.model.temperature,
    max_tokens: config.model.maxTokens,
    stream,
    ...(Array.isArray(tools) && tools.length ? { tools } : {}),
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  }

  let res
  try {
    // 可重试的 HTTP 错误（429/5xx 等，SdkError.retryable=true）走指数退避重试；
    // AbortError（超时/取消）retryable 未定义 → callWithRetry 不重试，转交外层归一。
    res = await callWithRetry(
      async () => {
        const r = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.qwen.apiKey}`, // 只进请求头，不进日志/错误
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        if (!r.ok) {
          let detail = null
          try { detail = await r.json() } catch { /* 非 JSON 响应体忽略 */ }
          throw httpErrorToSdkError(r.status, detail)
        }
        return r
      },
      { retries: config.harness.retries, baseDelayMs: 200, maxAttempts: config.harness.maxRounds },
    )
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new SdkError(timedOut ? 'TIMEOUT' : 'ABORT', timedOut ? `LLM 调用超时（${timeoutMs}ms）` : '请求已中止')
    }
    if (err instanceof SdkError) throw err // 已归一化；可重试错误重试耗尽后原样上抛
    throw new SdkError('SERVER_ERROR', `LLM 网络调用失败：${err?.message ?? String(err)}`, true, { originalName: err?.name })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }

  if (stream) return consumeStream(res, onDelta)
  return parseNonStream(await res.json())
}

/** 非流式响应 → 结果（finish_reason=content_filter 归一为 CONTENT_FILTER 错误） */
function parseNonStream(data) {
  const choice = data?.choices?.[0]
  const finishReason = choice?.finish_reason ?? 'stop'
  if (finishReason === 'content_filter') {
    throw new SdkError('CONTENT_FILTER', '内容被安全过滤（finish_reason=content_filter）', false, data)
  }
  return {
    text: choice?.message?.content ?? '',
    usage: countTokens({ usage: data?.usage, text: choice?.message?.content ?? '' }),
    finishReason,
    raw: data,
  }
}

/** 流式响应（SSE data: 行）→ 结果；onDelta 逐块回调；末尾 usage chunk 优先，缺失则估算 */
async function consumeStream(res, onDelta) {
  const reader = res.body?.getReader()
  if (!reader) throw new SdkError('SERVER_ERROR', '流式响应无 body', true)
  const decoder = new TextDecoder()
  let buf = ''
  let text = ''
  let finishReason = 'stop'
  let usage = null
  let raw = null

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '')
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let chunk
      try { chunk = JSON.parse(payload) } catch { continue } // 坏死行跳过，不中断流
      raw = chunk
      const delta = chunk.choices?.[0]?.delta
      if (typeof delta?.content === 'string' && delta.content) {
        text += delta.content
        onDelta(delta.content)
      }
      if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason
      if (chunk.usage) usage = chunk.usage
    }
  }

  if (finishReason === 'content_filter') {
    throw new SdkError('CONTENT_FILTER', '内容被安全过滤（finish_reason=content_filter）', false, raw)
  }
  return { text, usage: countTokens({ usage, text }), finishReason, raw }
}