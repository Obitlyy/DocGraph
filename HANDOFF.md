# DocGraph - Agent 接手文档

> 这是给下一个接手的 AI Agent 看的项目交接文档。读完这一份就够了，可以快速上手。

## 🎯 项目是什么

**DocGraph** 是一个文档关系图谱工具。

把一个文件夹丢给它 → 自动扫描所有文档 → LLM 分类、提取关键词、生成摘要 → 推断文档之间的关系 → 在前端可视化成图谱、列表、流程图等多种视图。

**典型用例**：研究项目的资料整理、课程材料梳理、工作项目复盘、代码项目文档分析。

**当前用户**：罗一扬（Obit），简洁高效，不喜欢废话，喜欢可对比的表格/方案，会发截图反馈视觉问题。

---

## 📂 项目结构

```
/Users/yiyangluo/Desktop/DocGraph/
├── .env                         # 🔑 API key 和模型配置（敏感）
├── README.md                    # 用户文档
├── HANDOFF.md                   # 👈 你正在读的这份
├── start.sh                     # 启动脚本
├── backend/
│   └── main.py                  # FastAPI 后端，端口 8000
├── src/                         # ⭐ 核心代码（实际使用的）
│   ├── scanner.py               # 文件夹扫描 + 多格式解析（含图片视觉）
│   ├── llm_client.py            # DeepSeek API 封装
│   ├── llm_analyzer.py          # 分类、关系、群组分析
│   ├── relation_schemas.py      # 🆕 场景化关系库（4 种 schema）
│   ├── storage.py               # 图谱持久化（JSON）
│   ├── phase_analyzer.py        # 阶段分析
│   ├── number_extractor.py      # 时间/数字提取
│   ├── full_scan.py             # 🆕 全量扫描 + 聚合算法
│   ├── deep_explore.py          # 🆕 深度探索（跨组关联发现）
│   └── ...
├── src_legacy/                  # ⚠️ 老代码，已废弃。改 src/ 即可
├── data/                        # 图谱 JSON 文件存放（每个图一个 .json）
│   └── fullscans/               # 🆕 全量扫描历史
└── frontend/                    # React + Vite 前端，端口 3000
    └── src/
        ├── App.tsx              # 三功能切换（文档图谱/全量扫描/超级搜索）
        ├── api.ts               # 后端 API client
        ├── features/
        │   ├── GraphFeature.tsx       # 文档图谱主界面
        │   ├── FullScanFeature.tsx    # 🆕 全量扫描
        │   └── SuperSearchFeature.tsx # TODO 占位
        └── components/
            ├── Sidebar.tsx
            ├── GraphView.tsx
            ├── DocDetail.tsx
            ├── RelationList.tsx
            ├── PhaseFlowChart.tsx
            ├── ClusterUniverse.tsx    # 🆕 圆圈宇宙（嵌套聚合可视化）
            ├── UpdatePreviewModal.tsx
            └── SettingsModal.tsx
```

---

## 🚀 启动方式

### 后端
```bash
cd /Users/yiyangluo/Desktop/DocGraph/backend
python main.py
# 或者
python -m uvicorn backend.main:app --reload --port 8000
```
> ⚠️ 必须用 `python`（不是 `python3`）。系统 python 在 `/Users/yiyangluo/.local/lib/openclaw-internal/runtime/python/bin/python`，已装好 fastapi/pymupdf/python-pptx/Pillow/openai 等。

### 前端
```bash
cd /Users/yiyangluo/Desktop/DocGraph/frontend
npm run dev
```
访问 `http://localhost:3000`

### 杀进程（端口被占）
```bash
kill $(lsof -ti :8000)
kill $(lsof -ti :3000)
```

---

## 🧠 核心概念

### 1. 三大功能模块（顶部滑块切换）
- **文档图谱**：传统模式，扫描一个文件夹 → 深度分析 → 图谱可视化
- **全量扫描**（🆕 5月22日）：宽度模式，扫描多个根目录 → 算法+LLM 聚合 → 圆圈宇宙 → 一键同步到图谱
- **超级搜索**：TODO，对话式调用所有文档 API

### 2. 三种分析模式
配置在 `src/llm_analyzer.py` 的 `ANALYSIS_MODES`：

