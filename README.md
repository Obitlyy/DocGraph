# DocGraph v2 — 文档关系图谱

独立的前后端分离应用，Mac 本地运行，调用 DeepSeek API 进行文档分析。

## 架构

```
app_v2/
├── backend/          # FastAPI 后端
│   └── main.py       # REST API 入口
├── frontend/         # React + Vite 前端
│   └── src/
│       ├── App.tsx
│       ├── api.ts    # API 调用封装
│       └── components/
│           ├── GraphView.tsx    # vis-network 图谱可视化
│           ├── DocList.tsx      # 文档列表
│           ├── RelationList.tsx # 关系管理
│           ├── DocDetail.tsx    # 文档详情面板
│           └── Sidebar.tsx      # 侧边栏控制
├── start.sh          # 一键启动
└── README.md
```

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Python 3.11+ / FastAPI / Uvicorn |
| 前端 | React 19 / TypeScript / Vite / Tailwind CSS |
| 图谱可视化 | vis-network |
| AI 分析 | DeepSeek API (兼容 OpenAI SDK) |
| 数据存储 | JSON 文件 (`data/` 目录) |

## 快速启动

```bash
# 1. 确保 .env 配置了 API Key
cat ../env
# OPENAI_API_KEY=sk-xxx
# OPENAI_BASE_URL=https://api.deepseek.com
# LLM_MODEL=deepseek-v4-flash

# 2. 一键启动
./start.sh
```

启动后：
- 前端: http://localhost:3000
- 后端: http://localhost:8000
- API 文档: http://localhost:8000/docs (Swagger UI)

## 功能

### 核心能力
1. **扫描文件夹** → 自动识别 .md / .docx / .xlsx / .txt
2. **AI 分类** → 为每个文档生成：分类、关键词、摘要、人物、阶段
3. **AI 关系推断** → 识别 7 种关系：提供数据、浓缩版本、旧版本、衍生文档、引用参考、同一项目、同一批次
4. **交互式图谱** → 力导向布局、点击查看详情、按类型/置信度过滤
5. **数字溯源** → 搜索文档中的数字，追踪数据源头

### vs Streamlit 旧版

| 维度 | Streamlit (旧) | 前后端分离 (新) |
|------|---------------|---------------|
| 性能 | 每次交互全刷新 | 局部更新 |
| 体验 | 受限于 Streamlit 组件 | 完全自定义 UI |
| 可视化 | streamlit-agraph (有限) | vis-network (强大) |
| 部署 | 需要 streamlit 环境 | 独立可打包 |
| 依赖 | 需要 Agent 在环 | 完全独立 |

## API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/graphs` | GET | 列出所有图谱 |
| `/api/graphs/:name` | GET | 获取图谱数据 |
| `/api/scan` | POST | 扫描文件夹 |
| `/api/classify` | POST | 启动分类(后台) |
| `/api/relations` | POST | 启动关系推断(后台) |
| `/api/task/:name` | GET | 查询任务进度 |
| `/api/number/build-index` | POST | 构建数字索引 |
| `/api/number/search` | POST | 搜索数字 |

## 后续可扩展

- [ ] Electron 打包为 .app
- [ ] 拖拽上传文件夹
- [ ] 多图谱对比
- [ ] 导出为 PDF 报告
- [ ] 支持 PDF 文档解析
