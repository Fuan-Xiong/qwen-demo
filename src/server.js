// src/server.js —— HTTP + SSE 服务（B1 Owner）
// 端点：POST /api/review（SSE）｜POST /api/upload｜GET /healthz｜GET /api/docs
// 中断：监听 req 'close' → AbortController.abort() → harness 真停

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { config, log } from './config.js'
import { createSseWriter } from './harness/sse.js'
import { runReview } from './harness/harness.js'
import { parseDocument } from './rules/parser/index.js'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...CORS })
  res.end(JSON.stringify(obj))
}

function readBody(req, limit = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(Object.assign(new Error('请求体过大'), { name: 'BadRequest' })); req.destroy() }
      else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 内存文档表：上传后按 docId 取用（赛制内够用；重启即失效） */
const docStore = new Map()

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end() }

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return json(res, 200, {
      ok: true,
      mode: 'real',
      model: config.llm.model,
      docs: docStore.size,
      uptime: Math.round(process.uptime()),
    })
  }

  if (req.method === 'GET' && url.pathname === '/api/docs') {
    return json(res, 200, [...docStore.values()].map((d) => ({ docId: d.docId, docName: d.docName, pageCount: d.pageCount })))
  }

  // 上传：支持两种方式
  //  1) multipart 太重，赛内不做 —— 用 JSON：{"docName":"x.txt","contentBase64":"..."} 或 {"docName":"x.txt","text":"..."}
  //  2) 前端读文件后 base64 传上来
  if (req.method === 'POST' && url.pathname === '/api/upload') {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}')
      const docName = body.docName ?? 'document.txt'
      const buffer = body.text !== undefined
        ? Buffer.from(body.text, 'utf-8')
        : Buffer.from(body.contentBase64 ?? '', 'base64')
      const docId = body.docId ?? randomUUID()
      const parsed = await parseDocument({ buffer, docName, docId })
      docStore.set(docId, parsed)
      log.info(`上传 ${docName} → ${parsed.blocks.length} blocks`)
      return json(res, 200, { docId, docName, pageCount: parsed.pageCount })
    } catch (err) {
      return json(res, 400, { error: err.message })
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/review') {
    let body
    try {
      body = JSON.parse((await readBody(req)).toString('utf-8') || '{}')
    } catch {
      return json(res, 400, { error: 'body 必须是 JSON' })
    }

    if (!body.docIds?.length && !body.docs?.length) {
      return json(res, 400, { error: 'docIds 不能为空', code: 'bad_request' })
    }

    const ac = new AbortController()
    res.on('close', () => { if (!res.writableEnded) ac.abort() })

    const sse = createSseWriter(res)
    try {
      const docs = (body.docIds ?? []).map((id) => docStore.get(id)).filter(Boolean)
      if (body.docIds?.length && docs.length === 0) {
        sse.send('error', { code: 'bad_request', message: '未找到对应文档，请先上传', retryable: false })
        return sse.close()
      }
      await runReview({ ...body, docs }, sse, ac.signal)
    } catch (err) {
      log.error(err)
      sse.send('error', { code: 'internal', message: err.message, retryable: !!err.retryable })
    } finally {
      sse.close()
    }
    return
  }

  json(res, 404, { error: 'not found' })
})

// 未捕获异常不能拖垮服务（赛场上进程一死就全没了）
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e))
process.on('uncaughtException', (e) => log.error('uncaughtException', e))

server.listen(config.port, config.host, () => {
  log.info(`archComply → http://localhost:${config.port}`)
  log.info(`  POST /api/review   POST /api/upload   GET /healthz   GET /api/docs`)
  log.info(`  model=${config.llm.model} base=${config.llm.baseURL} key=${config.llm.apiKey ? '已配置' : '未配置(offline)'}`)
})

export { server }
