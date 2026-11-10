// src/cli.js —— 命令行跑一次评审（不启服务也能验链路）
// 用法：
//   node src/cli.js                       # 用内存演示文档（无需上传）
//   node src/cli.js path/to/合同.docx      # 解析真实文件并评审
// 输出：与 SSE 同协议的事件（便于对照 docs/sse-events.md）

import { parseFile } from './rules/parser/index.js'
import { runReview } from './harness/harness.js'

const file = process.argv[2]
const sse = {
  send(event, data) {
    if (event === 'message') {
      const d = data.delta ?? ''
      process.stdout.write(data.channel === 'thinking' ? `\x1b[90m${d}\x1b[0m` : d)
      return
    }
    if (event === 'progress') {
      process.stdout.write(`\r[${data.percent}%] ${data.stageLabel} ${data.detail ?? ''}\x1b[K`)
      return
    }
    if (event === 'metrics') return
    if (event === 'result') {
      const p = data.payload
      console.log(`\n\n=== 结论 ${p.summary.conclusion}`)
      console.log(`=== 覆盖 ${p.coverage.done}/${p.coverage.total}（未覆盖: ${p.coverage.uncoveredAlerts.join(',') || '无'}）`)
      for (const i of p.issues) {
        console.log(` - ${i.ruleId} ${i.verdict.toUpperCase()} [${i.severity}] ${i.reason}`)
        for (const e of i.evidence ?? []) console.log(`     ↳ ${e.blockId} p${e.page} ${JSON.stringify(e.snippet)}`)
      }
      console.log(`=== Token ${p.metrics.tokenIn}/${p.metrics.tokenOut}  耗时 ${p.metrics.durationMs}ms`)
      return
    }
    if (event === 'error') { console.error(`\n[error] ${data.code} ${data.message}`); return }
    if (event === 'done') { console.log(`\n[done] ${data.status}`); return }
  },
}

const docs = file ? [await parseFile(file)] : []
await runReview({ docs, mode: 'demo' }, sse, new AbortController().signal)
