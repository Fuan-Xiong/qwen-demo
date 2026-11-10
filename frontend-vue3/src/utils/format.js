// utils/format.js —— 展示格式化（F Owner）
// 导出 formatMs / formatTokens / severityLabel / statusLabel

/**
 * 毫秒 → 可读时长。
 * @param {number} ms
 * @returns {string} '120ms' | '1.2s'
 */
export function formatMs(ms) {
  const n = Number(ms) || 0
  if (n < 1000) return `${n}ms`
  return `${(n / 1000).toFixed(1)}s`
}

/**
 * Token 数 → 可读文本（过万显示 x.x 万）。
 * @param {number} n
 * @returns {string}
 */
export function formatTokens(n) {
  const v = Number(n) || 0
  if (v >= 10000) return `${(v / 10000).toFixed(1)}万`
  return String(v)
}

/** 严重级别 → 中文标签 */
export function severityLabel(severity) {
  return { high: '高', medium: '中', low: '低' }[severity] ?? severity ?? '—'
}

/** 结果状态 → 中文标签 */
export function statusLabel(status) {
  const map = {
    pass: '合规',
    fail: '不合规',
    review: '需复核',
    not_applicable: '不适用',
    pending: '待执行',
    done: '已完成',
  }
  return map[status] ?? status ?? '—'
}
