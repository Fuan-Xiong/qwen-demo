// src/rules/parser/ocr.js —— OCR（内网自部署 VL 模型，OpenAI 兼容端点）
// 职责：图片 / PDF 扫描页 → VL 模型按阅读顺序抽取原文 → 复用 textToBlocks 生成带页码的裸块。
// 设计：端点/模型/并发/超时全部环境变量化（src/config.js）；OCR 失败必须带上下文抛错，禁止伪造空文本。
// 调用链：src/rules/parser/index.js（图片入口）与 pdf.js（无文本层页）→ ocrImagePage → /chat/completions。

import { extname } from 'node:path'
import { config, log } from '../../config.js'
import { textToBlocks } from './utils.js'

/** 抽取提示词：只输出原文，不做任何解读/翻译/评论 */
const EXTRACTION_PROMPT = `你是文档版面 OCR 引擎。请按阅读顺序逐行提取图片中的全部文字，保留序号、编号与段落结构；表格按行输出并用 | 分隔单元格；不要翻译、不要解读、不要评论，只输出图片中的原文。`

/** 图片扩展名 → MIME（VL 模型常见支持格式；.bmp 如内网模型不支持可先在提示中说明或转 png） */
export const IMAGE_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

/** 并发闸：防止多页 OCR 并发把内网 VL 服务打满 */
class Semaphore {
  constructor(n) {
    this.n = Math.max(1, n)
    this.q = []
  }
  async run(fn) {
    if (this.n <= 0) await new Promise((r) => this.q.push(r))
    this.n -= 1
    try {
      return await fn()
    } finally {
      this.n += 1
      this.q.shift()?.()
    }
  }
}

const gate = new Semaphore(config.ocr.concurrency)

/** 超时包装：超时 → 抛 TimeoutError（上层按页重试/降级） */
function withTimeout(promise, ms, label) {
  let t
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => {
      const e = new Error(`${label} 超时 ${ms}ms`)
      e.name = 'TimeoutError'
      rej(e)
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t))
}

/**
 * 单页图片 OCR：调用内网 VL 端点（OpenAI 兼容 /chat/completions，image_url 直传 base64）。
 * 失败带页面上下文，重试次数复用 HARNESS_RETRY；不配置端点/未启用时抛明确错误，不静默。
 *
 * @param {{buffer:Buffer, mime:string, page?:number}} input
 * @returns {Promise<{text:string, usage?:object}>}
 */
export async function ocrImagePage({ buffer, mime, page = 1 } = {}) {
  if (!config.ocr.enabled) throw new Error(`OCR 未启用（OCR_ENABLED=false），无法识别第 ${page} 页`)
  if (!config.ocr.baseURL) throw new Error(`未配置 OCR_BASE_URL，无法执行 OCR（第 ${page} 页）`)
  if (!buffer || buffer.length === 0) throw new Error(`OCR 图片为空（第 ${page} 页）`)

  const body = {
    model: config.ocr.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` } },
        { type: 'text', text: EXTRACTION_PROMPT },
      ],
    }],
    temperature: 0,
    max_tokens: config.ocr.maxTokens,
    stream: false,
  }

  const attempts = config.harness.retry + 1
  let lastErr
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await gate.run(() => withTimeout((async () => {
        const endpoint = `${config.ocr.baseURL.replace(/\/+$/, '')}/chat/completions`
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(config.ocr.apiKey ? { Authorization: `Bearer ${config.ocr.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
        })
        if (!resp.ok) {
          const detail = await resp.text().catch(() => '')
          throw new Error(`OCR 端点 HTTP ${resp.status}: ${detail.slice(0, 300)}`)
        }
        const data = await resp.json()
        const text = extractText(data.choices?.[0]?.message?.content)
        if (!text) throw new Error('OCR 返回空文本')
        return { text, usage: data.usage }
      })(), config.ocr.pageTimeoutMs, `ocr:page${page}`))
    } catch (err) {
      lastErr = err
      log.warn(`OCR 第 ${page} 页第 ${attempt + 1} 次失败：${err.name} ${err.message}`)
    }
  }
  const e = new Error(`OCR 失败（第 ${page} 页，重试 ${config.harness.retry} 次后）：${lastErr?.message}`)
  e.name = lastErr?.name === 'TimeoutError' ? 'TimeoutError' : 'OcrError'
  throw e
}

/** content 可能是字符串或内容块数组（多模态网关两种返回形态都见过），统一转纯文本 */
function extractText(content) {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p?.text ?? ''))
      .join('')
      .trim()
  }
  return ''
}

/**
 * OCR 文本 → 带页码的裸块（复用 txt 的空行切段语义；单图片页=1）。
 * @param {string} text
 * @param {number} page
 * @returns {Array<{type:string, heading:null, page:number, text:string}>}
 */
export function ocrTextToBlocks(text, page = 1) {
  return textToBlocks(text).map((b) => ({ ...b, page }))
}

/**
 * 图片解析：校验扩展名 → 单页 OCR → 带 page=1 的裸块。
 * @param {{buffer:Buffer, docName?:string, ocrFn?:Function}} input  ocrFn 可注入（测试用），默认走内网 VL 端点
 * @returns {Promise<Array<object>>}
 */
export async function parseImageBlocks({ buffer, docName = 'image', ocrFn = ocrImagePage } = {}) {
  const mime = IMAGE_MIME[extname(docName).toLowerCase()]
  if (!mime) {
    const ext = extname(docName) || '(无扩展名)'
    throw new Error(`不支持的图片格式: ${ext}（支持 ${Object.keys(IMAGE_MIME).join('/')}）`)
  }
  const { text } = await ocrFn({ buffer, mime, page: 1 })
  if (!text) throw new Error('OCR 未返回任何文本')
  return ocrTextToBlocks(text, 1)
}