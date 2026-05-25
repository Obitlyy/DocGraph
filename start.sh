#!/bin/bash
# DocGraph v2 - 一键启动
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

# 停掉可能残留的进程
lsof -ti:8000 | xargs kill -9 2>/dev/null || true
lsof -ti:3000 | xargs kill -9 2>/dev/null || true

# 加载环境变量
export $(grep -v '^#' "$DIR/.env" | grep -v '^$' | xargs)
export DATA_DIR="$DIR/data"

# 启动后端
echo "🚀 启动后端 (port 8000)..."
cd "$DIR/backend"
python main.py &
BACKEND_PID=$!
sleep 2

# 启动前端
echo "🚀 启动前端 (port 3000)..."
cd "$DIR/frontend"
npx vite --port 3000 &
FRONTEND_PID=$!

echo ""
echo "═══════════════════════════════════════"
echo "  🥔 DocGraph v2 已启动"
echo "  前端: http://localhost:3000"
echo "  后端: http://localhost:8000"
echo "  API:  http://localhost:8000/docs"
echo "═══════════════════════════════════════"
echo "  按 Ctrl+C 停止"
echo ""

cleanup() {
  echo "🛑 停止中..."
  kill $BACKEND_PID 2>/dev/null
  kill $FRONTEND_PID 2>/dev/null
  echo "✅ 已停止"
  exit 0
}
trap cleanup SIGINT SIGTERM
wait
