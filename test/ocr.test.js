// test/ocr.test.js —— OCR 模块测试（node:test + node:assert/strict）
// 覆盖：OCR 文本→块（页码/空行切段）、混合 PDF 文本层/扫描页分派与页序合并、
//      OCR 失败不伪造、图片入口缺端点配置时报带上下文错误。
// 注：本文件把 config.ocr 置为"缺端点"的确定状态，避免受 .env 影响（guard 兜底）。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { config } from '../src/config.js'
import { ocrTextToBlocks } from '../src/rules/parser/ocr.js'
import { extractHybridBlocks } from '../src/rules/parser/pdf.js'
import { parseDocument } from '../src/rules/parser/index.js'

// 所有用例都基于"OCR 端点缺配置"的确定性错误，不依赖 .env 是否有 OCR_BASE_URL
config.ocr.baseURL = ''
config.ocr.enabled = true

// ── OCR 文本 → 裸块 ────────────────────────────────────

test('ocrTextToBlocks：空行切段 + 页码注入', () => {
  const blocks = ocrTextToBlocks('第一条 报价有效期\n\n报价有效期不得少于 90 天。\n\n2. 设备清单，含设备 A、设备 B。', 3)
  assert.equal(blocks.length, 3)
  assert.deepEqual(blocks.map((b) => b.type), ['paragraph', 'paragraph', 'paragraph'])
  assert.ok(blocks.every((b) => b.page === 3))
  assert.equal(blocks[0].text, '第一条 报价有效期')
  assert.equal(blocks[1].text, '报价有效期不得少于 90 天。')
})

test('ocrTextToBlocks：空文本 → 空数组', () => {
  assert.deepEqual(ocrTextToBlocks('   \r\n  ', 1), [])
})

// ── 混合 PDF：文本层页 vs 扫描页 ─────────────────────────

test('extractHybridBlocks：文本层页走 pdfjs、扫描页走 OCR，按页码合并', async () => {
  const fakeDoc = {
    numPages: 3,
    getPage: async (n) => ({
      getTextContent: async () =>
        n === 2
          ? { items: [] } // 第 2 页无文本层 → 触发 OCR
          : { items: [{ str: `第 ${n} 页文本内容`, transform: [1, 0, 0, 1, 50, 700], width: 90, height: 10, hasEOL: true }] },
    }),
  }
  const ocrCalls = []
  const blocks = await extractHybridBlocks(fakeDoc, {
    minTextChars: 5,
    renderPage: async () => Buffer.from('fake-png'),
    ocrFn: async ({ buffer, mime, page }) => {
      ocrCalls.push({ page, mime, bytes: buffer.length })
      return { text: '第 2 页是扫描件，需要 OCR 提取。' }
    },
  })
  assert.deepEqual(blocks.map((b) => b.page), [1, 2, 3])
  assert.equal(blocks[0].text, '第 1 页文本内容')
  assert.equal(blocks[1].text, '第 2 页是扫描件，需要 OCR 提取。')
  assert.equal(blocks[2].text, '第 3 页文本内容')
  assert.deepEqual(ocrCalls, [{ page: 2, mime: 'image/png', bytes: 8 }])
})

test('extractHybridBlocks：全部有文本层时一次 OCR 都不调', async () => {
  const fakeDoc = {
    numPages: 2,
    getPage: async () => ({
      getTextContent: async () => ({ items: [{ str: '内容', transform: [1, 0, 0, 1, 50, 700], width: 80, height: 10, hasEOL: true }] }),
    }),
  }
  let ocrCalled = false
  const blocks = await extractHybridBlocks(fakeDoc, {
    minTextChars: 1,
    ocrFn: async () => { ocrCalled = true; return { text: 'x' } },
  })
  assert.equal(blocks.length, 2)
  assert.equal(ocrCalled, false)
})

test('extractHybridBlocks：OCR 页失败向上抛，不伪造空块', async () => {
  const fakeDoc = {
    numPages: 1,
    getPage: async () => ({ getTextContent: async () => ({ items: [] }) }),
  }
  await assert.rejects(
    extractHybridBlocks(fakeDoc, {
      minTextChars: 5,
      renderPage: async () => Buffer.from('png'),
      ocrFn: async () => { throw new Error('OCR 端点不可达') },
    }),
    /OCR 端点不可达/,
  )
})

// ── 主入口：图片分派 ────────────────────────────────────

test('parseDocument：图片扩展名进入 OCR，缺端点配置时报带上下文错误', async () => {
  await assert.rejects(
    parseDocument({ docName: '合同截图.png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }),
    /OCR/,
  )
})