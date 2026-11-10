# parse-document 模块交接文档（封版 v1）

> 交接方：B2（解析与规则引擎）｜交接日期：2026-10-24 ｜ 状态：封版检查通过
> 位置：`skills/parse-document/`（自包含技能，**不依赖 `src/rules/parser`**）

## 1. 用途

把合同/标书文档（`.docx` / `.pdf`，二进制或本地路径）解析为**统一 Block 结构**：

- `fullText` 全文纯文本（块间以 `\n` 连接）+ 全局字符偏移 `charStart/charEnd`（左闭右开）
- `blockId = md5(docId + ":" + blockIndex + ":" + heading + ":" + text)`（heading 为 null 按空串）
- 分类 `paragraph / heading / table / table_cell / list_item` + 章节标题归属 `heading`
- PDF：1-based 页码 + 近似 `bbox`；DOCX：`page = null`（无真实分页）
- 结果作为规则核查、切片召回、证据定位的**输入地基**，本身不做合规判定

## 2. 导出签名

### 主入口（编排层）`skills/parse-document/index.js`

```js
async function parseDocumentSkill(input, ctx = {}) 
// input（二选一形态）：
//   { documents: [{ docId?, docName, path|base64|contentBase64|text }], maxConcurrency? }
//   { docId?, docName, path|base64|contentBase64|text, maxConcurrency? }   // 单文档简写
// ctx: { maxConcurrency? }（默认 2，分批并发，结果顺序与输入一致）
// -> Promise<{ ok, documents, metrics }>
//    documents[i]：成功 = ParsedDoc（docId/docName/pageCount/fullText/separator/blocks/warnings）
//                  失败 = { ok:false, reason }（reason 含错误码，如 PARSE_FAILED：…）
//    documents[i].warnings 为该文档自己的解析告警（可为空数组）
//    metrics：{ total, success, failed, durationMs, warnings[] }
//    整调用级失败（输入非法/调度异常）：{ ok:false, error:{ code, message, detail } }
```
- 内容来源**四选一**：`path`（本地路径）、`base64` / `contentBase64`（二进制 Base64，二名等价）、`text`（纯文本，当前入口对 txt/md 返回 UNSUPPORTED_FORMAT）
- `docId` 缺失时按文件内容 md5 自动生成，并记 `docid_generated` 告警；告警汇总在 `metrics.warnings`
- 单文档失败不中断同批其他文档；`ok = (failed === 0)`

### 解析器（单文件级）

```js
// parsers/docx.js —— mammoth.convertToHtml + cheerio
parseDocx(filePath, { docId, docName }) -> Promise<{ blocks, fullText, pageCount, warnings }>
// parsers/pdf.js —— pdfjs-dist legacy build
parsePdf(filePath, { docId, docName, includeBbox = true }) 
  -> Promise<{ blocks, fullText, pageCount, warnings }>
//   page 1-based；无文本层（扫描件）抛 SkillError('OCR_REQUIRED')；多栏 → warning multi_column + 按列拆分
```

### 工具（utils/）

```js
// utils/block.js：md5Hex / makeBlockId / buildFullText（slice 反校验）/ normalizeText / finalizeBlocks(rawBlocks, {docId, docName, fileType, pageCount}) -> {blocks, fullText, separator, pageCount, warnings}
// utils/errors.js：SkillError(code, message, detail)；toSkillError(err, fallbackCode, {forceCode})
```

### MCP stdio 服务 `mcp/server.js`

```bash
node skills/parse-document/mcp/server.js
# tool 名 parse_document；inputSchema 读取 schema.input.json（单文档形状）；
# 工具结果 = JSON 文本（信封结构）；失败不抛协议错误
```

## 3. 测试命令

```bash
npm test                 # 推荐：node --test 全量发现，当前 40 用例全绿
# 等价：node --test；或 node --test 'test/**/*.test.js'
# 注意：node --test test/（目录参数）在 Node 24.14.0 会报 Cannot find module '.../test'，请用上面两种形式
npm run check            # mock 契约校验 + 全文件语法检查
```

## 4. 已知限制

| 限制 | 说明 |
|---|---|
| 仅 docx/pdf | 入口未注册 txt/md 解析器，`text` 输入与 .txt/.md 扩展名返回 `UNSUPPORTED_FORMAT` |
| docx 无分页 | `page = null`、`pageCount = 0`（不估算） |
| 扫描件 PDF | 全文无文本层 → `OCR_REQUIRED`，不猜测内容 |
| bbox 为近似值 | PDF 用户空间坐标（y 向上），按基线 ±0.8h/0.2h 估算，非精确字形边界 |
| 表格文本重复 | 同一表格产出 table 块 + 逐格 table_cell 块，单元格文本在 fullText 出现两次（证据定位按 blockId 优先） |
| warnings 双出口 | `documents[i].warnings`（该文档解析告警，可为空数组）；`metrics.warnings`（全批汇总，含 `docid_generated`） |
| MCP 仅单文档 | tool inputSchema 即 schema.input.json（无 documents/maxConcurrency）；批量解析请直接 import `parseDocumentSkill` |
| pdfjs v6 API | 清理必须用 loading task 的 `task.destroy()`（PDFDocumentProxy 已无 destroy） |

## 5. Harness 集成方式（B1）

### 方式 A：直接 import（推荐，批量、低延迟）

```js
import { parseDocumentSkill } from './skills/parse-document/index.js'

const res = await parseDocumentSkill({
  maxConcurrency: 2,
  documents: [
    { docName: '投标书.docx', contentBase64: buf1.toString('base64') }, // 或 path
    { docName: '合同.pdf', contentBase64: buf2.toString('base64') },
  ],
})
// res.ok === true → 全部成功
// res.documents[i].fullText（全文，仅作偏移基准，禁止整篇塞模型）
// res.documents[i].blocks（按 type/heading/charStart/charEnd 定位条款，供规则比对与证据引用）
// res.metrics.warnings（no_page_info / multi_column / docid_generated 等诊断）
```

推荐数据流：`documents[i]` 存为 harness memory 的文档条目（blocks + fullText），后续规则引擎按
`blockId` 引用；`Evidence` 的 `charStart/charEnd` 沿用本输出的全文偏移（详见 `docs/contracts.md`）。

### 方式 B：MCP stdio（Agent 工具化）

1. 以 stdio 方式启动 `node skills/parse-document/mcp/server.js`（建议作为子进程常驻）
2. 调用 tool `parse_document`，入参遵循 `schema.input.json`（单文档）：
   `{ docId?, docName, contentBase64|path }`
3. 工具结果 `content[0].text` 为信封 JSON；`isError` 仅用于协议层异常，业务失败都在 JSON 内

### 错误处理约定

- 一切失败都带错误码，不静默：整调用级 `error.code`（INVALID_INPUT/READ_FAILED/PARSE_FAILED/EMPTY_INPUT/EMPTY_RESULT/OCR_REQUIRED/UNSUPPORTED_FORMAT/INTERNAL 等），文档级见 `documents[i].reason`
- Harness 遇到 `OCR_REQUIRED`：标记"需 OCR"，不要继续塞给规则比对