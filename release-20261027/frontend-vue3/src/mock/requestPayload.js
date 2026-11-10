// mock/requestPayload.js —— 真实后端联调请求体（F Owner）
// documents：fixture 文件路径（真实解析由后端执行）；ruleManifest：3 条核查规则；
// options：与 agent-server 环境变量对齐的编排参数（maxRounds/timeoutMs/retries）

export const REQUEST_DOCUMENTS = [
  {
    path: 'skills/parse-document/test/fixtures/test1.pdf',
    docId: 'docA',
    docName: 'test1.pdf',
  },
]

export const REQUEST_RULES = [
  { ruleId: 'R001', ruleName: '合同金额与附件金额一致', checkType: 'deterministic', severity: 'high', priority: 'P0', keywords: ['金额', '附件'] },
  { ruleId: 'R002', ruleName: '预付款比例不高于 30%', checkType: 'deterministic', severity: 'medium', priority: 'P1', keywords: ['预付款', '30%'] },
  { ruleId: 'R003', ruleName: '质保期不少于 12 个月', checkType: 'semantic', severity: 'low', priority: 'P2', keywords: ['质保', '12 个月'] },
]

/** 构建 POST /api/review 请求体 */
export function buildRequestPayload() {
  return {
    documents: REQUEST_DOCUMENTS,
    ruleManifest: REQUEST_RULES,
    options: { maxRounds: 3, timeoutMs: 90000, retries: 2 },
  }
}
