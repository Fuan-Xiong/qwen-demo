#!/usr/bin/env bash
# demo-run.sh —— 离线演示启动脚本（MOCK_MODE=1，不调真实模型）
#
# 行为：
#   1) 启动后端（MOCK_MODE=1：registry 内联技能，不调真实模型；key 用占位满足 env 必填校验）
#   2) 启动前端（默认 mock 回放；http://localhost:5173）
#   3) 打印访问地址与演示步骤（含后端 curl 演示命令，走 scripts/demo-data/）
#   4) Ctrl+C / 退出时 kill 前后端进程并释放 3001/5173
#
# 依赖：lsof（端口释放）

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT_BACK=3001
PORT_FRONT=5173
BACK_PID=""
FRONT_PID=""

cleanup() {
  trap - EXIT INT TERM
  [ -n "$BACK_PID" ] && kill "$BACK_PID" 2>/dev/null || true
  [ -n "$FRONT_PID" ] && kill "$FRONT_PID" 2>/dev/null || true
  sleep 1
  lsof -ti :"$PORT_BACK" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
  lsof -ti :"$PORT_FRONT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
  echo ""
  echo "[demo] 已清理：端口 $PORT_BACK / $PORT_FRONT 释放"
}
trap cleanup EXIT INT TERM

# 1) 后端：MOCK_MODE=1（约定环境变量，registry 链路本身不调模型）
echo "[demo] 启动后端（MOCK_MODE=1 → http://127.0.0.1:$PORT_BACK）…"
(
  cd "$ROOT/agent-server"
  MOCK_MODE=1 PORT=$PORT_BACK QWEN_API_KEY=demo-mock-key MODEL_NAME=demo-model node src/server.js
) &
BACK_PID=$!

# 2) 前端：默认 mock 回放
echo "[demo] 启动前端（http://localhost:$PORT_FRONT）…"
(
  cd "$ROOT/frontend-vue3"
  npm run dev
) &
FRONT_PID=$!

# 3) 等待后端就绪（最多 30s）
for _ in $(seq 1 30); do
  curl -s "http://127.0.0.1:$PORT_BACK/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -s "http://127.0.0.1:$PORT_BACK/health" >/dev/null 2>&1 || echo "[demo] 警告：后端 30s 未就绪"

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  档案合规审查助手 · 离线演示（MOCK_MODE=1）"
echo "────────────────────────────────────────────────────────────"
echo "  网页   : http://localhost:$PORT_FRONT（默认 mock，可切 real 连后端）"
echo "  后端   : http://127.0.0.1:$PORT_BACK/health"
echo ""
echo "  演示步骤："
echo "  1) 打开 http://localhost:$PORT_FRONT，点「开始核查」——mock 完整流："
echo "     开始 → 流式消息 → 结果卡片(fail/pass/review) → 溯源 → 指标 → done"
echo "  2) 中途点「中断」——mock 也会中止（2 秒内变 aborted）"
echo "  3) Toolbar 切 real → 再点开始——真实后端解析 scripts/demo-data/，"
echo "     返回确定性 result 序列（demo 规则：R001 pass / R002 fail / R003·R004 review）"
echo ""
echo "  后端 curl 演示（等价 real 链路）："
echo "  curl -N -X POST http://127.0.0.1:$PORT_BACK/api/review \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"runId\":\"demo_001\",\"documents\":[{\"docId\":\"contract_A\",\"docName\":\"contract_A.docx\",\"path\":\"../scripts/demo-data/contract_A.docx\"},{\"docId\":\"annex_B\",\"docName\":\"annex_B.pdf\",\"path\":\"../scripts/demo-data/annex_B.pdf\"}],\"ruleManifest\":$(cat "$ROOT/scripts/demo-data/ruleManifest.json")}'"
echo ""
echo "  退出：Ctrl+C（自动 kill 进程并释放 3001/5173）"
echo "════════════════════════════════════════════════════════════"

wait