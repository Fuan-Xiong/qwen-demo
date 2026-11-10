// agent-server/src/state/abort.js —— 可中止控制器（AbortController 封装）
// 三路触发：外部 AbortSignal / 手动 abort() / 超时自动触发；全部幂等；
// cleanup() 清理定时器与外部监听（防泄漏）；不依赖任何业务模块。

/**
 * 创建可中止控制器。
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] 外部信号（联入后外部中止同样生效）
 * @param {number} [opts.timeoutMs] 超时自动中止（<=0 不启用）
 * @returns {{
 *   signal: AbortSignal,
 *   aborted: () => boolean,   // 是否已中止
 *   timedOut: () => boolean,  // 是否因超时中止（用于错误归一化 TIMEOUT vs ABORT）
 *   abort: (reason?:unknown) => void,  // 手动中止（幂等）
 *   cleanup: () => void,      // 释放定时器与监听（finally 调用）
 * }}
 */
export function createAbortController({ signal, timeoutMs = 0 } = {}) {
  const controller = new AbortController()
  let timedOut = false

  let timer = null
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    timer.unref?.() // 不阻塞进程退出
  }

  const onExternalAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onExternalAbort, { once: true })
  }

  return {
    signal: controller.signal,
    aborted: () => controller.signal.aborted,
    timedOut: () => timedOut,
    abort: (reason) => controller.abort(reason),
    cleanup: () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      signal?.removeEventListener('abort', onExternalAbort)
    },
  }
}