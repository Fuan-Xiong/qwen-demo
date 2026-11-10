// agent-server/src/utils/retry.js —— 通用重试工具
//
// callWithRetry 语义：
// - 只重试 err.retryable === true 的错误（SdkError 的 RATE_LIMIT/TIMEOUT/SERVER_ERROR）；
// - 指数退避 + jitter：baseDelayMs * 2^attempt * (0.7~1.3)；
// - retries：退避重试次数上限（总调用 ≤ retries+1）；
// - maxAttempts：绝对总尝试上限（接入 harness 时传 config.harness.maxRounds，
//   "全局 MAX_ROUNDS"语义：再怎么可重试也不超过这个天花板）；
// - 达到任意上限或遇到不可重试错误 → 抛最后一次错误（不吞错）。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param {(attempt:number)=>Promise<unknown>|unknown} fn 每次调用收到当前尝试序号（0 起）
 * @param {{retries?:number, baseDelayMs?:number, maxAttempts?:number, onRetry?:(info:{attempt:number, err:Error, delayMs:number})=>void}} [opts]
 * @returns {Promise<unknown>} fn 成功值；全部失败抛最后一次错误
 */
export async function callWithRetry(fn, { retries = 2, baseDelayMs = 100, maxAttempts = Infinity, onRetry } = {}) {
  let attempt = 0
  for (;;) {
    try {
      return await fn(attempt)
    } catch (err) {
      const canRetry = err?.retryable === true
      const attemptsUsed = attempt + 1
      const overRetries = attemptsUsed > retries // 已耗尽退避重试次数
      const overMax = attemptsUsed >= maxAttempts // 触达全局上限（MAX_ROUNDS），即使 retries 未用尽
      if (!canRetry || overRetries || overMax) throw err

      const delay = Math.round(baseDelayMs * 2 ** attempt * (0.7 + Math.random() * 0.6))
      onRetry?.({ attempt, err, delayMs: delay })
      await sleep(delay)
      attempt += 1
    }
  }
}

/** 便于断言/测试：返回是否由 callWithRetry 判定为可重试 */
export function isRetryable(err) {
  return err?.retryable === true
}