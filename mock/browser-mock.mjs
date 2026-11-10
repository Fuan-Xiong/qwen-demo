// mock/browser-mock.mjs —— 浏览器可直接用的 Mock（无 node:fs，纯打包友好）
// 用途：前端 Vite 里 import { mockRun } 即可回放，无需起服务、无需 node 内建模块。
// 数据源：./fixtures/review-sample.js（与 review-sample.json 同源，改数据请两处同步或用脚本生成）

import { sample } from './fixtures/review-sample.js'

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
  const result = JSON.parse(JSON.stringify(sample))
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

    const passes = result.coverage.items
      .filter((i) => i.verdict === 'pass')
      .map((i) => ({
        ruleId: i.ruleId, verdict: 'pass', severity: 'low', method: 'deterministic',
        reason: '符合要求', confidence: 0.95, evidence: [],
      }))
    const order = [...result.issues, ...passes]

    for (let n = 0; n < order.length; n += 1) {
      const item = order[n]
      emit('rule_result', { ...item, title: item.title ?? item.ruleId })
      emit('message', {
        role: 'assistant', channel: 'text', ruleId: item.ruleId,
        delta: `【${item.ruleId}】${item.verdict.toUpperCase()}：${item.reason}\n`,
      })
      emit('metrics', {
        tokenIn: Math.round((result.metrics.tokenIn * n) / order.length),
        tokenOut: Math.round((result.metrics.tokenOut * n) / order.length),
        tokenTotal: Math.round((result.metrics.tokenTotal * n) / order.length),
        durationMs: stepMs * (n + 6),
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
