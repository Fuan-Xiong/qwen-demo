// skills/parse-document/utils/errors.js —— 技能错误约定
// 规则：解析/处理失败必须抛 SkillError（或返回 {ok:false, reason}），禁止静默吞错。
// code 为机器可读错误码，message 为人话描述，detail 为附加上下文。

/**
 * 技能内统一错误。
 * @param {string} code    错误码，如 'EMPTY_RESULT' / 'INVALID_META' / 'PARSE_FAILED'
 * @param {string} message 人类可读描述
 * @param {unknown} [detail] 附加上下文（任意可序列化数据，可为原始 Error）
 */
export class SkillError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'SkillError'
    this.code = code
    this.detail = detail
    if (detail instanceof Error) this.cause = detail
  }
}

/**
 * 把任意错误转成 SkillError：
 * - 已是 SkillError：原样返回（透传 code/detail）
 * - 其他错误：默认保留其 code（若有，如 'BadRequest'/系统错误码 'ENOENT'），
 *   否则用 fallbackCode；detail 记录原始错误名/信息/码，cause 指向原错误
 * - forceCode: true 时强制使用 fallbackCode（用于解析器把读取/转换失败统一成一个错误码，
 *   原始 code 仍保留在 detail.originalCode）
 *
 * @param {unknown} err
 * @param {string} [fallbackCode]
 * @param {{forceCode?:boolean}} [opts]
 * @returns {SkillError}
 */
export function toSkillError(err, fallbackCode = 'UNKNOWN', { forceCode = false } = {}) {
  if (err instanceof SkillError) return err
  const preserve = !forceCode && typeof err?.code === 'string' && err.code
  const code = preserve ? err.code : fallbackCode
  const wrapped = new SkillError(code, err?.message ?? String(err), {
    originalName: err?.name ?? 'Error',
    originalMessage: err?.message,
    originalCode: err?.code ?? null,
  })
  wrapped.cause = err
  return wrapped
}
