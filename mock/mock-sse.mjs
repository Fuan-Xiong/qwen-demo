// mock/mock-sse.mjs —— 纯内存 Mock：按协议回放事件，零网络
// 用法（前端）：
//   import { mockRun } from '@/mock/mock-sse.mjs'
//   await mockRun({ docIds: ['doc-001'] }, { onEvent: (ev, data) => {...}, signal })
// 与真实 runReview 同签名，切换只改 import。

import { readFile } from 'node:fs/promises'

const FIXTURE = new URL('./fixtures/review-sample.json', import.meta.url)

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new DOMException('aborted', 'AbortError'))
    }, { once: true })
  })

export async function mockRun(req = {}, { onEvent = () => {}, signal, stepMs = 300 } = {}) {
  const result = JSON.parse(await readFile(FIXTURE, 'utf-8'))
  const emit = (event, data) => onEvent(event, data)

  try {
    emit('meta', {
      reviewId: result.reviewId,
      documents: result.documents,
      ruleTotal: result.summary.total,
      ruleSetId: req.ruleSetId ?? 'default',
      startedAt: Date.now(),
    })
    await sleep(stepMs, signal)

    const stages = [
      ['parse', '解析文档', 12],
      ['rules', '加载规则', 22],
      ['plan', '规划检查项', 38],
      ['execute', '逐条比对', 72],
      ['verify', '证据校验', 90],
      ['report', '生成报告', 100],
    ]
    for (const [stage, stageLabel, percent] of stages) {
      emit('progress', { stage, stageLabel, percent, detail: `${stageLabel}进行中` })
      emit('message', { role: 'assistant', channel: 'thinking', delta: `[${stageLabel}] ` })
      await sleep(stepMs, signal)
    }

    // 每条规则一条 rule_result；先发 fail/review（有卡片才好看），再发 pass
    const order = [...result.issues, ...result.coverage.items
      .filter(i => i.verdict === 'pass')
      .map(i => ({ ruleId: i.ruleId, verdict: 'pass', severity: 'low', method: 'deterministic', reason: '符合要求', confidence: 0.95, evidence: [] }))]

    for (const item of order) {
      emit('rule_result', { ...item, title: item.title ?? item.ruleId })
      emit('message', {
        role: 'assistant',
        channel: 'text',
        delta: `【${item.ruleId}】${item.verdict.toUpperCase()}：${item.reason}\n`,
        ruleId: item.ruleId,
      })
      emit('metrics', {
        tokenIn: Math.round(result.metrics.tokenIn * order.indexOf(item) / order.length),
        tokenOut: Math.round(result.metrics.tokenOut * order.indexOf(item) / order.length),
        tokenTotal: 0,
        durationMs: stepMs * (order.indexOf(item) + 6),
      })
      await sleep(stepMs, signal)
    }

    emit('result', { payload: result })
    await sleep(stepMs / 2, signal)
    emit('done', { reviewId: result.reviewId, status: result.status, durationMs: result.metrics.durationMs })
    return result
  } catch (err) {
    if (err?.name === 'AbortError') {
      emit('error', { code: 'aborted', message: '用户已中断', retryable: false, stage: 'execute' })
      return null
    }
    emit('error', { code: 'internal', message: String(err?.message ?? err), retryable: true })
    throw err
  }
}
