# DocGraph - Agent 接手文档

> 这是给下一个接手的 AI Agent 看的项目交接文档。读完这一份就够了，可以快速上手。

## 🎯 项目是什么

**DocGraph** 是一个 AI 驱动的文档关系图谱工具（macOS 桌面应用）。

把一个文件夹丢给它 → 自动扫描所有文档 → LLM 分类、提取关键词、生成摘要 → 推断文档之间的关系 → 在前端可视化成图谱、列表、流程图等多种视图。还有一个 LLM 对话式超级搜索，可以用自然语言查询所有文档。

**典型用例**：研究项目的资料整理、课程材料梳理、工作项目复盘、代码项目文档分析。

**当前用户**：罗一扬（Obit），简洁高效，不喜欢废话，喜欢可对比的表格/方案，会发截图反馈视觉问题。

**GitHub**: https://github.com/Obitlyy/DocGraph

---

## 📂 项目结构

```
/Users/yiyangluo/Desktop/DocGraph/
├── .env                         # 🔑 API key 和模型配置（敏感，已 gitignore）
├── .env.example                 # 模板，给新用户参考
├── .gitignore
├── README.md                    # 用户文档
├── HANDOFF.md                   # 👈 你正在读的这份
├── start.sh                     # 开发模式启动脚本
├── build-dmg.sh                 # 一键打包 DMG
├── backend/
│   ├── main.py                  # FastAPI 后端主文件（~640行）
│   ├── shared.py                # 全局共享状态（task_status）
│   ├── agent_api.py             # /agent/v1/ 外部 Agent API
│   └── routes/
│       ├── chat.py              # /api/chat + /api/chat/stream（LLM 对话+流式）
│       ├── phase.py             # 阶段管理 + 分类管理
│       └── fullscan.py          # 全量扫描
├── src/                         # ⭐ 核心 Python 模块
│   ├── scanner.py               # 文件扫描 + 73种格式解析（含图片视觉）
│   ├── llm_client.py            # DeepSeek API 封装（连接池+重试+流式）
│   ├── llm_analyzer.py          # 分类、关系、群组分析
│   ├── chat_tools.py            # 超级搜索的 8 个 Function Calling 工具
│   ├── relation_schemas.py      # 4 种场景化关系库
│   ├── storage.py               # 图谱持久化（原子写入）
│   ├── full_scan.py             # 全量扫描 + 聚合算法
│   ├── deep_explore.py          # 深度探索（跨组关联发现）
│   ├── phase_analyzer.py        # 阶段分析
│   ├── number_extractor.py      # 数字/日期提取
│   ├── number_index.py          # 数字索引 + 搜索
│   ├── recommender.py           # 文档关联推荐
│   └── category_manager.py      # 分类管理
├── frontend/                    # React + Vite + TypeScript + Tailwind
│   └── src/
│       ├── App.tsx              # 根组件（三功能切换 + 开屏动画 + i18n）
│       ├── api.ts               # API 调用封装（含流式 SSE）
│       ├── locale.tsx           # 中英文 i18n（简易字典模式）
│       ├── features/
│       │   ├── GraphFeature.tsx      # 文档图谱（拖拽上传 + AI 分析）
│       │   ├── FullScanFeature.tsx   # 全量扫描（圆圈宇宙+跨组关联）
│       │   └── SuperSearchFeature.tsx # 超级搜索（LLM 对话 + 流式 + 聊天记录）
│       ├── components/
│       │   ├── GraphView.tsx         # vis-network 图谱（增量更新，不重建）
│       │   ├── ClusterUniverse.tsx   # 圆圈宇宙可视化
│       │   ├── SettingsModal.tsx     # 设置（语言/API Key/主题）
│       │   └── ... 其他组件
│       └── hooks/
│           └── useSuperSearch.ts     # 搜索 hook（已弃用，逻辑移入 feature）
├── electron/                    # Electron 打包层
│   ├── main.js                  # Electron 主进程（启动后端+窗口）
│   ├── package.json             # electron-builder 配置
│   └── backend-dist/            # PyInstaller 打包的后端可执行文件
└── data/                        # 图谱 JSON 数据（gitignore，用户本地生成）
    └── fullscans/               # 全量扫描历史
```

---

## 🚀 启动方式

### 开发模式

```bash
# 后端（端口 8000）
cd /Users/yiyangluo/Desktop/DocGraph/backend
python main.py

# 前端（端口 3000，自动代理 /api → 8000）
cd /Users/yiyangluo/Desktop/DocGraph/frontend
npm run dev
```

> ⚠️ Python 路径: `/Users/yiyangluo/.local/lib/openclaw-internal/runtime/python/bin/python`

### 打包 DMG

```bash
cd /Users/yiyangluo/Desktop/DocGraph
bash build-dmg.sh
# 或手动：
cd frontend && npm run build
cd ../electron && npm run build:dmg
```

### 杀进程

```bash
kill $(lsof -ti :8000)  # 后端
kill $(lsof -ti :3000)  # 前端
```

---

## 🧠 核心架构

### 三大功能模块

| 模块 | 功能 | 关键文件 |
|------|------|---------|
| **文档图谱** | 扫描→分类→关系→可视化 | GraphFeature.tsx, GraphView.tsx |
| **全量扫描** | 多目录聚合→圆圈宇宙→跨组关联 | FullScanFeature.tsx, full_scan.py |
| **超级搜索** | LLM 对话式查询（Function Calling + 流式） | SuperSearchFeature.tsx, chat.py |

