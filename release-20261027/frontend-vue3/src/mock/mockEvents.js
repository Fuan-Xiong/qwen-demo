// mock/mockEvents.js —— Mock SSE 事件构建（F Owner）
// 导出 buildMockEvents()：返回按序事件数组，模拟一次完整评审流。
// 契约字段严格对齐「SSE 契约」；事件间真实间隔由 mockSse 的 intervalMs 控制（300-800ms 随机）。

/** 合同A：6 个 block（charStart/charEnd 连续，块间以换行分隔） */
const DOC_A_BLOCKS = [
  { blockId: 'A1', page: 1, type: 'heading', heading: null, text: '第一条 合同金额', charStart: 0, charEnd: 8 },
  { blockId: 'A2', page: 1, type: 'paragraph', heading: '第一条 合同金额', text: '合同总金额为人民币壹佰万元整。', charStart: 9, charEnd: 24 },
  { blockId: 'A3', page: 1, type: 'paragraph', heading: '第二条 付款方式', text: '付款方式为分两期支付。', charStart: 25, charEnd: 36 },
  { blockId: 'A4', page: 1, type: 'paragraph', heading: '第二条 付款方式', text: '预付款比例为百分之三十。', charStart: 37, charEnd: 49 },
  { blockId: 'A5', page: 2, type: 'paragraph', heading: '第三条 质保期', text: '质保期自验收合格之日起十二个月。', charStart: 50, charEnd: 66 },
  { blockId: 'A6', page: 2, type: 'paragraph', heading: '第四条 争议解决', text: '争议解决方式为提交仲裁。', charStart: 67, charEnd: 79 },
]

/** 附件B：4 个 block（独立全文偏移，连续） */
const DOC_B_BLOCKS = [
  { blockId: 'B1', page: 1, type: 'heading', heading: null, text: '附件：费用明细', charStart: 0, charEnd: 7 },
  { blockId: 'B2', page: 1, type: 'paragraph', heading: '附件：费用明细', text: '设备采购费用合计人民币壹佰贰拾万元。', charStart: 8, charEnd: 26 },
  { blockId: 'B3', page: 2, type: 'paragraph', heading: '附件：费用明细', text: '含税金额已包含增值税。', charStart: 27, charEnd: 38 },
  { blockId: 'B4', page: 2, type: 'paragraph', heading: '附件：费用明细', text: '备注：本附件与合同具有同等效力。', charStart: 39, charEnd: 55 },
]

/** 两个文档（documents 事件载荷） */
const DOCUMENTS = [
  { docId: 'docA', docName: '合同A.docx', fileType: 'docx', pageCount: 2, blocks: DOC_A_BLOCKS },
  { docId: 'docB', docName: '附件B.pdf', fileType: 'pdf', pageCount: 2, blocks: DOC_B_BLOCKS },
]

/** 规则 R001 的证据：合同A 与 附件B 各一条 */
const EVIDENCE_R001 = [
  { docId: 'docA', docName: '合同A.docx', page: 1, blockId: 'A1', charStart: 0, charEnd: 8, text: '第一条 合同金额', bbox: null },
  { docId: 'docB', docName: '附件B.pdf', page: 1, blockId: 'B2', charStart: 8, charEnd: 26, text: '设备采购费用合计人民币壹佰贰拾万元。', bbox: null },
]

const METRICS = {
  tokens: { prompt: 8200, completion: 1200, total: 9400, estimated: false },
  elapsedMs: 12340,
  stages: { PARSING: 420, PLANNING: 120, EXECUTING: 11200, VERIFYING: 600 },
  rules: { total: 3, done: 2, review: 1, failed: 0 },
}

/**
 * 构建一次完整评审的事件序列（14 个事件）。
 * @returns {Array<{event:string, data:object}>}
 */
export function buildMockEvents() {
  return [
    { event: 'run_started', data: { runId: 'mock_001', model: 'qwen-max', startedAt: Date.now() } },
    { event: 'progress', data: { stage: 'PARSING', percent: 20, message: '解析合同A与附件B' } },
    { event: 'documents', data: { documents: DOCUMENTS } },
    { event: 'progress', data: { stage: 'RULE_LOADING', percent: 30, message: '加载 3 条核查规则' } },
    { event: 'progress', data: { stage: 'PLANNING', percent: 40, message: '按 checkType 分组规划' } },
    { event: 'progress', data: { stage: 'EXECUTING', percent: 60, message: '执行确定性比对' } },
    { event: 'message', data: { delta: '正在核查合同金额与附件金额是否一致...' } },
    { event: 'result', data: {
      ruleId: 'R001', ruleName: '合同金额与附件金额一致', status: 'fail', severity: 'high',
      confidence: 0.97,
      evidence: EVIDENCE_R001,
      suggestion: '核对合同金额与附件费用明细，确认差异原因后修订',
      reason: '合同金额为壹佰万元，附件费用合计壹佰贰拾万元，两者不一致。',
    } },
    { event: 'result', data: {
      ruleId: 'R002', ruleName: '预付款比例不高于 30%', status: 'pass', severity: 'medium',
      confidence: 0.95,
      evidence: [
        { docId: 'docA', docName: '合同A.docx', page: 1, blockId: 'A4', charStart: 37, charEnd: 49, text: '预付款比例为百分之三十。', bbox: null },
      ],
      reason: '预付款比例恰为 30%，符合上限要求。',
    } },
    { event: 'result', data: {
      ruleId: 'R003', ruleName: '质保期不少于 12 个月', status: 'review', severity: 'low',
      confidence: null,
      evidence: [],
      reason: '证据不足，需人工复核',
    } },
    { event: 'progress', data: { stage: 'VERIFYING', percent: 90, message: '生成覆盖矩阵' } },
    { event: 'metrics', data: METRICS },
    { event: 'warning', data: { code: 'REVIEW', message: 'R003 证据不足', ruleId: 'R003' } },
    { event: 'done', data: {
      summary: '共核查3条规则，1条不通过，1条待复核',
      coverage: {
        total: 3, done: 2, review: 1, failed: 0,
        details: [
          { ruleId: 'R001', status: 'done' },
          { ruleId: 'R002', status: 'done' },
          { ruleId: 'R003', status: 'review', reason: '证据不足' },
        ],
      },
      metrics: METRICS,
    } },
  ]
}