| 模式 | 模型 | 思考 | 适用 |
|------|------|------|------|
| `fast` | deepseek-v4-flash | ❌ | 快速浏览，最低成本 |
| `standard` | deepseek-v4-flash | ❌ | 默认，平衡（推荐） |
| `deep` | deepseek-reasoner | ✅ | 高质量，慢但准 |

**注意**：deep 模式的 `max_tokens_pair=16000`（之前 8000 不够，会被 reasoning tokens 占满导致输出空 JSON）。

### 3. 文档分析两阶段
1. **逐文档**：分类 + 关键词 + 摘要 + 人物（`analyze_one_doc`）
2. **整图**：先 pair 关系（`analyze_relations`），再 group（同一批次）

### 4. 🆕 场景化关系库（核心创新）
定义在 `src/relation_schemas.py`，4 个预置 schema：

| Schema | 关系类型 |
|--------|---------|
| **general** | 提供数据/浓缩版本/旧版本/衍生文档/引用参考/同一项目/同一批次 |
| **academic** | 前置知识/理论支撑/实践应用/习题对应/同周课程/考点呼应/参考文献/同一章节/旧版本 |
| **work** | 立项依据/需求来源/阶段交付/汇报浓缩/复盘对应/决策依据/协作产出/版本迭代/引用参考 |
| **code** | 接口实现/依赖引用/配置驱动/测试对应/文档说明/API 引用/部署对应/模块协作/版本迭代 |

**自动选择**：扫描时 `detect_schema()` 让 LLM 看文件清单决定用哪个库。MIS2001 课程 → academic（置信度 0.95）。

**关键 API**：
- `format_relations_for_prompt(schema_id)` 生成 prompt 文本
- `get_relation_types(schema_id)` 获取关系类型集合
- `get_directional(schema_id)` 获取有向关系集合
- `PAIR_PROMPT_TEMPLATE` 在 `llm_analyzer.py` 里被动态填充

### 5. 🆕 全量扫描（5月22日上线）

**工作流**：
1. **选择根目录**：Desktop/Documents/Downloads 或自定义
2. **选择子目录**：默认勾选文件数 ≥10 的
3. **扫描+聚合**：
   - 算法预聚合（顶层目录 → project；散文件按 prefix → pattern；剩余按 ext_kind → orphan）
   - 可选 LLM 重审（重命名/类型/info_score/redundant 标记）
4. **圆圈宇宙可视化**：
   - 父子圆 DOM 嵌套（拖父带子）
   - 多环力导布局（子圆 ≤4 环形，>4 中心+外环）
   - 支持 pan/zoom、点击详情、多选合并、拆分、冗余筛选
5. **一键同步到图谱**：勾选跨组关联 → 把外部文件 import 到已有图谱 → 标记 `external: true` + 琥珀色虚线

**核心算法**：
- `pre_cluster()`: 嵌套聚合，扫描根 ≥30 文件且 ≥2 个子目录各 ≥5 文件 → 下钻父子群
- `llm_review_clusters()`: LLM 重审，调整 label/kind/info_score/redundant

**关键视觉**：`ClusterUniverse.tsx` 纯 HTML/CSS，力导顶层+极坐标子圆，莫兰迪配色，配色双套（亮/暗）。

### 6. 深度探索（5月22日 17:25）

**功能**：全量扫描时可开启，自动发现不同组文件之间的潜在逻辑关联（重复造轮子/共享数据/上下游/引用参考/版本迭代/相同主题）。

**三阶段**：
1. `summarize_files`: 批量 LLM 生成一句话摘要（每批 20 个）
2. `find_candidates`: 组间摘要比对 → 候选 pairs（每批 8 对，最多 50 对）
3. `confirm_links`: 精读确认（批量 5 对，读 2000 字 → 判断 confirmed/type/detail）

**可视化**：
- `ClusterUniverse` SVG 虚线连接有关联的两个圆心（opacity 和 confidence 正相关）
- `CrossLinkPanel` 侧边面板：列表/详情双视图，支持多选同步到图谱

---

## 📦 支持的文件格式（73 种）

定义在 `src/scanner.py`：

- **DOC_EXTS** (13)：md/txt/rst/tex/docx/xlsx/pdf/pptx/csv/json/html/htm/epub
- **CODE_EXTS** (52)：py/js/ts/go/rs/java/swift/kt/rb/php/sh/sql/yaml/toml/xml...
- **IMAGE_EXTS** (8)：png/jpg/jpeg/gif/webp/bmp/tiff/svg