### LLM 对话架构（超级搜索）

```
用户输入
  ↓ POST /api/chat/stream (SSE)
后端 Tool Use 循环（最多 5 轮）：
  ├─ DeepSeek 分析意图 → tool_calls
  ├─ 执行工具（search_docs/read_doc_content/search_numbers/...）
  ├─ 结果喂回 LLM
  └─ 检测过渡语 → 强制 tool_choice="required"
  ↓
流式输出最终回答（chat_stream → SSE token by token）
  ↓
前端逐字显示（打字机效果）
```

### 8 个 LLM 工具（src/chat_tools.py）

| 工具 | 功能 |
|------|------|
| search_docs | 关键词搜索文档 |
| search_numbers | 数字追踪 |
| read_doc_content | 读取文档实际内容（2000字） |
| list_all_graphs | 列出图谱概览 |
| get_doc_detail | 获取文档详情 |
| find_related | 查找关联文档 |
| search_by_category | 按分类搜索 |
| search_by_phase | 按阶段搜索 |

### API 端点总览（50个）

- `/api/` — 前端内部使用（无需认证）
- `/agent/v1/` — 外部 Agent 调用（可选 X-API-Key 认证）
- `/health` — 健康检查
- `/docs` — Swagger UI
- `/openapi.json` — OpenAPI 规范导出

---

## 🔑 配置

**.env 文件**（敏感，不在 git 中）：

```
OPENAI_API_KEY=sk-xxx          # DeepSeek API Key
OPENAI_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-v4-flash
VISION_MODEL=doubao-seed-1-6-250615   # 可选，图片识别
VISION_API_KEY=ark-xxx
VISION_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
APP_LANGUAGE=zh                # zh | en
DOCGRAPH_AGENT_KEY=            # 可选，Agent API 认证
```

---

## ⚠️ 已知坑点

1. **DeepSeek Function Calling + thinking 模式冲突**：`chat_with_tools` 必须加 `extra_body={"thinking": {"type": "disabled"}}`
2. **DeepSeek 多轮调用过渡语问题**：模型常说"让我查看..."但不调工具。已用 `_is_transitional()` 检测 + `tool_choice="required"` 强制
3. **DSML hallucinated tool calls**：DeepSeek 有时把 tool_calls 输出为文本格式。已用 `_clean_dsml()` 清理
4. **vis-network 抖动**：GraphView 不能放在 `overflow-auto` 容器中；切 tab 用 `hidden` 而非卸载
5. **Electron file:// 协议**：前端所有 fetch 必须检测协议，`file://` 时用 `http://localhost:8000` 完整 URL
6. **storage.py 原子写入**：所有 JSON 写操作用 `_atomic_write()`（tempfile + os.replace）
7. **scanner ID 一致性**：`scan_folder` 和 `scan_files` 都用 `rel_path` 的 MD5 生成 ID
8. **`.env` 含敏感 key**：不要 commit、不要泄露

---

## 🎨 前端设计模式

- **UI 框架**: Tailwind CSS，glass-morphism 风格
- **暗色/亮色**: `isDark` prop 层层传递
- **i18n**: `useLocale()` hook → `t('key')` 获取翻译
- **流式输出**: `chatWithDocsStream()` + SSE + 逐字更新 state
- **聊天记录**: localStorage 存储 `ChatSession[]`
- **拖拽上传**: `onDrop` + `file.path`（Electron 环境）

---

## 🔌 外部 Agent 接入

Agent（如 OpenClaw）接入方式：

1. 健康检查: `GET http://localhost:8000/health`
2. 能力发现: `GET http://localhost:8000/openapi.json`
3. 调用 API: `GET http://localhost:8000/agent/v1/search?graph=X&q=关键词`
4. 认证: Header `X-API-Key: xxx`（需在 .env 设置 `DOCGRAPH_AGENT_KEY`）

---

## 📋 最近改动记录

| 版本 | 内容 |
|------|------|
| v0.3.3 | GraphView 抖动修复、标签切换流畅 |
| v0.3.2 | Agent API 认证、健康检查、OpenAPI 导出 |
| v0.3.1 | 超级搜索 LLM、i18n、Electron DMG 打包 |
| v0.3.0 | 代码全面审查修复（12项 bug + 优化） |

---

## 🔮 待做 / 可扩展

1. **PDF 解析增强** — 表格识别/图片提取
2. **图谱对比视图** — 两个图谱并排看差异
3. **文档变更监控** — 监控文件夹变化，提示增量更新
4. **知识库 RAG** — 文档切片向量化，更精准的问答
5. **批量操作** — 图谱列表批量删除/分析
6. **导出 PDF/PNG** — 可视化结果导出

---

## 💡 快速接手核查

```bash
# 1. 启动后端
cd /Users/yiyangluo/Desktop/DocGraph/backend
python main.py

# 2. 健康检查
curl http://localhost:8000/health

# 3. 启动前端
cd ../frontend && npm run dev

# 4. 类型检查
npx tsc --noEmit

# 5. 测试超级搜索流式
curl -N -X POST http://localhost:8000/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"有哪些图谱"}]}'
```

读完这份文档，应该已经能接手了。Good luck 🚀
