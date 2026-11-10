# contracts.md —— B2 模块统一数据结构契约

> B2 解析与规则引擎的**内部**数据结构契约（以"档案合规审查助手"新规格为准）。
> 与 `docs/result.schema.json`（SSE 对外契约，队长单写）相互独立：本文件只约束
> `src/rules/` 内部模块间传递的对象形状，不替代对外协议。

## 1. Block（解析产物，src/rules/parser/*）

```js
{
  blockId: string,          // md5(docId + ":" + blockIndex + ":" + heading + ":" + text)
                            //   heading 为 null 时按空串参与哈希（保证确定性）
  docId: string,
  docName: string,
  page: number | null,      // PDF 必填（1-based）；DOCX/TXT 无分页信息时为 null
  type: "paragraph" | "heading" | "table" | "table_cell" | "list_item",
  heading: string | null,   // 所属章节标题（最近的 heading 块文本）；无标题时 null
  text: string,
  charStart: number,        // 在全文纯文本（fullText）中的起始偏移（左闭）
  charEnd: number,          // 在全文纯文本中的结束偏移（右开）
  bbox?: { x0, top, x1, bottom },   // 仅 PDF：PDF 用户空间坐标，y 向上，近似包围盒
  rows?: string[][]         // 仅 table 类型：逐行单元格文本
}
```

### ParsedDoc（parseDocument 返回值）

```js
{
  docId: string,
  docName: string,
  pageCount: number,        // PDF = 最大页码；DOCX/TXT 无分页信息 = 0
  fullText: string,         // 全文纯文本：blocks 按序以 separator 连接
  separator: string,        // 连接符，恒为 "\n"
  blocks: Block[],
  warnings: Array<{ code: string, message: string, ... }>  // 该文档解析告警（可为空数组）；全批汇总见入口 metrics.warnings
}
```

### 约定与边界

- **docx**：经 `mammoth.convertToHtml` → HTML 结构分类（h1-h6/p/li/table）。
  表格产出 1 个 `table` 块（`rows` + 行列文本）+ 每个单元格 1 个 `table_cell` 块；
  单元格与表格文本会同时进入 fullText（同一内容两次出现，属于规格固有行为）。
- **pdf**：`pdfjs-dist` 抽取文本项 → 按 `hasEOL` 分"行" → 按规则断"块"：
  空白行 / 行间垂直间隙 > 0.55 行高 / 字号 > 页面中位字号 ×1.18（标题）/ 行首为
  项目符号或序号（列表项）。相邻行拼接时，接缝任一侧为汉字则不补空格，否则补一个空格。
- **txt/md**：按空行切段，type 一律 `paragraph`。
- **blockId**：同一 `(docId, blockIndex, heading, text)` 幂等；不同文档/不同内容必不相同。
- **charStart/charEnd 是全文偏移，不是块内偏移**：证据层（evidence/locate.js）以此为
  基准回填；块内定位需用 `text` 与全文的映射（见后续证据章节）。
- **错误约定**：所有解析函数抛带上下文的 Error（含 docName/格式/失败原因），不静默吞错。

## 2. Rule（规则加载，src/rules/loadRules.js）—— 第二阶段

```js
{
  ruleId: string,
  ruleName: string,
  sourceClause: string,
  applicableDocs: string[],
  checkType: "deterministic" | "semantic" | "cross_doc",
  logic: string,
  compareLogic?: object,     // deterministic 规则的比对参数（第二阶段定义）
  evidenceRequirement: string,
  severity: "high" | "medium" | "low",
  priority: "P0" | "P1" | "P2",
  keywords?: string[]
}
```

## 3. Evidence / Result（证据与结论）—— 第三阶段起

```js
Evidence = {
  docId: string, docName: string, page?: number | null,
  blockId: string, charStart: number, charEnd: number,
  text: string, bbox?: object,
}

Result = {
  ruleId: string, ruleName?: string,
  status: "pass" | "fail" | "review" | "not_applicable",
  severity?: string, evidence: Evidence[],
  suggestion?: string, confidence?: number, reason?: string,
}
```

## 4. CoverageCell / 覆盖矩阵 —— 第三阶段起

```js
CoverageCell = {
  ruleId: string,
  status: "pending" | "running" | "done" | "review" | "failed",
  attempts: number,
  result: Result | null,
  reason: string | null,
}
```

## 5. 变更记录

| 时间 | 变更 |
|---|---|
| 2026-10-23 | 初版：Block/ParsedDoc 定稿（解析模块落地）；Rule/Result/CoverageCell 占位 |
