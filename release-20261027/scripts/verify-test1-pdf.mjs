import { statSync } from "node:fs";
import { basename } from "node:path";
import { parseDocumentSkill } from "../skills/parse-document/index.js";

const file = "skills/parse-document/test/fixtures/test1.pdf";
const docId = "test1";

console.log("=== file ===", statSync(file).size, "bytes");

const input = {
  documents: [{ docId, docName: basename(file), path: file }],
  options: { includeBbox: true, normalize: true, maxConcurrency: 1 },
};

const started = Date.now();
const result = await parseDocumentSkill(input);

if (!result.ok) {
  console.error("PARSE FAILED:", JSON.stringify(result.error, null, 2));
  process.exit(2);
}

const doc = result.documents[0];
const checks = [];
const push = (name, ok, detail = "") => checks.push({ name, ok, detail });

push("blockCount > 0", doc.blocks.length > 0, `blocks=${doc.blocks.length}`);
push("pageCount >= 1", (doc.pageCount || 0) >= 1, `pageCount=${doc.pageCount}`);

let badOffset = 0;
for (const b of doc.blocks) {
  if (doc.fullText.slice(b.charStart, b.charEnd) !== b.text) badOffset++;
}
push("偏移全部对齐", badOffset === 0, `mismatch=${badOffset}`);

const ids = doc.blocks.map(b => b.blockId);
push("blockId 无重复", new Set(ids).size === ids.length, `unique=${new Set(ids).size}/${ids.length}`);

const pageOk = doc.blocks.every(b => Number.isInteger(b.page) && b.page >= 1 && b.page <= doc.pageCount);
push("page 合法", pageOk);

const bboxOk = doc.blocks.every(b => b.bbox && typeof b.bbox.top === "number");
push("bbox 存在", bboxOk);

let serializable = true;
try { JSON.stringify(result); } catch { serializable = false; }
push("JSON 可序列化", serializable);

push("无 OCR_REQUIRED warning", !doc.warnings.some(w => String(w).includes("OCR_REQUIRED")), JSON.stringify(doc.warnings));

console.log("=== metrics ===", result.metrics);
console.log("=== warnings ===", doc.warnings);
console.log("=== 前 5 个 block ===");
for (const b of doc.blocks.slice(0, 5)) {
  console.log({
    blockId: b.blockId.slice(0, 12),
    page: b.page,
    charStart: b.charStart,
    charEnd: b.charEnd,
    text: b.text.slice(0, 60),
  });
}
console.log("=== checks ===");
let failed = 0;
for (const c of checks) {
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}  ${c.detail}`);
  if (!c.ok) failed++;
}
console.log(`=== 耗时 ${Date.now() - started}ms, 失败 ${failed} 项 ===`);
process.exit(failed === 0 ? 0 : 1);