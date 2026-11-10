// scripts/verify-real-docs.mjs —— real-docs 解析质量校验（测试执行工程师用）
// 读取 data/real-docs/manifest.json，对每个文档断言解析质量；OCR_REQUIRED（扫描件）视为预期
// 断言项: blocks>0 / 偏移对齐 / blockId 唯一 / docx page null+页码 warning / pdf page 范围+bbox /
//         重复解析 blockId 一致 / JSON 可序列化
import { readFileSync } from 'node:fs'
import { parseDocumentSkill } from '../skills/parse-document/index.js'

const manifest = JSON.parse(readFileSync('data/real-docs/manifest.json', 'utf8'))
let failCount = 0

for (const item of manifest.documents ?? []) {
  const checks = []
  const check = (name, pass, extra = '') => {
    checks.push({ name, pass: !!pass, extra })
    if (!pass) failCount++
  }
  const input = { documents: [{ docId: item.docId, docName: item.docName, path: item.path }] }
  const out = await parseDocumentSkill(input, {})
  const doc = out?.documents?.[0]

  if (!out?.ok || !doc) {
    const reason = typeof doc?.reason === 'string' ? doc.reason : JSON.stringify(out?.error ?? out)
    const code = reason.split('：')[0]
    if (code === 'OCR_REQUIRED') {
      console.log(`[${item.docId}] 预期: OCR_REQUIRED（扫描件），跳过块断言`)
      continue
    }
    console.log(`[${item.docId}] FAIL: 解析失败 ${reason}`)
    failCount++
    continue
  }

  const blocks = doc.blocks ?? []
  const fullText = doc.fullText ?? ''
  const ids = blocks.map((b) => b.blockId)

  check('blocks.length > 0', blocks.length > 0, `count=${blocks.length}`)
  check('偏移对齐', blocks.every((b) => fullText.slice(b.charStart, b.charEnd) === b.text), `blocks=${blocks.length}`)
  check('blockId 唯一', new Set(ids).size === ids.length, `count=${ids.length}`)

  if (/\.docx$/i.test(item.docName)) {
    check('docx page 全为 null', blocks.every((b) => b.page === null))
    check('docx 有页码 warning', (doc.warnings ?? []).some((w) => /no_page_info|page/i.test(JSON.stringify(w))))
  } else if (/\.pdf$/i.test(item.docName)) {
    check('pdf page 在 1..pageCount', blocks.every((b) => Number.isInteger(b.page) && b.page >= 1 && b.page <= (doc.pageCount ?? 0)), `pageCount=${doc.pageCount}`)
    check('pdf 有 bbox', blocks.every((b) => b.bbox && typeof b.bbox === 'object' && ['x0', 'top', 'x1', 'bottom'].every((k) => typeof b.bbox[k] === 'number')))
  }

  const out2 = await parseDocumentSkill(input, {})
  const ids2 = out2?.documents?.[0]?.blocks?.map((b) => b.blockId) ?? []
  check('重复解析 blockId 列表一致', JSON.stringify(ids) === JSON.stringify(ids2))

  let jsonOk = true
  try { JSON.stringify(out) } catch { jsonOk = false }
  check('JSON.stringify 不抛错', jsonOk)

  console.log(`[${item.docId}] ${checks.map((c) => `${c.pass ? 'PASS' : 'FAIL'}:${c.name}${c.extra ? `(${c.extra})` : ''}`).join('  ')}`)
}

console.log(`\n=== 结果: ${failCount === 0 ? '全部 PASS' : `${failCount} 项 FAIL`} ===`)
process.exitCode = failCount > 0 ? 1 : 0
