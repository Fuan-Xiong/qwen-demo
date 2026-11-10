---
name: parse-document
description: 解析合同/标书文档（.docx/.pdf）为统一 Block 结构（blockId/页码/字符偏移）。当 Agent 需要把上传或给定的文档转成结构化文本块、供规则比对与证据定位使用，或用户说"解析这份文档/把文档切成 block"时使用。
---

# parse-document —— 文档解析技能

## 用途

把一份合同/标书文档（.docx/.pdf）解析成**统一 Block 结构**，产出：

- 全文纯文本 `fullText`（各块按 `\n` 连接）与全局字符偏移 `charStart/charEnd`
- 每个块的 `blockId`（`md5(docId:blockIndex:heading:text)`，同一文档重复解析结果一致）
- 页码与坐标：PDF 必填 `page` 与近似 `bbox`；DOCX 无分页信息时 `page = null`
- 结构化分类：`paragraph / heading / table / table_cell / list_item`，并记录所属章节标题 `heading`

解析结果只作为规则核查的**输入地基**，本身不做任何合规判定。

## 何时使用

- 用户上传/提供文档（docx、pdf），要求进行合规核查、条款比对、证据溯源
- 主链路进入"解析文档"阶段，需要把原始文件内容转成 `ParsedDoc`（blocks + fullText）
- 用户明确要求"解析文档""切成 block""提取条款/页码/偏移"

## 输入

遵循 `schema.input.json`（JSON Schema draft-07）。核心字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `docName` | string | 是 | 文件名（**含扩展名**），决定解析格式 |
| `docId` | string | 否 | 文档唯一 ID；缺省由解析层按文件内容 md5 生成 |
| `path` | string | 内容四选一 | 本地文件路径 |
| `contentBase64` | string | 内容四选一 | 文档二进制内容的 Base64 编码（docx/pdf 必用） |
| `base64` | string | 内容四选一 | 同 `contentBase64`（兼容别名） |
| `text` | string | 内容四选一 | 纯文本内容（仅 txt/md；当前入口未支持 txt/md） |

> `path / contentBase64 / base64 / text` 恰好提供其一；docx/pdf 必须走 `path` 或 `contentBase64`（或别名 `base64`）。

## 输出

遵循 `schema.output.json`（JSON Schema draft-07）的**单文档形状**。技能入口 `parseDocumentSkill` 返回信封：

```json
{
  "ok": true,
  "documents": [ ],
  "metrics": { "total": 1, "success": 1, "failed": 0, "durationMs": 12, "warnings": [] }
}
```

- **成功文档**（`documents[i]`，与 `schema.output.json` 成功分支一致）：`ParsedDoc`

```json
{
  "docId": "doc-001",
  "docName": "投标合同样本.docx",
  "pageCount": 0,
  "fullText": "第一条 报价有效期\n报价有效期不得少于 90 天。",
  "separator": "\n",
  "blocks": [
    {
      "blockId": "5f2a...（32 位 md5）",
      "docId": "doc-001",
      "docName": "投标合同样本.docx",
      "page": null,
      "type": "heading",
      "heading": null,
      "text": "第一条 报价有效期",
      "charStart": 0,
      "charEnd": 9
    }
  ]
}
```

- **失败文档**：`{ "ok": false, "reason": "PARSE_FAILED：<带上下文的失败原因>" }`（reason 含错误码），不中断同批其他文档
- **整调用级失败**（输入非法/调度异常）：`{ "ok": false, "error": { "code": "INVALID_INPUT", "message": "...", "detail": ... } }`
- `documents[i]` 带**该文档自己的解析告警** `warnings`（可为空数组）；`cacheHit` 等内部字段仍剥离；全批告警（含 `docid_generated`）汇总进 `metrics.warnings`

## 约束

- 技能入口当前只支持 `.docx / .pdf` 两种格式；`.txt/.md` 及其他扩展名按文档失败返回 `UNSUPPORTED_FORMAT`，不得静默吞错
- 输出（`documents[i]`）必须严格符合 `schema.output.json` 的单文档形状：字段名、类型、required 均不可偏离；内部字段一律剥离
- 解析失败（格式非法、无可用文本、buffer 为空）必须返回 `{ ok: false, reason }` 或抛出带上下文的 Error，禁止静默吞错、禁止伪造数据
- `charStart/charEnd` 是 **fullText 内的全局偏移**（左闭右开），不是块内偏移；实测满足 `fullText.slice(charStart, charEnd) === text`
- `blockId` 必须按 `md5(docId + ":" + blockIndex + ":" + heading + ":" + text)` 生成，heading 为 null 时按空串参与哈希
- 解析出的 `fullText` 只用于偏移基准与切片召回，**禁止把整篇文档塞给模型**

## 调用示例

用户："解析这份投标合同，我要逐条核对报价有效期和付款比例。"

技能输入：

```json
{
  "docId": "doc-001",
  "docName": "投标合同样本.docx",
  "contentBase64": "UEsDBBQABgAIAAAAIQC...（Base64 编码的 docx 内容）"
}
```

技能输出（摘要）：信封 `{ ok, documents, metrics }`，`documents[0]` 为 `ParsedDoc`，其中 `type: "heading"` 的块 `第一条 报价有效期` 之后跟随的段落块带 `heading: "第一条 报价有效期"`，其 `charStart/charEnd` 指向 fullText 内的准确区间，供后续规则比对直接引用。

## 限制

- **docx 无真实分页**：`page = null`、`pageCount = 0`（不做字符量估算）
- **扫描件 PDF**：全文无文本层时按文档失败返回 `{ ok: false, reason: "OCR_REQUIRED：…" }`，不得猜测内容
- **bbox 为近似值**：PDF 用户空间坐标（y 向上），按基线 ± 字高比例估算，非精确字形边界
- **表格文本重复**：同一表格同时产出 `table` 块（行列拼接文本）与 `table_cell` 块，其文本会两次进入 `fullText`（规格固有行为，证据定位按 blockId 优先）
- **txt/md 未支持**：技能入口未注册文本解析器（扩展名按文档失败 `UNSUPPORTED_FORMAT`）
- **多文档批量**：`documents` 数组与 `maxConcurrency` 仅能通过直接调用 `parseDocumentSkill` 使用；MCP 工具的 inputSchema 即 `schema.input.json`（单文档形状），不含批量字段
- 实现位于 `skills/parse-document/`（自包含：`utils/`、`parsers/`、`index.js`、`mcp/server.js`），**不依赖 `src/rules/parser`**；MCP stdio 启动方式见 `mcp/server.js` 头部注释