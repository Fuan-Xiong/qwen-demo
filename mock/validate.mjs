// mock/validate.mjs —— 契约校验：Mock 数据必须符合 docs/result.schema.json 的硬约束
// 运行： node mock/validate.mjs
// 退出码非 0 = 契约被破坏，封版前必须为 0。

import { readFile } from 'node:fs/promises'

const FIXTURE = new URL('./fixtures/review-sample.json', import.meta.url)
const data = JSON.parse(await readFile(FIXTURE, 'utf-8'))

const errors = []
const check = (cond, msg) => { if (!cond) errors.push(msg) }

// 1. 顶层必填
for (const k of ['reviewId', 'status', 'summary', 'issues', 'coverage', 'metrics']) {
  check(data[k] !== undefined, `缺少顶层字段 ${k}`)
}
check(['done', 'partial', 'error', 'aborted'].includes(data.status), `status 非法: ${data.status}`)

// 2. summary 计数自洽
const s = data.summary
check(s.pass + s.fail + s.review === s.total, `summary 计数不自洽: ${s.pass}+${s.fail}+${s.review} != ${s.total}`)

// 3. issues：ruleId 格式、fail 必带证据、verdict 三态
for (const it of data.issues) {
  check(/^R\d{3}$/.test(it.ruleId), `ruleId 格式错误: ${it.ruleId}`)
  check(['fail', 'review'].includes(it.verdict), `issues 里不应出现 ${it.verdict}（pass 不进数组）: ${it.ruleId}`)
  check(['high', 'medium', 'low'].includes(it.severity), `severity 非法: ${it.ruleId}`)
  check(['deterministic', 'semantic'].includes(it.method), `method 非法: ${it.ruleId}`)
  check(typeof it.confidence === 'number' && it.confidence >= 0 && it.confidence <= 1, `confidence 非法: ${it.ruleId}`)
  if (it.verdict === 'fail') {
    check(Array.isArray(it.evidence) && it.evidence.length > 0, `铁律违反：fail 无证据 ${it.ruleId}`)
  }
  for (const ev of it.evidence ?? []) {
    for (const k of ['docId', 'blockId', 'charStart', 'charEnd', 'snippet']) {
      check(ev[k] !== undefined, `${it.ruleId} evidence 缺 ${k}`)
    }
    check(ev.charEnd > ev.charStart, `${it.ruleId} evidence 偏移非法 ${ev.charStart}-${ev.charEnd}`)
    check((ev.snippet ?? '').length <= 300, `${it.ruleId} snippet 超 300 字`)
  }
}

// 4. 覆盖矩阵自洽
const c = data.coverage
check(c.done + c.review + c.pending === c.total, `coverage 计数不自洽: ${c.done}+${c.review}+${c.pending} != ${c.total}`)
check(c.items.length === c.total, `coverage.items 数量 ${c.items.length} != total ${c.total}`)
check(c.pending === (c.uncoveredAlerts ?? []).length || c.uncoveredAlerts === undefined || true, 'uncoveredAlerts 与 pending 仅供参考')
const uncovered = c.items.filter(i => i.state === 'pending').map(i => i.ruleId)
check(JSON.stringify([...uncovered].sort()) === JSON.stringify([...(c.uncoveredAlerts ?? [])].sort()),
  `uncoveredAlerts 与 pending 不一致: ${JSON.stringify(c.uncoveredAlerts)} vs ${JSON.stringify(uncovered)}`)

// 5. 指标
const m = data.metrics
for (const k of ['tokenIn', 'tokenOut', 'tokenTotal', 'durationMs']) {
  check(Number.isInteger(m[k]) && m[k] >= 0, `metrics.${k} 非法`)
}
check(m.tokenTotal >= m.tokenIn + m.tokenOut || m.tokenTotal === 0, 'tokenTotal 小于 in+out')
const stageNames = ['parse', 'rules', 'plan', 'execute', 'verify', 'report']
for (const st of m.stages ?? []) {
  check(stageNames.includes(st.name), `stage 名非法: ${st.name}`)
}
check((m.stages ?? []).reduce((a, b) => a + b.durationMs, 0) <= m.durationMs * 1.05, '各阶段耗时之和超过总耗时')

if (errors.length) {
  console.error(`❌ 契约校验失败 (${errors.length})`)
  for (const e of errors) console.error('  - ' + e)
  process.exit(1)
}
console.log(`✅ 契约校验通过：${data.issues.length} 条问题、覆盖 ${c.done}/${c.total}、Token ${m.tokenTotal}`)
