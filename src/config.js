// src/config.js —— 所有可调参数集中在此，全部来自环境变量（禁止硬编码 key/模型）
// 依据：docs/任务看板.md「技术栈」+ .env.example

// 启动前加载仓库根目录 .env（Node ≥20.12 内置能力，不引入新依赖；已存在的环境变量优先）
try { process.loadEnvFile() } catch { /* 无 .env 时静默回退默认值 */ }

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v))

export const config = {
  host: process.env.HOST ?? '0.0.0.0',
  port: num(process.env.PORT, 8080),
  logLevel: process.env.LOG_LEVEL ?? 'info',

  llm: {
    baseURL: process.env.OPENAI_BASE_URL ?? 'http://localhost:8080/v1',
    apiKey: process.env.OPENAI_API_KEY ?? '',
    model: process.env.OPENAI_MODEL ?? 'qwen3.8-max',
    temperature: num(process.env.LLM_TEMPERATURE, 0.2),
    maxTokens: num(process.env.LLM_MAX_TOKENS, 4096),
    concurrency: num(process.env.LLM_CONCURRENCY, 2),
  },

  // 内网自部署 VL 模型（vLLM OpenAI 兼容端点），图片/PDF 扫描页 OCR 专用
  ocr: {
    enabled: process.env.OCR_ENABLED !== 'false',
    baseURL: process.env.OCR_BASE_URL ?? '',
    apiKey: process.env.OCR_API_KEY ?? '',
    model: process.env.OCR_MODEL ?? 'Qwen2.5-VL-7B-Instruct',
    concurrency: num(process.env.OCR_CONCURRENCY, 2),
    pageTimeoutMs: num(process.env.OCR_PAGE_TIMEOUT_MS, 120_000),
    maxTokens: num(process.env.OCR_MAX_TOKENS, 2048),
    // PDF 页判定"无文本层"的字符阈值：低于此值整页走 OCR
    minTextChars: num(process.env.OCR_MIN_TEXT_CHARS, 10),
    // PDF 渲染为图片的缩放倍数（2 = 2x，清晰度/体积折中）
    renderScale: num(process.env.OCR_PDF_RENDER_SCALE, 2),
  },

  harness: {
    maxRounds: num(process.env.HARNESS_MAX_ROUNDS, 3),
    stepTimeoutMs: num(process.env.HARNESS_STEP_TIMEOUT_MS, 90_000),
    retry: num(process.env.HARNESS_RETRY, 1),
    maxContextChars: num(process.env.HARNESS_MAX_CONTEXT_CHARS, 6000),
  },

  rules: {
    file: process.env.RULES_FILE ?? 'docs/rules清单.md',
    setId: process.env.RULE_SET_ID ?? 'default',
  },

  workspaceDir: process.env.WORKSPACE_DIR ?? './workspace',
}

export const log = {
  info: (...a) => config.logLevel !== 'silent' && console.log('[info]', ...a),
  warn: (...a) => config.logLevel !== 'silent' && console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
}
