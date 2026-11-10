// mock/demo-doc.js —— 演示文档（内存版），保证"未接上传也能端到端跑通"
// 内容刻意设计：R001/R002 命中不合规，R003 合规，R005 语义含糊 → review
// 与 mock/fixtures/review-sample.json 的结论口径保持一致，方便前端对照。

export const demoDoc = {
  docId: 'doc-001',
  docName: '投标合同样本.txt',
  paragraphs: [
    '投标文件商务条款',
    '第一条 报价与有效期：本合同报价为人民币 1,280,000 元（大写：壹佰贰拾捌万元整）。',
    '报价有效期：60 天，自开标之日起计算。',
    '第二条 付款方式：合同签订后预付 40%，剩余款项按验收进度支付。',
    '第三条 质保与售后：质保期 24 个月，质保期内免费提供维修服务。',
    '第四条 违约责任按法律规定承担责任。',
    '第五条 争议解决：双方协商不成，提交合同签订地人民法院管辖。',
    '第六条 签订主体：甲方为某某科技有限公司，乙方为某某信息技术有限公司。',
    '第七条 交付要求：合同签订后 90 日内完成全部设备交付与安装调试。',
  ],
}

/** 供 harness 兜底使用：返回可被 parseDocument 接受的结构 */
export function demoParsed(docId = demoDoc.docId) {
  const blocks = demoDoc.paragraphs.map((text, i) => ({
    blockId: `p-${String(i).padStart(6, '0')}`,
    page: i < 5 ? 1 : 2,
    charStart: 0,
    charEnd: text.length,
    text,
  }))
  return { docId, docName: demoDoc.docName, pageCount: 2, blocks }
}
