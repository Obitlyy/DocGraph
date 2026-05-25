#!/bin/bash
# DocGraph 打包脚本 — 生成 macOS .dmg
# 使用方法: cd DocGraph && bash build-dmg.sh

set -e
echo "========== DocGraph DMG 打包 =========="

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
ELECTRON_DIR="$PROJECT_ROOT/electron"
FRONTEND_DIR="$PROJECT_ROOT/frontend"
BACKEND_DIR="$PROJECT_ROOT/backend"

echo ""
echo "[1/4] 构建前端..."
cd "$FRONTEND_DIR"
npm run build
# 复制到 electron 目录
rm -rf "$ELECTRON_DIR/frontend-dist"
cp -r dist "$ELECTRON_DIR/frontend-dist"
echo "✅ 前端构建完成"

echo ""
echo "[2/4] 打包 Python 后端..."
cd "$PROJECT_ROOT"
# 用 PyInstaller 打包后端为单文件
pip install pyinstaller 2>/dev/null || true
pyinstaller \
  --onefile \
  --name docgraph-server \
  --distpath "$ELECTRON_DIR/backend-dist" \
  --workpath /tmp/docgraph-build \
  --specpath /tmp/docgraph-build \
  --hidden-import uvicorn.logging \
  --hidden-import uvicorn.protocols.http \
  --hidden-import uvicorn.protocols.http.auto \
  --hidden-import uvicorn.protocols.websockets \
  --hidden-import uvicorn.protocols.websockets.auto \
  --hidden-import uvicorn.lifespan \
  --hidden-import uvicorn.lifespan.on \
  --hidden-import uvicorn.lifespan.off \
  --hidden-import src.scanner \
  --hidden-import src.storage \
  --hidden-import src.llm_client \
  --hidden-import src.llm_analyzer \
  --hidden-import src.chat_tools \
  --hidden-import src.number_index \
  --hidden-import src.number_extractor \
  --hidden-import src.recommender \
  --hidden-import src.relation_schemas \
  --hidden-import src.full_scan \
  --hidden-import src.deep_explore \
  --hidden-import src.phase_analyzer \
  --add-data "src:src" \
  --add-data ".env.example:.env.example" \
  backend/main.py
echo "✅ 后端打包完成"

echo ""
echo "[3/4] 安装 Electron 依赖..."
cd "$ELECTRON_DIR"
npm install
echo "✅ Electron 依赖就绪"

echo ""
echo "[4/4] 生成 .dmg..."
npm run build:dmg
echo ""
echo "========================================="
echo "✅ 打包完成！"
echo "DMG 文件位于: $ELECTRON_DIR/dist/"
echo "========================================="
