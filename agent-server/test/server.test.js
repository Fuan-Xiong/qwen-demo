// agent-server/test/server.test.js —— HTTP 骨架测试（node:test + node:assert/strict）
// 覆盖：/health 200、CORS 预检、/api/review 与 /api/review/abort 501 占位、404、
//       缺 QWEN_API_KEY / MODEL_NAME 时启动失败（子进程验证 fail fast）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// env.js 顶层 fail fast：先注入测试必填项，再动态加载 server.js（静态 import 会先执行）
process.env.QWEN_API_KEY = process.env.QWEN_API_KEY ?? 'test-key'
process.env.MODEL_NAME = process.env.MODEL_NAME ?? 'test-model'
const { createApp } = await import('../src/server.js')

const SERVER_FILE = fileURLToPath(new URL('../src/server.js', import.meta.url))

/** 起一个随机端口的临时实例，用完即关 */
async function withServer(fn) {
  const server = createApp()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  try {
    return await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

test('GET /health → 200，body 与 CORS 头正确', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    const body = await res.json()
    assert.equal(body.status, 'ok')
    assert.equal(body.service, 'agent-server')
    assert.ok(typeof body.time === 'string' && body.time.length > 0)
  })
})

test('OPTIONS 预检 → 204 且带 CORS 头', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/review`, { method: 'OPTIONS' })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    assert.match(res.headers.get('access-control-allow-methods') ?? '', /POST/)
  })
})

test('POST /api/review → SSE 事件流（run_started/progress/warning/metrics/done）', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docIds: ['doc-001'], ruleSetId: 'default' }),
    })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/)
    const body = await res.text()
    // 完整状态机跑通：首帧 run_started，末帧 done
    assert.match(body, /event: run_started/)
    assert.match(body, /event: progress/)
    assert.match(body, /event: done/)
    // data 为单行 JSON 的帧格式
    assert.match(body, /event: done\ndata: \{.*runId.*\}\n\n$/)
    const doneFrame = body.split('event: done\ndata: ')[1]
    assert.doesNotThrow(() => JSON.parse(doneFrame.trim()), 'done data 必须是合法 JSON')
    // metrics 含 tokens/elapsedMs/stages/rules（检查 4 契约）
    const metricsFrame = body.split('\n\n').find((f) => f.startsWith('event: metrics'))
    const metrics = JSON.parse(metricsFrame.split('\ndata: ')[1])
    for (const key of ['tokens', 'elapsedMs', 'stages', 'rules']) {
      assert.ok(key in metrics, `metrics 缺字段 ${key}`)
    }
  })
})

test('POST /api/review：非法 JSON → 400 BAD_REQUEST', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/review`, { method: 'POST', body: 'not-json' })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.error.code, 'BAD_REQUEST')
  })
})

test('POST /api/review/abort：缺 runId → 400；无进行中评审 → 404', async () => {
  await withServer(async (base) => {
    const r1 = await fetch(`${base}/api/review/abort`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(r1.status, 400)
    assert.equal((await r1.json()).error.code, 'BAD_REQUEST')

    const r2 = await fetch(`${base}/api/review/abort`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: 'rv-no-such-run' }) })
    assert.equal(r2.status, 404)
    assert.equal((await r2.json()).error.code, 'RUN_NOT_FOUND')
  })
})

test('未知路由 → 404 统一 JSON', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/no/such/route`)
    assert.equal(res.status, 404)
    const body = await res.json()
    assert.equal(body.error.code, 'NOT_FOUND')
  })
})

/** 以指定环境变量启动子进程运行 src/server.js，等待退出 */
function runServerWithEnv(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER_FILE], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }))
  })
}

/** 以指定环境变量启动子进程，等 stdout 出现就绪标记后返回控制句柄（不等待退出） */
function runServerUntilReady(env, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_FILE], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill('SIGKILL'); reject(new Error(`启动超时，stderr=${stderr}`)) }
    }, timeoutMs)
    const exited = new Promise((res) => child.on('exit', (code) => { clearTimeout(timer); res(code) }))
    child.stdout.on('data', (d) => {
      stdout += d
      if (!settled && stdout.includes('agent-server listening')) {
        settled = true
        clearTimeout(timer)
        resolve({ kill: () => child.kill('SIGTERM'), exited })
      }
    })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err) } })
  })
}

test('缺 QWEN_API_KEY → 启动失败（退出码非 0，stderr 报变量名）', async () => {
  const env = { ...process.env }
  delete env.QWEN_API_KEY
  const { code, stderr } = await runServerWithEnv(env)
  assert.notEqual(code, 0)
  assert.match(stderr, /QWEN_API_KEY/)
})

test('缺 MODEL_NAME → 启动失败（退出码非 0，stderr 报变量名）', async () => {
  const env = { ...process.env }
  delete env.MODEL_NAME
  const { code, stderr } = await runServerWithEnv(env)
  assert.notEqual(code, 0)
  assert.match(stderr, /MODEL_NAME/)
})

test('必填齐全 → 启动并监听，SIGTERM 优雅退出码 0', async () => {
  const ctl = await runServerUntilReady({ ...process.env })
  assert.ok(ctl, '服务应在超时内打印 listening')
  ctl.kill()
  assert.equal(await ctl.exited, 0)
})