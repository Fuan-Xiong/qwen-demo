// agent-server/src/metrics/logger.js —— 结构化 JSON 日志（一行一条）
// 约定字段：runId/stage/event/ruleId/elapsedMs/tokens/errorCode（可附加任意 detail）；
// key 脱敏：敏感键（apiKey/secret/password/accessToken 等）递归替换为 [REDACTED]，
// 但 tokens（token 用量，复跑参数）不在脱敏范围——脱敏用精确敏感名而非 'token' 子串。

/** 敏感键判定：小写化并按 '_' 归一，结尾 '_key' 或含明确敏感词视为敏感 */
const SENSITIVE_HINTS = ['secret', 'password', 'passwd', 'authorization', 'bearer', 'credential', 'accesstoken', 'refreshtoken', 'privatekey', 'apikey', 'api_key']

export function isSensitiveKey(key) {
  const k = String(key).toLowerCase().replace(/-/g, '_')
  return k === 'key' || k.endsWith('_key') || SENSITIVE_HINTS.some((h) => k.includes(h))
}

/** 递归脱敏：命中敏感键的值替换为 [REDACTED]，其余原样返回 */
export function redact(value, key = '') {
  if (isSensitiveKey(key)) return '[REDACTED]'
  if (Array.isArray(value)) return value.map((x) => redact(x))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k)
    return out
  }
  return value
}

/**
 * 创建结构化日志器。
 * @param {{stream?:{write:(line:string)=>unknown}, level?:string}} [opts] 默认写 stderr
 * @returns {{log:(payload:object)=>void, info, warn, error}}
 */
export function createLogger({ stream = process.stderr } = {}) {
  return {
    log(payload = {}) {
      const line = { level: payload.level ?? 'info', ...payload }
      stream.write(`${JSON.stringify(redact(line))}\n`)
    },
    info(payload) { this.log({ ...payload, level: 'info' }) },
    warn(payload) { this.log({ ...payload, level: 'warn' }) },
    error(payload) { this.log({ ...payload, level: 'error' }) },
  }
}

/** 默认实例（stderr；测试请 createLogger({stream}) 注入内存流） */
export const logger = createLogger()