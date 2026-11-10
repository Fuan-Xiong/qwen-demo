// utils/markdown.js —— markdown-it 封装（F Owner）
// 单例初始化；导出 renderMarkdown(text) -> HTML 字符串。

import MarkdownIt from 'markdown-it'

const md = new MarkdownIt({
  html: false, // 不输出原始 HTML（防注入）
  linkify: true,
  breaks: true, // 换行即 <br>，适配流式消息
})

/**
 * 渲染 Markdown → HTML。
 * @param {string} [text]
 * @returns {string} HTML 字符串（非法输入按空串处理，不抛错）
 */
export function renderMarkdown(text) {
  return md.render(String(text ?? ''))
}