**自动跳过**：`node_modules/__pycache__/venv/dist/build/.git/.idea/.vscode` 等垃圾目录。

### Token 限制
都已经放开了：
- 扫描时单文档：`MAX_TEXT_CHARS = 200000` 字
- LLM 分析：fast 6k / standard 15k / deep 50k 字（从原来的 1.5k/3k/6k）

---

## 🖼️ 多模态视觉识别

### 配置文件
**`/Users/yiyangluo/Desktop/DocGraph/.env`**

当前已配置火山方舟豆包：
```
VISION_MODEL=doubao-seed-1-6-250615
VISION_API_KEY=ark-9beb09...（已填）
VISION_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
```

### 工作机制
- 扫描遇到图片 → 先提取尺寸/格式元数据
- 如果配了 `VISION_MODEL` → 调豆包识别内容（base64 + OpenAI 兼容协议）
- 写入文档 `text` 字段，参与后续分类/关系推断
- 实测 13 秒/张图（小图）

### 兼容厂商
都走 OpenAI SDK 协议：
- 火山方舟豆包（推荐）
- OpenAI GPT-4o
- 通义千问 Qwen-VL
- 智谱 GLM-4V

---

## 🔌 关键 API 端点

后端：`http://localhost:8000`

### 文档图谱
| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/scan` | POST | 扫描文件夹（自动检测 schema） |
| `/api/schemas` | GET | 列出所有可用关系库 |
| `/api/graphs/{name}/schema` | POST | 切换图谱关系库 |
| `/api/config?graph={name}` | GET | 获取图谱关系类型配置 |
| `/api/classify` | POST | 启动文档分类（异步任务） |
| `/api/relations` | POST | 启动关系分析（异步任务） |
| `/api/task/{kind}` | GET | 轮询任务进度 |
| `/api/graphs` | GET | 列出所有图谱 |
| `/api/graphs/{name}` | GET | 图谱详情 |
| `/api/graphs/{name}` | DELETE | 删除图谱 |
| `/api/graphs/{name}/rename` | POST | 重命名图谱 |
| `/api/graphs/{name}/related/{doc_id}` | GET | 文档的关联文档 |
| `/api/update/preview` | POST | 增量更新预览 |
| `/api/update` | POST | 启动增量更新（异步任务） |

### 全量扫描
| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/fullscan/defaults` | GET | 默认根目录列表 |
| `/api/fullscan/list` | POST | 列出选定根的子目录 |
| `/api/fullscan/scan` | POST | 启动异步扫描任务 |
| `/api/fullscan/status` | GET | 轮询进度 |
| `/api/fullscan/result` | GET | 拿最终聚合结果 |
| `/api/fullscan/history` | GET | 扫描历史列表（metadata） |
| `/api/fullscan/history/{id}` | GET | 加载完整结果 |
| `/api/fullscan/history/{id}` | DELETE | 删除扫描历史 |
| `/api/fullscan/history/{id}/rename` | POST | 改名 |
| `/api/fullscan/history/{id}/clusters/{cid}` | PATCH | 改群属性 |
| `/api/fullscan/history/{id}/clusters/{cid}` | DELETE | 删群 |
| `/api/fullscan/history/{id}/clusters/merge` | POST | 多群合并 |
| `/api/fullscan/history/{id}/clusters/{cid}/split` | POST | 拆群 |
| `/api/fullscan/history/{scan_id}/cross-links/apply` | POST | 一键同步到图谱 |

---

## ⚠️ 已知坑点

1. **`src/` vs `src_legacy/`**：内容相同但只改 `src/`。后端 `import` 走的是 `src/`。
2. **不要乱改 RELATION_TYPES**：现在它从 `relation_schemas.py` 动态生成（兼容老代码）。`storage.write_relations` 用图谱自身 schema 校验。
3. **deep 模式的 token 预算**：reasoner 思考会占大量 tokens，输出 token 必须给足。改过 `max_tokens_pair=16000`。
4. **图片大于 10MB**：自动跳过视觉识别（避免 API 拒绝）。
5. **PhaseFlowChart 标签宽度**：必须按字符精确算（中文 11px、ASCII 6px），不能用 `length*8` 估算。`GAP_X = max(90, maxLabelW + 50)` 防重叠。
6. **`.env` 含敏感 key**：不要 commit、不要泄露。
7. **全量扫描 LLM 调用错误**：`chat()` 函数签名是 `chat(prompt: str, *, system, json_mode, ...)` 不是 `chat(messages=[...])`。结果加 `llm_used: bool` 透出真假。
8. **vis-network 不擅长嵌套**：父子节点靠弹簧拉只能软约束，关物理就散架。真嵌套 = DOM 嵌套。

