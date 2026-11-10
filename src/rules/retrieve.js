// src/rules/retrieve.js —— 切片召回（B2 Owner）
// 目的：语义规则只给模型"相关几段"，不传全文。这是省 Token 的主要手段之一。

const STOP = new Set(['的', '和', '与', '及', '在', '为', '对', '并', '应', '须', '不得', '须', '中', '是', '有', 'the', 'and', 'of', 'to'])

/** 中英混排分词：英文按词，中文按 2-gram（不引入分词依赖，快且够用） */
export function tokenize(text) {
  const tokens = new Set()
  const lower = (text ?? '').toLowerCase()
  for (const w of lower.match(/[a-z0-9_.%]+/g) ?? []) if (w.length > 1) tokens.add(w)
  const cjk = lower.replace(/[^\u4e00-\u9fa5]/g, '')
  for (let i = 0; i < cjk.length - 1; i += 1) {
    const g = cjk.slice(i, i + 2)
    if (!STOP.has(g)) tokens.add(g)
  }
  return tokens
}

/**
 * 按条款标题 + 关键词 + 规则类型切片召回
 * @param {object} rule
 * @param {object} doc
 * @param {{maxBlocks?:number, maxChars?:number}} [opts]
 * @returns {Array<{blockId,page,text}>}
 */
export function retrieveContext(rule, doc, opts = {}) {
  const { maxBlocks = 4, maxChars = 6000 } = opts
  const query = tokenize(`${rule.title} ${rule.text} ${rule.condition} ${rule.type}`)
  if (query.size === 0) return doc.blocks.slice(0, maxBlocks)

  const scored = doc.blocks
    .map((b) => {
      const bt = tokenize(b.text)
      let score = 0
      for (const q of query) if (bt.has(q)) score += 1
      // 标题命中加权（条款标题通常就是段落小标题）
      if (rule.title && b.text.includes(rule.title)) score += query.size
      return { block: b, score: score / Math.sqrt(query.size) }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)

  const picked = []
  let chars = 0
  for (const { block } of scored) {
    if (picked.length >= maxBlocks) break
    if (chars + block.text.length > maxChars) break
    // 带上相邻段：条款与取值常被切成两段
    picked.push(block)
    chars += block.text.length
    const next = doc.blocks[doc.blocks.indexOf(block) + 1]
    if (next && picked.length < maxBlocks && !picked.includes(next)) {
      picked.push(next)
      chars += next.text.length
    }
  }
  return picked.map((b) => ({ blockId: b.blockId, page: b.page, text: b.text }))
}
