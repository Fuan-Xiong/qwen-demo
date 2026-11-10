// mock/requestPayload.js —— 真实后端联调请求体（F Owner）
// 后端契约（src/server.js / harness.resolveDocs）：POST /api/review 只认 docIds（内存 docStore，
// 由前端先 POST /api/upload 取得）或 docs（已解析对象）；documents[path] 字段已不被支持。
// ruleManifest：与 data/real-docs/ruleManifest.json 一致的 13 条真实规则（可研报告合规审查规则）；
// options：与 agent-server 编排对齐的参数（concurrency/stepTimeoutMs，maxRounds 等由 env 配置）

/** 旧联调遗留（documents[path] 形态已不被后端支持），保留仅供参考，勿用于真实评审 */
export const REQUEST_DOCUMENTS = [
  {
    path: '../scripts/demo-data/contract_A.docx',
    docId: 'contract_A',
    docName: 'contract_A.docx',
  },
]

export const REQUEST_RULES = [
  {
    ruleId: 'R001', ruleName: '必备章节完整性', sourceClause: '第一章·第一条', applicableDocs: '可研报告',
    checkType: 'semantic', logic: '总论/背景必要性/需求规模/建设方案/投资资金/效益/风险/结论八章节缺一不通过（标题可同义）',
    evidenceRequirement: '总论,项目建设背景和必要性,需求分析与建设规模,建设方案,投资估算与资金筹措,经济与社会效益分析,风险分析,结论与建议',
    severity: 'high', priority: 'P0',
  },
  {
    ruleId: 'R002', ruleName: '编制要素齐全', sourceClause: '第一章·第二条', applicableDocs: '可研报告',
    checkType: 'semantic', logic: '编制单位/日期/资质等级（甲或乙级）/编制人审核人四要素缺一不通过',
    evidenceRequirement: '编制单位,编制日期,资质等级,编制人,审核人',
    severity: 'medium', priority: 'P0',
  },
  {
    ruleId: 'R003', ruleName: '总投资额一致性', sourceClause: '第二章·第三条', applicableDocs: '可研报告',
    checkType: 'cross_doc', logic: '总论/投资估算/批复文件三处总投资数值相等（允许分位误差）',
    evidenceRequirement: '总投资',
    severity: 'high', priority: 'P0',
  },
  {
    ruleId: 'R004', ruleName: '资金来源合计等于总投资', sourceClause: '第二章·第四条', applicableDocs: '可研报告',
    checkType: 'deterministic', logic: '各来源金额合计=总投资 且 比例合计=100%',
    evidenceRequirement: '资金来源,资金筹措,总投资',
    severity: 'high', priority: 'P0',
  },
  {
    ruleId: 'R005', ruleName: '建设期一致性', sourceClause: '第二章·第五条', applicableDocs: '可研报告',
    checkType: 'cross_doc', logic: '总论/建设方案/批复文件三处建设期月数一致',
    evidenceRequirement: '建设期',
    severity: 'high', priority: 'P0',
  },
  {
    ruleId: 'R006', ruleName: '建设规模一致性', sourceClause: '第二章·第六条', applicableDocs: '可研报告',
    checkType: 'cross_doc', logic: '总论/需求分析/批复文件关键规模指标数值一致',
    evidenceRequirement: '建设规模,总建筑面积,主要设备数量',
    severity: 'high', priority: 'P0',
  },
  {
    ruleId: 'R007', ruleName: '必要性论证有数据支撑', sourceClause: '第三章·第七条', applicableDocs: '可研报告',
    checkType: 'semantic', logic: '至少一组量化数据或调研依据；仅定性表述不通过',
    evidenceRequirement: '企业数量,增长率,缺口测算,调研报告',
    severity: 'medium', priority: 'P1',
  },
  {
    ruleId: 'R008', ruleName: '技术方案有比选', sourceClause: '第三章·第八条', applicableDocs: '可研报告',
    checkType: 'semantic', logic: '≥2 个方案对比且有推荐结论；仅一个方案不通过',
    evidenceRequirement: '方案比选,推荐理由,方案对比',
    severity: 'medium', priority: 'P1',
  },
  {
    ruleId: 'R009', ruleName: '风险分析完整', sourceClause: '第三章·第九条', applicableDocs: '可研报告',
    checkType: 'semantic', logic: '章节存在、风险类别≥3、每类有应对措施',
    evidenceRequirement: '风险,技术,资金,市场,管理,政策,应对措施',
    severity: 'medium', priority: 'P1',
  },
  {
    ruleId: 'R010', ruleName: '投资估算有依据', sourceClause: '第四章·第十条', applicableDocs: '可研报告',
    checkType: 'semantic', logic: '至少给出定额/价格水平年；仅参照同类项目→复核',
    evidenceRequirement: '定额,价格水平年,类似工程',
    severity: 'medium', priority: 'P1',
  },
  {
    ruleId: 'R011', ruleName: '经济指标齐全', sourceClause: '第四章·第十一条', applicableDocs: '可研报告',
    checkType: 'deterministic', logic: '财务内部收益率/净现值/投资回收期三项指标齐全且有数值和口径',
    evidenceRequirement: '财务内部收益率,财务净现值,投资回收期',
    severity: 'medium', priority: 'P0',
  },
  {
    ruleId: 'R012', ruleName: '结论明确', sourceClause: '第五章·第十二条', applicableDocs: '可研报告',
    checkType: 'semantic', logic: '结论明确可行/不可行；模糊表述→复核',
    evidenceRequirement: '可行,不可行,结论',
    severity: 'high', priority: 'P0',
  },
  {
    ruleId: 'R013', ruleName: '与批复文件一致', sourceClause: '第五章·第十三条', applicableDocs: '可研报告',
    checkType: 'cross_doc', logic: '项目名称/建设单位/建设地点/建设内容逐项比对（允许括号顿号差异）',
    evidenceRequirement: '项目名称,建设单位,建设地点,建设内容,批复',
    severity: 'high', priority: 'P0',
  },
]

/**
 * 构建 POST /api/review 请求体。
 * @param {string[]} [docIds] 已上传文档的 docId 列表（/api/upload 返回）；空数组时由调用方
 *   决定是否拦截（App.start real 分支会提示先上传文档）
 */
export function buildRequestPayload(docIds = []) {
  return {
    docIds,
    ruleManifest: REQUEST_RULES,
    options: { concurrency: 2, stepTimeoutMs: 30000 },
  }
}