---

## 🐛 排错速查

| 症状 | 排查方向 |
|------|---------|
| 关系数为 0 | 检查 deep 模式 `max_tokens` 是否够（已改 16k）；看 `data/{name}.json` 的 schema 字段 |
| 图片识别失败 | 检查 `.env` 的 `VISION_API_KEY`；图片是否 >10MB；豆包推理接入点是否开通 |
| 扫描文档数少 | 看 `SUPPORTED_EXTS` 是否覆盖；`IGNORE_DIRS` 是否误杀 |
| 后端启动报错 `ModuleNotFoundError` | `pip install -r requirements.txt`，或单装：`pip install fastapi uvicorn pymupdf python-pptx Pillow openai python-dotenv openpyxl python-docx` |
| 端口被占 | `kill $(lsof -ti :8000)` |
| 前端白屏 | 看控制台错误，或读 ErrorBoundary 输出 |
| 全量扫描圆圈重叠 | 子圆数 >8 时布局会挤，可调 `layoutChildren` 的环数/力导步数 |

---

## 📋 测试数据集

`/Users/yiyangluo/Desktop/MIS2001` —— 25 个文件，1 .xlsx + 5 .docx + ~17 PDFs，课程材料。
- 自动检测 → academic schema（置信度 0.95）
- standard 模式实测：17 条 pair 关系 + 4 个 group ✅

---

## 🎨 用户偏好（Obit / 罗一扬）

- 简洁高效，不寒暄
- 表格 > 大段文字
- 会发截图反馈视觉 bug，要快速迭代
- 主要场景：咨询研究 + AI 小工具研发
- 时区：Asia/Shanghai

---

## 🔮 未完成 / 可扩展

1. ~~**前端 schema 选择器**~~：后端 API 都有了，前端 Sidebar 还没加 UI（用户当前用自动检测）
2. **代码项目实测**：code schema 还没用真实代码项目验证关系效果
3. **更多视觉模型测试**：目前只验证了豆包，其他厂商兼容性未实测
4. **增量扫描**：`save_graph` 已经记录 `folder` 字段，但还没加"重新扫描时只增量加新文件"的逻辑
5. **关系编辑 UI**：用户能否手动添加/删除关系（目前只能 LLM 推断）
6. **超级搜索功能**：对话式调用所有文档 API 的 LLM
7. **全量扫描子圆详情强化**：子圆点击进入详情已支持，但视觉反馈可加强
8. **全量扫描结果持久化**：已实现（`data/fullscans/*.json`）
9. **跨组关联一键同步预览**：让用户先看哪些 link 能匹配上图谱再勾选

---

## 💡 快速接手核查清单

```bash
# 1. 看启动是否正常
cd /Users/yiyangluo/Desktop/DocGraph/backend && python main.py

# 2. 跑一遍扫描验证流程（另开终端）
curl -X POST http://localhost:8000/api/scan \
  -H "Content-Type: application/json" \
  -d '{"folder":"/Users/yiyangluo/Desktop/MIS2001","name":"test"}' | python -m json.tool

# 3. 看 schema 是否自动识别
# 应返回 schema_detection.schema = "academic"

# 4. 清理测试图谱
curl -X DELETE http://localhost:8000/api/graphs/test

# 5. 测试全量扫描
curl -s http://localhost:8000/api/fullscan/history | python -m json.tool

# 6. 前端类型检查
cd /Users/yiyangluo/Desktop/DocGraph/frontend && npx tsc --noEmit
```

读完这份文档，应该已经能接手了。有什么不清楚的看 `README.md` 或直接读源码，最近改动都集中在 `relation_schemas.py`、`scanner.py`、`llm_analyzer.py`、`full_scan.py`、`deep_explore.py`。

Good luck 🚀
