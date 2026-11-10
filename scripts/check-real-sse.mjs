// scripts/check-real-sse.mjs —— 端到端 SSE 断言（测试执行工程师用）
// 解析 /tmp/real.sse，对照 /tmp/real_req.json 的 ruleManifest 数量做断言
import { readFileSync } from 'node:fs'

const raw = readFileSync('/tmp/real.sse', 'utf8')
const req = JSON.parse(readFileSync('/tmp/real_req.json', 'utf8'))
const ruleCount = req.ruleManifest.length

const events = []
for (const frame of raw.split('\n\n')) {
  const m = frame.match(/^event: (.+)\n(?:data: (.+))?/)
  if (m) events.push({ event: m[1], data: m[2] ? JSON.parse(m[2]) : null })
}

const counts = {}
for (const e of events) counts[e.event] = (counts[e.event] ?? 0) + 1

let failCount = 0
const check = (name, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${extra ? `(${extra})` : ''}`)
  if (!pass) failCount++
}

check('有 run_started', (counts.run_started ?? 0) === 1, `count=${counts.run_started ?? 0}`)
check('至少 1 条 result', (counts.result ?? 0) >= 1, `count=${counts.result ?? 0}`)
check('有 done 且只 1 条', (counts.done ?? 0) === 1, `count=${counts.done ?? 0}`)
check('无 error', (counts.error ?? 0) === 0, `count=${counts.error ?? 0}`)

const done = events.find((e) => e.event === 'done')
check('done.coverage.total === ruleManifest.length', done?.data?.coverage?.total === ruleCount,
  `total=${done?.data?.coverage?.total}`)
check('done.metrics.tokens.total > 0', (done?.data?.metrics?.tokens?.total ?? 0) > 0,
  `total=${done?.data?.metrics?.tokens?.total}`)

const results = events.filter((e) => e.event === 'result').map((e) => e.data)
const missing = results.filter((r) => !r.ruleId || !r.status || !Array.isArray(r.evidence))
check('每条 result 有 ruleId/status/evidence 数组', missing.length === 0, `bad=${missing.length}`)
const failNoEv = results.filter((r) => r.status === 'fail' && (!r.evidence || r.evidence.length === 0))
check('status=fail 的 result evidence 非空', failNoEv.length === 0, `bad=${failNoEv.length}(${failNoEv.map((r) => r.ruleId).join(',')})`)
const reviewNoReason = results.filter((r) => r.status === 'review' && !r.reason)
check('status=review 的 result reason 非空', reviewNoReason.length === 0, `bad=${reviewNoReason.length}`)

console.log('\n=== 事件序列 ===')
console.log(Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(' → '))
console.log('\n=== 每条 result ===')
for (const r of results) {
  console.log(`  ${r.ruleId} ${r.status} evidence=${r.evidence?.length ?? 0} reason=${r.reason ?? ''}`)
}
console.log('\n=== done.metrics ===')
console.log(JSON.stringify(done?.data?.metrics ?? null, null, 2))
console.log('\n=== done.coverage ===')
console.log(JSON.stringify(done?.data?.coverage ?? null, null, 2))
console.log(`\n=== 结果: ${failCount === 0 ? '全部 PASS' : `${failCount} 项 FAIL`} ===`)
process.exitCode = failCount > 0 ? 1 : 0
