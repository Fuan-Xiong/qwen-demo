// agent-server/src/config/env.js —— 环境变量集中解析（fail fast：缺必填直接在启动期抛错）
//
// 核心约束：
// - 参数全部环境变量化，禁止硬编码 key/模型/端口；
// - QWEN_API_KEY、MODEL_NAME 必填，缺失 → ConfigError，import 即失败（启动失败）；
// - loadEnv(env) 可注入环境对象，便于测试（纯函数，不读隐式全局）；
// - snapshot() 返回可 JSON 序列化的"复跑参数"（apiKey 只留 hasApiKey，不出明文）；
// - config 深度冻结。

/** 配置错误：携带变量名与收到的值，便于定位 */
export class ConfigError extends Error {
  /**
   * @param {string} key   环境变量名，如 'QWEN_API_KEY'
   * @param {unknown} value 收到的原始值
   * @param {string} reason 失败原因（必填缺失 / 校验失败等）
   */
  constructor(key, value, reason) {
    super(`环境变量 ${key} 非法（值=${JSON.stringify(value)}）：${reason}`)
    this.name = 'ConfigError'
    this.code = 'CONFIG_INVALID'
    this.key = key
    this.value = value
  }
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent']

// ── 解析小工具（非法值 → ConfigError，不静默回退默认）──────

function required(env, key) {
  const raw = env[key]
  if (raw === undefined || String(raw).trim() === '') {
    throw new ConfigError(key, raw, '必填环境变量缺失，请先配置（参考 .env.example）')
  }
  return String(raw).trim()
}

function pickStr(env, key, fallback) {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  return String(raw).trim()
}

function int(env, key, min, max) {
  const raw = env[key]
  if (raw === undefined || raw === '') return undefined // 未提供 → 由调用方填默认
  if (!/^-?\d+(?:\.\d+)?$/.test(String(raw))) throw new ConfigError(key, raw, '必须是整数')
  const n = Number(raw)
  if (!Number.isInteger(n)) throw new ConfigError(key, raw, '必须是整数')
  if (n < min || n > max) throw new ConfigError(key, raw, `必须在 ${min}~${max} 之间`)
  return n
}

function num(env, key, min, max) {
  const raw = env[key]
  if (raw === undefined || raw === '') return undefined
  if (!Number.isFinite(Number(raw))) throw new ConfigError(key, raw, '必须是数字')
  const n = Number(raw)
  if (n < min || n > max) throw new ConfigError(key, raw, `必须在 ${min}~${max} 之间`)
  return n
}

// ── 主入口 ─────────────────────────────────────────────

/**
 * 解析环境变量 → { config, snapshot }。
 * @param {NodeJS.ProcessEnv} [env] 默认 process.env；测试可注入
 * @returns {{config:object, snapshot:()=>object}}
 * @throws {ConfigError} QWEN_API_KEY / MODEL_NAME 缺失，或任一变量非法
 */
export function loadEnv(env = process.env) {
  const parsed = {
    server: {
      host: pickStr(env, 'HOST', '127.0.0.1'),
      port: int(env, 'PORT', 1, 65535) ?? 4170, // 与 B1（8080）隔离
    },
    qwen: {
      apiKey: required(env, 'QWEN_API_KEY'),
      baseURL: pickStr(env, 'QWEN_BASE_URL', ''),
    },
    model: {
      name: required(env, 'MODEL_NAME'),
      temperature: num(env, 'MODEL_TEMPERATURE', 0, 2) ?? 0.2,
      maxTokens: int(env, 'MODEL_MAX_TOKENS', 1, 1_000_000) ?? 4096,
    },
    harness: {
      timeoutMs: int(env, 'HARNESS_TIMEOUT_MS', 1, 3_600_000) ?? 90_000,
      retries: int(env, 'HARNESS_RETRIES', 0, 10) ?? 2,
      concurrency: int(env, 'HARNESS_CONCURRENCY', 1, 64) ?? 2,
      maxRounds: int(env, 'HARNESS_MAX_ROUNDS', 1, 50) ?? 3,
    },
    sse: {
      keepaliveMs: int(env, 'SSE_KEEPALIVE_MS', 1_000, 300_000) ?? 15_000,
    },
    log: {
      level: pickStr(env, 'LOG_LEVEL', 'info'),
    },
    workspaceDir: pickStr(env, 'WORKSPACE_DIR', './.agent-runs'),
  }

  if (!LOG_LEVELS.includes(parsed.log.level)) {
    throw new ConfigError('LOG_LEVEL', parsed.log.level, `必须是 ${LOG_LEVELS.join('/')}`)
  }

  const config = deepFreeze(parsed)

  /**
   * 复跑参数快照：可 JSON 序列化，apiKey 只输出 hasApiKey。
   * @returns {object} 记录到日志/结果里的只读配置
   */
  const snapshot = () => ({
    server: { host: parsed.server.host, port: parsed.server.port },
    qwen: { baseURL: parsed.qwen.baseURL, hasApiKey: parsed.qwen.apiKey.length > 0 },
    model: {
      name: parsed.model.name,
      temperature: parsed.model.temperature,
      maxTokens: parsed.model.maxTokens,
    },
    harness: {
      timeoutMs: parsed.harness.timeoutMs,
      retries: parsed.harness.retries,
      concurrency: parsed.harness.concurrency,
      maxRounds: parsed.harness.maxRounds,
    },
    sse: { keepaliveMs: parsed.sse.keepaliveMs },
    log: { level: parsed.log.level },
    workspaceDir: parsed.workspaceDir,
  })

  return { config, snapshot }
}

// 模块级默认实例（加载时解析一次；缺必填 → 抛 ConfigError，import 即失败）
const { config, snapshot } = loadEnv()

export { config, snapshot }

function deepFreeze(obj) {
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') deepFreeze(v)
  }
  return Object.freeze(obj)
}