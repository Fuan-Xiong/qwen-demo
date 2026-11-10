// 由 review-sample.json 生成，浏览器端直接 import（无 node:fs）
export const sample = {
  "reviewId": "rv-mock-001",
  "status": "partial",
  "summary": {
    "total": 8,
    "pass": 5,
    "fail": 2,
    "review": 1,
    "riskLevel": "high",
    "conclusion": "共 8 条规则，2 条不合规（报价有效期、预付款比例），1 条证据不足需人工复核，建议先整改 P0 项后再提交。"
  },
  "issues": [
    {
      "ruleId": "R001",
      "verdict": "fail",
      "severity": "high",
      "title": "报价有效期",
      "reason": "报价有效期为 60 天，低于要求的不少于 90 天。",
      "suggestion": "将报价有效期调整为不少于 90 个自然日。",
      "confidence": 0.98,
      "method": "deterministic",
      "evidence": [
        {
          "docId": "doc-001",
          "docName": "投标合同样本.pdf",
          "page": 3,
          "blockId": "p-000042",
          "charStart": 18,
          "charEnd": 30,
          "snippet": "报价有效期：60 天"
        }
      ]
    },
    {
      "ruleId": "R002",
      "verdict": "fail",
      "severity": "high",
      "title": "付款条款",
      "reason": "预付款比例为 40%，高于上限 30%。",
      "suggestion": "将预付款比例下调至 30% 及以下，或改为按进度付款。",
      "confidence": 0.97,
      "method": "deterministic",
      "evidence": [
        {
          "docId": "doc-001",
          "docName": "投标合同样本.pdf",
          "page": 5,
          "blockId": "p-000071",
          "charStart": 6,
          "charEnd": 22,
          "snippet": "合同签订后预付 40%"
        }
      ]
    },
    {
      "ruleId": "R005",
      "verdict": "review",
      "severity": "medium",
      "title": "违约条款",
      "reason": "违约条款仅写「按法律规定承担责任」，未明确违约金计算方式，无法判定是否合规。",
      "suggestion": "补充违约金计算基数与比例。",
      "confidence": 0.45,
      "method": "semantic",
      "evidence": [
        {
          "docId": "doc-001",
          "docName": "投标合同样本.pdf",
          "page": 7,
          "blockId": "p-000098",
          "charStart": 0,
          "charEnd": 28,
          "snippet": "违约责任按法律规定承担责任。"
        }
      ]
    }
  ],
  "coverage": {
    "total": 8,
    "done": 6,
    "review": 1,
    "pending": 1,
    "rate": 0.875,
    "uncoveredAlerts": ["R008"],
    "items": [
      { "ruleId": "R001", "state": "done", "verdict": "fail" },
      { "ruleId": "R002", "state": "done", "verdict": "fail" },
      { "ruleId": "R003", "state": "done", "verdict": "pass" },
      { "ruleId": "R004", "state": "done", "verdict": "pass" },
      { "ruleId": "R005", "state": "review", "verdict": "review" },
      { "ruleId": "R006", "state": "done", "verdict": "pass" },
      { "ruleId": "R007", "state": "done", "verdict": "pass" },
      { "ruleId": "R008", "state": "pending" }
    ]
  },
  "metrics": {
    "tokenIn": 6420,
    "tokenOut": 1180,
    "tokenTotal": 7600,
    "durationMs": 21400,
    "stages": [
      { "name": "parse", "durationMs": 2100, "tokenTotal": 0 },
      { "name": "rules", "durationMs": 300, "tokenTotal": 0 },
      { "name": "plan", "durationMs": 3200, "tokenTotal": 1500 },
      { "name": "execute", "durationMs": 12800, "tokenTotal": 5200 },
      { "name": "verify", "durationMs": 2400, "tokenTotal": 900 },
      { "name": "report", "durationMs": 600, "tokenTotal": 0 }
    ],
    "llmCalls": 4,
    "deterministicCalls": 6
  },
  "documents": [
    { "docId": "doc-001", "docName": "投标合同样本.pdf", "pageCount": 12 }
  ]
}
