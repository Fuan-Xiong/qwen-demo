// agent-server/src/server.js —— HTTP 服务（health / review（SSE）/ review-abort / CORS）
//
// - 原生 node:http（与 B1 风格一致，不引入 express）；
// - /api/review：读 JSON body → createSSE → runReview（SSE 事件流），runId 注册进 activeRuns 供中止；
// - /api/review/abort：按 runId 中止进行中的评审（3 秒内停止调度）；
// - req.on('close')（前端断开）→ 自动中止；
// - 直接运行（node src/server.js）时监听 config.server.host:port；QWEN_API_KEY/MODEL_NAME 缺失启动即失败。

import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { config, snapshot } from './config/env.js'
import { createSSE } from './sse.js'
import { runReview } from './harness.js'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Run-Id, Authorization',
}

/** 进行中的评审：runId -> { abort }（abort 端点与前端断开共用） */
const activeRuns = new Map()

/** 统一 JSON 响应：所有响应带 CORS 头，body 一律 JSON 可序列化 */
function json(res, status, payload) {
  res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/** 读取并解析 JSON 请求体（超限/非法 → 抛带原因的 Error） */
function readJsonBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error(`请求体超过 ${limit} 字节上限`))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (size === 0) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (e) { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

/** 评审请求：SSE 事件流；解析/规则经 skills/registry 接入（阶段 1 PARSING + RULE_LOADING） */
async function handleReview(req, res) {
  let body
  try {
    body = await readJsonBody(req)
  } catch (err) {
    return json(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: err.message } })
  }
  const { docIds = [], ruleSetId = 'default', options = {} } = body
  // registry 接线：documents（含 path/base64）与 ruleManifest 透传给编排（阶段 1 PARSING/RULE_LOADING）
  const documents = Array.isArray(body.documents) ? body.documents : []
  const ruleManifest = Array.isArray(body.ruleManifest) ? body.ruleManifest : []
  // runId：优先请求方指定（/api/review/abort 按同一 id 定位）；缺失时生成 run_<ts>_<rand>
  const runId = typeof body.runId === 'string' && body.runId
    ? body.runId
    : `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  const controller = new AbortController()
  activeRuns.set(runId, { abort: () => controller.abort() })
  const onClose = () => controller.abort() // 前端断开连接 → 自动中止
  req.on('close', onClose)

  const sse = createSSE(res)
  try {
    await runReview({ runId, docIds, ruleSetId, documents, ruleManifest, options }, sse, controller.signal)
  } finally {
    activeRuns.delete(runId)
    console.log(`[activeRuns] 清理 ${runId}（剩余 ${activeRuns.size}）`) // Map 清理日志：验收无残留
    req.off('close', onClose)
  }
}

/** 中止请求：按 runId 中止进行中的评审 */
async function handleAbort(req, res) {
  let body = {}
  try { body = await readJsonBody(req) } catch { /* 空 body 视为无 runId */ }
  const runId = body?.runId
  if (typeof runId !== 'string' || !runId) {
    return json(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: '缺少 runId' } })
  }
  const entry = activeRuns.get(runId)
  if (!entry) {
    return json(res, 404, { ok: false, error: { code: 'RUN_NOT_FOUND', message: `无进行中的评审：${runId}` } })
  }
  entry.abort()
  return json(res, 202, { ok: true, runId, aborted: true })
}

/**
 * 创建 HTTP 服务（不监听，调用方 listen）。
 * @returns {import('node:http').Server}
 */
export function createApp() {
  return http.createServer(async (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase()
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    // CORS 预检
    if (method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS)
      res.end()
      return
    }

    try {
      if (method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { status: 'ok', service: 'agent-server', time: new Date().toISOString() })
      }
      if (method === 'POST' && url.pathname === '/api/review') {
        return await handleReview(req, res)
      }
      if (method === 'POST' && url.pathname === '/api/review/abort') {
        return await handleAbort(req, res)
      }
      return json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `无此路由 ${method} ${url.pathname}` } })
    } catch (err) {
      // 兜底：任何未捕获异常都收敛为 JSON，不泄露堆栈细节
      return json(res, 500, { ok: false, error: { code: 'INTERNAL', message: err?.message ?? String(err) } })
    }
  })
}

// ── 主入口守卫：直接运行才监听（被 import 时不启动）──────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createApp()
  server.listen(config.server.port, config.server.host, () => {
    console.log(`agent-server listening on http://${config.server.host}:${config.server.port}`)
    console.log(`复跑参数: ${JSON.stringify(snapshot())}`)
  })
  const shutdown = () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}