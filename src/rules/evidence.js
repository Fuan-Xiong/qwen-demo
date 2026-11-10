// src/rules/evidence.js —— 证据定位（B2 Owner）
// 交付标准：输出 docId / docName / page / blockId / charStart / charEnd / snippet
// 原则：模型只给"片段文本"，服务端用 blockId + 原文反查回填精确偏移；回填失败 = 证据不成立。

const MAX_SNIPPET = 300

/**
 * @param {object} doc   parseDocument 的返回值
 * @param {object} hint  { blockId?, snippet? }
 * @returns {object|null}
 */
export function findEvidence(doc, hint = {}) {
  const { blockId, snippet = '' } = hint
  const needle = normalize(snippet)

  // 1) 指定 blockId：只在块内定位（最可信）
  if (blockId) {
    const block = doc.blocks.find((b) => b.blockId === blockId)
    if (block) {
      const span = locate(block.text, needle)
      return build(doc, block, span, snippet)
    }
  }
  if (!needle) return null

  // 2) 未指定/找不到 blockId：全文按片段搜第一个命中
  for (const block of doc.blocks) {
    const span = locate(block.text, needle)
    if (span) return build(doc, block, span, snippet)
  }

  // 3) 片段可能跨段（模型常把两段拼起来）：退化为"首个非空行"匹配
  const firstLine = normalize(needle.split('\n')[0])
  if (firstLine && firstLine.length >= 6) {
    for (const block of doc.blocks) {
      const span = locate(block.text, firstLine)
      if (span) return build(doc, block, span, firstLine)
    }
  }
  return null
}

function locate(text, needle) {
  const direct = text.indexOf(needle)
  if (direct >= 0) return { start: direct, end: direct + needle.length }
  // 容错：去空白后再找，再映射回原坐标（保留真实偏移）
  const compact = text.replace(/\s+/g, '')
  const cNeedle = needle.replace(/\s+/g, '')
  if (cNeedle && compact.includes(cNeedle)) {
    let ci = 0
    let start = -1
    let end = -1
    for (let i = 0; i < text.length; i += 1) {
      if (/\s/.test(text[i])) continue
      if (start < 0 && ci === compact.indexOf(cNeedle)) start = i
      ci += 1
      if (start >= 0 && ci === compact.indexOf(cNeedle) + cNeedle.length) { end = i + 1; break }
    }
    if (start >= 0 && end > start) return { start, end }
  }
  return null
}

function build(doc, block, span, rawSnippet) {
  if (!span) return null
  const snippet = (rawSnippet || block.text.slice(span.start, span.end)).slice(0, MAX_SNIPPET)
  return {
    docId: doc.docId,
    docName: doc.docName,
    page: block.page,
    blockId: block.blockId,
    charStart: span.start,
    charEnd: span.end,
    snippet,
  }
}

const normalize = (s) => (s ?? '').replace(/\u00a0/g, ' ').trim()
