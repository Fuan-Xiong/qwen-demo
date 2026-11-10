// mock/sse-server.mjs —— 本地假后端（协议与真实服务完全一致）
// 启动： node mock/sse-server.mjs        （默认 8787）
// 前端把 BASE 改成 http://localhost:8787 即可，其余代码一行不改。
// 支持： POST /api/review（SSE 流）、POST /api/upload（假上传）、GET /healthz

import http from 'node:http'
import { mockRun } from './mock-sse.mjs'

const PORT = Number(process.env.PORT ?? 8787)

const sse = (res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  })
  res.flushHeaders?.()
}

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

const send = (res, event, data) => {
  if (!res.writableEnded) res.write(frame(event, data))
}

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) }
    })
  })

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
    })
    return res.end()
  }

  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, mode: 'mock' }))
  }

  if (req.method === 'POST' && req.url === '/api/upload') {
    const body = await readBody(req)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    return res.end(JSON.stringify({ docId: body.docId ?? 'doc-001', docName: body.docName ?? '投标合同样本.pdf', pageCount: 12 }))
  }

  if (req.method === 'POST' && req.url === '/api/review') {
    const body = await readBody(req)
    sse(res)
    const ac = new AbortController()
    // 客户端断开 = 用户中断，必须停掉 harness（真实服务同样要监听）
    req.on('close', () => ac.abort())

    try {
      await mockRun(body, {
        signal: ac.signal,
        stepMs: Number(process.env.MOCK_STEP_MS ?? 300),
        onEvent: (event, data) => send(res, event, data),
      })
    } catch {
      send(res, 'error', { code: 'internal', message: 'mock 内部异常', retryable: true })
    } finally {
      res.end()
    }
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

server.listen(PORT, () => {
  console.log(`[mock] SSE mock server → http://localhost:${PORT}`)
  console.log(`[mock] POST /api/review  POST /api/upload  GET /healthz`)
})
