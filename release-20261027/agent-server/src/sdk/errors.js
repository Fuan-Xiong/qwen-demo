// agent-server/src/sdk/errors.js —— SDK 调用错误归一化
//
// 六类归一化错误码（覆盖上游错误）：
//   RATE_LIMIT / TIMEOUT / AUTH / BAD_REQUEST / SERVER_ERROR / CONTENT_FILTER
// 另有 ABORT：调用方通过 AbortSignal 主动取消（属控制流，非上游错误，不可重试）。
// retryable 判定：RATE_LIMIT/TIMEOUT/SERVER_ERROR=true；AUTH/BAD_REQUEST/CONTENT_FILTER=false。

export const SDK_ERROR_CODES = ['RATE_LIMIT', 'TIMEOUT', 'AUTH', 'BAD_REQUEST', 'SERVER_ERROR', 'CONTENT_FILTER']
export const ABORT_ERROR_CODE = 'ABORT'

const RETRYABLE = new Map([
  ['RATE_LIMIT', true],
  ['TIMEOUT', true],
  ['AUTH', false],
  ['BAD_REQUEST', false],
  ['SERVER_ERROR', true],
  ['CONTENT_FILTER', false],
  [ABORT_ERROR_CODE, false],
])

/** 归一化后的 SDK 错误 */
export class SdkError extends Error {
  /**
   * @param {string} code  SDK_ERROR_CODES 之一，或 ABORT
   * @param {string} message 人类可读描述（不含 apiKey 等敏感信息）
   * @param {boolean} [retryable] 是否建议重试；缺省按 code 判定
   * @param {unknown} [detail] 附加上下文（可为原始响应体）
   */
  constructor(code, message, retryable, detail) {
    super(message)
    this.name = 'SdkError'
    this.code = code
    this.retryable = retryable ?? RETRYABLE.get(code) ?? false
    this.detail = detail
  }
}

/** 按 HTTP 状态 + 错误响应体归一化（响应为非 2xx 时用） */
export function httpErrorToSdkError(status, body) {
  const msg = body?.error?.message ?? `上游返回 HTTP ${status}`
  const type = String(body?.error?.type ?? '').toLowerCase()
  if (type.includes('content_filter') || type.includes('safety')) {
    return new SdkError('CONTENT_FILTER', msg, false, body)
  }
  const code =
    status === 429 ? 'RATE_LIMIT'
      : status === 408 ? 'TIMEOUT'
        : status === 401 || status === 403 ? 'AUTH'
          : status >= 500 ? 'SERVER_ERROR'
            : 'BAD_REQUEST'
  return new SdkError(code, msg, undefined, body)
}

/**
 * 把任意错误转成 SdkError（不吞错）：
 * - 已是 SdkError 原样返回；
 * - AbortError（fetch 取消）→ 由调用方按 ABORT/TIMEOUT 场景自行构造，这里保留原名；
 * - 其他错误一律归为 SERVER_ERROR（消息不含敏感字段）。
 */
export function normalizeSdkError(err) {
  if (err instanceof SdkError) return err
  const code = err?.name === 'AbortError' ? ABORT_ERROR_CODE : 'SERVER_ERROR'
  const wrapped = new SdkError(code, err?.message ?? String(err), undefined, { originalName: err?.name })
  wrapped.cause = err
  return wrapped
}