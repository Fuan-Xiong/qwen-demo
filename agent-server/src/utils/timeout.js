// agent-server/src/utils/timeout.js —— 通用超时工具
// 超时抛 SkillError("TIMEOUT")（与 B2 skills/parse-document 的 SkillError 约定同构，
// 便于 executors/skills 统一按 code 判定）；成功/其他错误原样透传。

/** agent-server 统一技能/工具错误（补充 sdk/errors.js 的 SdkError，二者按层分工） */
export class SkillError extends Error {
  /**
   * @param {string} code 错误码（如 TIMEOUT/BAD_INPUT）
   * @param {string} message 人类可读描述
   * @param {unknown} [detail] 附加上下文
   */
  constructor(code, message, detail) {
    super(message)
    this.name = 'SkillError'
    this.code = code
    this.detail = detail
  }
}

/**
 * 给 Promise 加超时：超时抛 SkillError("TIMEOUT")，否则原样透传结果/错误。
 * @param {Promise<unknown>|unknown} promise
 * @param {number} ms 超时毫秒（<=0 视作不限制）
 * @param {string} [label] 用于错误信息定位
 * @returns {Promise<unknown>}
 * @throws {SkillError} code='TIMEOUT'
 */
export function withTimeout(promise, ms, label) {
  if (!(Number.isFinite(ms) && ms > 0)) return Promise.resolve(promise)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new SkillError('TIMEOUT', `${label ?? '操作'} 超时（>${ms}ms）`, { ms, label })),
      ms,
    )
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}