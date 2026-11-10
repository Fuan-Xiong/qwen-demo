// scripts/try-parse.js —— 单文档解析验证工具（测试执行工程师用）
// 用法: node scripts/try-parse.js <path> <docId>
// 输出: metrics(blockCount/pageCount/elapsedMs) / warnings / 前3block / 偏移反校验 / JSON 可序列化
// OCR_REQUIRED（扫描件）标记为预期，不视为失败
import { parseDocumentSkill } from '../skills/parse-document/index.js'

const [path = '', docId = 'doc'] = process.argv.slice(2)
if (!path) {
  console.error('用法: node scripts/try-parse.js <path> <docId>')
  process.exit(2)
}

const t0 = Date.now()
const out = await parseDocumentSkill({ documents: [{ docId, docName: path.split('/').pop(), path }] }, {})
const elapsedMs = Date.now() - t0

const doc = out?.documents?.[0]
if (!out?.ok || !doc) {
  const reason = typeof doc?.reason === 'string' ? doc.reason : JSON.stringify(out?.error ?? out)
  const code = reason.split('：')[0]
  if (code === 'OCR_REQUIRED') {
    console.log(JSON.stringify({ docId, 预期: 'OCR_REQUIRED（扫描件）', elapsedMs, detail: reason }, null, 2))
    process.exit(0)
  }
  console.error(JSON.stringify({ docId, ok: false, error: out?.error ?? { code: code || 'PARSE_FAILED', message: reason } }, null, 2))
  process.exit(1)
}

const blocks = doc.blocks ?? []
const fullText = doc.fullText ?? ''
const misalign = blocks.filter((b) => fullText.slice(b.charStart, b.charEnd) !== b.text).length
let jsonOk = 'OK'
try { JSON.stringify(out) } catch (e) { jsonOk = `FAIL: ${e.message}` }

console.log(JSON.stringify({
  docId,
  docName: doc.docName,
  metrics: { blockCount: blocks.length, pageCount: doc.pageCount ?? null, elapsedMs },
  warnings: doc.warnings ?? [],
  firstBlocks: blocks.slice(0, 3).map((b) => ({ blockId: b.blockId, page: b.page, charStart: b.charStart, charEnd: b.charEnd, text: b.text.slice(0, 40) })),
  偏移反校验: misalign === 0 ? `OK: ${blocks.length} blocks 全部对齐` : `FAIL: ${misalign}/${blocks.length} blocks 不对齐`,
  jsonSerializable: jsonOk,
}, null, 2))
