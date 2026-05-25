"""文档关系图谱 - FastAPI 后端"""
import sys
from pathlib import Path

# 让 src 模块可以被 import
PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import json
import time

from src.scanner import scan_folder, diff_folder, scan_files
from src.storage import (
    save_graph, load_graph, list_graphs, write_relations, write_doc_meta,
    apply_doc_diff, RELATION_TYPES, DIRECTIONAL,
)
from src.llm_analyzer import analyze_all_docs, analyze_relations
from src.number_index import build_number_index, load_number_index, search_number, group_hits_by_doc
from src.recommender import recommend_related

from agent_api import router as agent_router
from shared import task_status
from routes.phase import router as phase_router
from routes.fullscan import router as fullscan_router
from routes.chat import router as chat_router

app = FastAPI(
    title="DocGraph API",
    version="2.1.0",
    description="AI-powered document relationship graph. Agent API available at /agent/v1/",
)

# CORS - 允许前端和外部 Agent 调用
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ========== API Key 认证中间件 ==========
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse


class APIKeyAuthMiddleware(BaseHTTPMiddleware):
    """对 /agent/v1/ 路径启用 API Key 认证。

    前端 /api/ 路径不需要认证（本地使用）。
    Agent 调用 /agent/v1/ 时需要在 Header 中传 X-API-Key。
    Key 存储在 .env 的 DOCGRAPH_AGENT_KEY 中，未设置则不启用认证。
    """
    async def dispatch(self, request: Request, call_next):
        if request.url.path.startswith("/agent/v1"):
            import os
            agent_key = os.getenv("DOCGRAPH_AGENT_KEY", "")
            if agent_key:  # 只有设置了 key 才启用认证
                provided = request.headers.get("X-API-Key", "")
                if provided != agent_key:
                    return JSONResponse(
                        status_code=401,
                        content={"detail": "Invalid or missing X-API-Key header"},
                    )
        return await call_next(request)


app.add_middleware(APIKeyAuthMiddleware)


# ========== 健康检查 ==========

@app.get("/health", tags=["system"])
def health_check():
    """健康检查端点。Agent 连接前调用此接口确认 App 在线。"""
    import os
    has_key = bool(os.getenv("OPENAI_API_KEY", "").strip())
    graph_names = list_graphs()
    return {
        "status": "ok",
        "version": "2.1.0",
        "graphs_loaded": len(graph_names),
        "api_key_configured": has_key,
        "agent_api": "/agent/v1/",
        "docs": "/docs",
        "openapi": "/openapi.json",
    }

# ========== 全局任务状态（从 shared 导入）==========
# task_status 定义在 shared.py 中，所有路由模块共享


# ========== 数据模型 ==========
class ScanRequest(BaseModel):
    folder: str
    name: str
    schema: Optional[str] = None  # 关系库 id（general/academic/work/code）


class ScanFromFilesRequest(BaseModel):
    name: str
    files: list[str]                   # 绝对路径列表
    common_root: Optional[str] = None  # 可选的公共根（算 rel_path）
    schema: Optional[str] = None


class AnalyzeRequest(BaseModel):
    graph_name: str
    model: Optional[str] = None
    mode: Optional[str] = "standard"  # fast | standard | deep


class NumberSearchRequest(BaseModel):
    graph_name: str
    query: str
    tolerance: float = 0.001
    use_llm: bool = False


class UpdateRequest(BaseModel):
    graph_name: str
    folder: Optional[str] = None  # 不填则使用图谱中存的 folder
    mode: Optional[str] = "standard"
    skip_relations: bool = False  # 跳过关系重推（仅同步文档）


class RelationUpdateRequest(BaseModel):
    graph_name: str
    relations: list[dict]


# ========== API 路由 ==========

@app.get("/api/graphs")
def api_list_graphs():
    """列出所有图谱"""
    graphs = []
    for name in list_graphs():
        data = load_graph(name)
        if data:
            graphs.append({
                "name": name,
                "doc_count": len(data.get("docs", [])),
                "relation_count": len(data.get("relations", [])),
            })
    return {"graphs": graphs}


@app.get("/api/graphs/{name}")
def api_get_graph(name: str):
    """获取图谱完整数据"""
    data = load_graph(name)
    if not data:
        raise HTTPException(404, f"图谱不存在: {name}")
    return data


@app.post("/api/scan")
def api_scan(req: ScanRequest):
    """扫描文件夹并创建图谱，如未指定 schema 则自动检测。"""
    docs = scan_folder(req.folder)
    if not docs:
        raise HTTPException(400, f"在 {req.folder} 没找到支持的文档")
    schema_id = req.schema
    detect_info = None
    if not schema_id:
        try:
            from src.relation_schemas import detect_schema
            detect_info = detect_schema(docs)
            schema_id = detect_info["schema"]
        except Exception as e:
            schema_id = "general"
            detect_info = {"schema": "general", "reason": f"检测失败: {e}"}
    path = save_graph(req.name, docs, [], folder=req.folder, schema=schema_id)
    return {
        "message": f"扫描到 {len(docs)} 个文档",
        "doc_count": len(docs),
        "path": path,
        "schema": schema_id,
        "schema_detection": detect_info,
    }


@app.post("/api/scan/from-files")
def api_scan_from_files(req: ScanFromFilesRequest):
    """从任意文件列表创建图谱。用于从全量扫描结果中选取一组文档创建图谱。"""
    docs = scan_files(req.files, common_root=req.common_root)
    if not docs:
        raise HTTPException(400, "传入的文件列表中没有可识别的文档")
    schema_id = req.schema
    detect_info = None
    if not schema_id:
        try:
            from src.relation_schemas import detect_schema
            detect_info = detect_schema(docs)
            schema_id = detect_info["schema"]
        except Exception as e:
            schema_id = "general"
            detect_info = {"schema": "general", "reason": f"检测失败: {e}"}
    folder_label = req.common_root or f"从全量扫描导入 ({len(docs)} 个文档)"
    path = save_graph(req.name, docs, [], folder=folder_label, schema=schema_id)
    return {
        "message": f"从文件列表创建图谱成功，共 {len(docs)} 个文档",
        "doc_count": len(docs),
        "path": path,
        "schema": schema_id,
        "schema_detection": detect_info,
    }


@app.get("/api/schemas")
def api_list_schemas():
    """返回所有可选的关系库。"""
    from src.relation_schemas import list_schemas, get_schema
    schemas = list_schemas()
    # 多返回每个关系的详细信息（方向、描述）
    for s in schemas:
        full = get_schema(s["id"])
        s["relation_details"] = full["relations"]
    return {"schemas": schemas}


class SchemaSetRequest(BaseModel):
    schema: str


@app.post("/api/graphs/{name}/schema")
def api_set_schema(name: str, req: SchemaSetRequest):
    """修改图谱的关系库（不会自动重推关系，需手动触发重推）。"""
    from src.relation_schemas import SCHEMAS
    if req.schema not in SCHEMAS:
        raise HTTPException(400, f"未知 schema: {req.schema}")
    g = load_graph(name)
    if not g:
        raise HTTPException(404, f"图谱不存在: {name}")
    g["schema"] = req.schema
    # 清掉不在新 schema 中的关系
    from src.relation_schemas import get_relation_types
    valid_types = set(get_relation_types(req.schema))
    g["relations"] = [r for r in g.get("relations", []) if r.get("type") in valid_types]
    from src.storage import DATA_DIR
    path = DATA_DIR / f"{name}.json"
    path.write_text(json.dumps(g, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"message": f"已切换到 {req.schema} 关系库", "schema": req.schema}


@app.post("/api/classify")
def api_classify(req: AnalyzeRequest, background_tasks: BackgroundTasks):
    """后台启动文档分类任务"""
    if task_status["classify"]["running"]:
        raise HTTPException(409, "分类任务正在进行中")

    def run_classify():
        task_status["classify"] = {"running": True, "progress": 0, "total": 0, "current": "", "result": None}
        try:
            def cb(done, total, name):
                task_status["classify"]["progress"] = done
                task_status["classify"]["total"] = total
                task_status["classify"]["current"] = name

            result = analyze_all_docs(req.graph_name, model=req.model, mode=req.mode or "standard", progress_cb=cb)
            task_status["classify"]["result"] = {
                "doc_count": result["doc_count"],
                "total_tokens": result["total_tokens"],
            }
        except Exception as e:
            task_status["classify"]["result"] = {"error": str(e)}
        finally:
            task_status["classify"]["running"] = False

    background_tasks.add_task(run_classify)
    return {"message": "分类任务已启动"}


@app.post("/api/relations")
def api_relations(req: AnalyzeRequest, background_tasks: BackgroundTasks):
    """后台启动关系推断任务"""
    if task_status["relations"]["running"]:
        raise HTTPException(409, "关系推断任务正在进行中")

    def run_relations():
        task_status["relations"] = {"running": True, "progress": 0, "total": 1, "current": "推断中...", "result": None}
        try:
            result = analyze_relations(req.graph_name, model=req.model, mode=req.mode or "standard")
            task_status["relations"]["result"] = {
                "relation_count": len(result["relations"]),
                "pair_count": result["pair_count"],
                "group_count": result["group_count"],
                "tokens": result["tokens"],
            }
        except Exception as e:
            task_status["relations"]["result"] = {"error": str(e)}
        finally:
            task_status["relations"]["running"] = False

    background_tasks.add_task(run_relations)
    return {"message": "关系推断任务已启动"}


# ========== 增量更新 ==========

def _resolve_folder(graph_name: str, folder: Optional[str]) -> str:
    if folder:
        return folder
    g = load_graph(graph_name)
    if not g:
        raise HTTPException(404, f"图谱不存在: {graph_name}")
    f = g.get("folder")
    if not f:
        raise HTTPException(
            400,
            "该图谱未记录扫描源目录（可能是旧版本创建的），请在请求体中传 folder 参数",
        )
    return f


@app.post("/api/update/preview")
def api_update_preview(req: UpdateRequest):
    """预览增量更新会发生什么变化，不写入。"""
    folder = _resolve_folder(req.graph_name, req.folder)
    g = load_graph(req.graph_name)
    if not g:
        raise HTTPException(404, f"图谱不存在: {req.graph_name}")
    diff = diff_folder(folder, g.get("docs", []))

    # 输出轻量信息，不携 text
    def _slim(d):
        return {
            "id": d["id"], "name": d["name"], "rel_path": d["rel_path"],
            "size": d.get("size"), "mtime": d.get("mtime"),
        }
    deleted_docs = [
        _slim(d) for d in g.get("docs", []) if d["id"] in set(diff["deleted_ids"])
    ]
    return {
        "folder": folder,
        "added": [_slim(d) for d in diff["added"]],
        "modified": [_slim(d) for d in diff["modified"]],
        "deleted": deleted_docs,
        "unchanged_count": len(diff["unchanged_ids"]),
    }


@app.post("/api/update")
def api_update(req: UpdateRequest, background_tasks: BackgroundTasks):
    """增量更新图谱：同步变化 → 重分类(仅变化文档) → 重推关系。"""
    if task_status["update"]["running"] or task_status["classify"]["running"] or task_status["relations"]["running"]:
        raise HTTPException(409, "已有任务在运行中")

    folder = _resolve_folder(req.graph_name, req.folder)

    def run_update():
        st = task_status["update"]
        st.update({
            "running": True, "progress": 0, "total": 0,
            "current": "", "result": None, "phase": "diff",
        })
        try:
            # 1. diff
            g = load_graph(req.graph_name)
            if not g:
                raise ValueError(f"图谱不存在: {req.graph_name}")
            diff = diff_folder(folder, g.get("docs", []))
            change_count = len(diff["added"]) + len(diff["modified"]) + len(diff["deleted_ids"])
            st["current"] = f"变化: +{len(diff['added'])} ~{len(diff['modified'])} -{len(diff['deleted_ids'])}"
            st["total"] = max(change_count, 1)

            # 2. 应用 doc 差量
            st["phase"] = "sync"
            sync_summary = apply_doc_diff(
                req.graph_name,
                added=diff["added"],
                modified=diff["modified"],
                deleted_ids=diff["deleted_ids"],
                folder=folder,
            )

            # 3. 如果有新增/修改 → 跑 LLM 分析(仅这些文档)
            analyze_ids = [d["id"] for d in diff["added"]] + [d["id"] for d in diff["modified"]]
            classify_summary = None
            if analyze_ids:
                st["phase"] = "classify"
                st["progress"] = 0
                st["total"] = len(analyze_ids)
                def cb(done, total, name):
                    st["progress"] = done
                    st["total"] = total
                    st["current"] = name
                cls_res = analyze_all_docs(
                    req.graph_name, mode=req.mode or "standard",
                    progress_cb=cb, only_doc_ids=analyze_ids,
                )
                classify_summary = {
                    "doc_count": cls_res["doc_count"],
                    "total_tokens": cls_res["total_tokens"],
                }

            # 4. 如果有任何变化 且 未跳过关系 → 重推关系
            relations_summary = None
            if change_count > 0 and not req.skip_relations:
                st["phase"] = "relations"
                st["progress"] = 0
                st["total"] = 1
                st["current"] = "重推关系中..."
                rel_res = analyze_relations(req.graph_name, mode=req.mode or "standard")
                relations_summary = {
                    "relation_count": len(rel_res["relations"]),
                    "pair_count": rel_res["pair_count"],
                    "group_count": rel_res["group_count"],
                    "tokens": rel_res["tokens"],
                }

            st["phase"] = "done"
            st["result"] = {
                "sync": sync_summary,
                "classify": classify_summary,
                "relations": relations_summary,
                "folder": folder,
            }
        except Exception as e:
            st["result"] = {"error": str(e)}
            st["phase"] = "error"
        finally:
            st["running"] = False

    background_tasks.add_task(run_update)
    return {"message": "增量更新任务已启动", "folder": folder}


@app.get("/api/task/{task_name}")
def api_task_status(task_name: str):
    """查询后台任务状态"""
    if task_name not in task_status:
        raise HTTPException(404, f"未知任务: {task_name}")
    return task_status[task_name]


@app.post("/api/number/build-index")
def api_build_number_index(req: AnalyzeRequest):
    """构建数字索引"""
    idx = build_number_index(req.graph_name)
    return {"number_count": idx["number_count"], "doc_count": idx["doc_count"]}


@app.post("/api/number/search")
def api_number_search(req: NumberSearchRequest):
    """搜索数字"""
    idx = load_number_index(req.graph_name)
    if not idx:
        raise HTTPException(400, "请先构建数字索引")

    hits = search_number(idx, req.query, tol=req.tolerance, fuzzy=True)
    grouped = group_hits_by_doc(hits)

    result = {"total_hits": len(hits), "doc_count": len(grouped), "groups": grouped}

    if req.use_llm and hits:
        try:
            from src.number_tracer import trace_number
            llm_result = trace_number(req.query, hits)
            result["llm_trace"] = llm_result
        except Exception as e:
            result["llm_trace"] = {"error": str(e)}

    return result


@app.delete("/api/graphs/{name}/relations/{index}")
def api_delete_relation(name: str, index: int, src: str = "", dst: str = "", rel_type: str = ""):
    """删除单条关系。支持两种方式：
    1. 纯 index（旧方式，兼容）
    2. src + dst + rel_type 精确匹配（推荐，防止并发索引偏移）
    """
    data = load_graph(name)
    if not data:
        raise HTTPException(404, f"图谱不存在: {name}")
    relations = data.get("relations", [])

    # 优先用精确匹配（更安全）
    if src and dst and rel_type:
        target_idx = None
        for i, r in enumerate(relations):
            if r.get("from") == src and r.get("to") == dst and r.get("type") == rel_type:
                target_idx = i
                break
        if target_idx is None:
            raise HTTPException(404, f"未找到匹配关系: {src} → {dst} ({rel_type})")
        relations.pop(target_idx)
    else:
        # 兼容旧的 index 模式
        if index < 0 or index >= len(relations):
            raise HTTPException(400, f"索引越界: {index}")
        relations.pop(index)

    data["relations"] = relations
    from src.storage import DATA_DIR
    path = DATA_DIR / f"{name}.json"
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"message": "已删除", "remaining": len(relations)}


class GraphRenameRequest(BaseModel):
    new_name: str


@app.post("/api/graphs/{name}/rename")
def api_rename_graph(name: str, req: GraphRenameRequest):
    """重命名图谱"""
    from src.storage import DATA_DIR
    new_name = req.new_name.strip()
    if not new_name:
        raise HTTPException(400, "新名称不能为空")
    if new_name == name:
        return {"name": name}
    path = DATA_DIR / f"{name}.json"
    if not path.exists():
        raise HTTPException(404, f"图谱不存在: {name}")
    new_path = DATA_DIR / f"{new_name}.json"
    if new_path.exists():
        raise HTTPException(409, f"图谱「{new_name}」已存在")
    # 重命名文件
    path.rename(new_path)
    # 更新内部 name 字段
    with open(new_path, encoding="utf-8") as f:
        data = json.load(f)
    data["name"] = new_name
    with open(new_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    # 数字索引也重命名
    idx_path = DATA_DIR / f"{name}_numbers.json"
    if idx_path.exists():
        idx_path.rename(DATA_DIR / f"{new_name}_numbers.json")
    return {"name": new_name}


@app.delete("/api/graphs/{name}")
def api_delete_graph(name: str):
    """删除整个图谱"""
    from src.storage import DATA_DIR
    path = DATA_DIR / f"{name}.json"
    if not path.exists():
        raise HTTPException(404, f"图谱不存在: {name}")
    path.unlink()
    # 也删除数字索引（如有）
    idx_path = DATA_DIR / f"{name}_numbers.json"
    if idx_path.exists():
        idx_path.unlink()
    return {"message": f"已删除图谱: {name}"}


class DocMetaUpdate(BaseModel):
    category: Optional[str] = None
    keywords: Optional[list[str]] = None
    summary: Optional[str] = None
    phase: Optional[str] = None
    people: Optional[list[str]] = None
    metrics: Optional[list[dict]] = None


@app.patch("/api/graphs/{name}/docs/{doc_id}")
def api_update_doc_meta(name: str, doc_id: str, update: DocMetaUpdate):
    """手动修改文档的分类/关键词/摘要/阶段/人物"""
    data = load_graph(name)
    if not data:
        raise HTTPException(404, f"图谱不存在: {name}")
    docs = data.get("docs", [])
    target = None
    for doc in docs:
        if doc["id"] == doc_id:
            target = doc
            break
    if not target:
        raise HTTPException(404, f"文档不存在: {doc_id}")
    # 只更新非 None 的字段
    patch = update.model_dump(exclude_none=True)
    for k, v in patch.items():
        target[k] = v
    from src.storage import DATA_DIR
    path = DATA_DIR / f"{name}.json"
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"message": "已更新", "doc_id": doc_id, "updated_fields": list(patch.keys())}


@app.get("/api/config")
def api_config(graph: Optional[str] = None):
    """返回前端需要的配置信息。如传入 graph 名称，则返回该图谱对应 schema 的关系类型。"""
    from src.relation_schemas import get_relation_types, get_directional, get_schema
    if graph:
        g = load_graph(graph)
        sid = (g and g.get("schema")) or "general"
    else:
        sid = "general"
    rts = get_relation_types(sid)
    return {
        "relation_types": rts,
        "directional_types": list(get_directional(sid)),
        "schema": sid,
        "schema_name": get_schema(sid)["name"],
    }


@app.get("/api/graphs/{name}/related/{doc_id}")
def api_get_related(name: str, doc_id: str, top_n: int = 8):
    """获取相关文档（前端专用）"""
    g = load_graph(name)
    if not g:
        raise HTTPException(404, f"图谱不存在: {name}")
    related = recommend_related(g, doc_id, top_n=top_n)
    return {"related": related}


# ========== 应用设置 API ==========

class SettingsUpdate(BaseModel):
    language: Optional[str] = None
    deepseek_api_key: Optional[str] = None
    deepseek_model: Optional[str] = None
    vision_api_key: Optional[str] = None
    vision_model: Optional[str] = None


@app.get("/api/settings")
def api_get_settings():
    """获取当前设置（不暴露完整 key，只显示前6位+***）"""
    import os
    from dotenv import load_dotenv
    env_path = Path(os.environ.get("DOCGRAPH_ENV_PATH", str(Path(__file__).parent.parent / ".env")))
    load_dotenv(env_path, override=True)

    def mask_key(key: str) -> str:
        if not key or len(key) < 8:
            return ""
        return key[:6] + "***"

    # 读取 language 设置（存在 .env 中）
    language = os.getenv("APP_LANGUAGE", "zh")

    return {
        "language": language,
        "deepseek_api_key": mask_key(os.getenv("OPENAI_API_KEY", "")),
        "deepseek_base_url": os.getenv("OPENAI_BASE_URL", "https://api.deepseek.com"),
        "deepseek_model": os.getenv("LLM_MODEL", "deepseek-v4-flash"),
        "vision_api_key": mask_key(os.getenv("VISION_API_KEY", "")),
        "vision_base_url": os.getenv("VISION_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3"),
        "vision_model": os.getenv("VISION_MODEL", ""),
    }


@app.post("/api/settings")
def api_update_settings(req: SettingsUpdate):
    """更新设置（写入 .env 文件）"""
    env_path = Path(os.environ.get("DOCGRAPH_ENV_PATH", str(Path(__file__).parent.parent / ".env")))

    # 读取现有内容
    lines = []
    if env_path.exists():
        lines = env_path.read_text(encoding="utf-8").splitlines()

    def set_env_var(key: str, value: str):
        nonlocal lines
        found = False
        for i, line in enumerate(lines):
            if line.strip().startswith(f"{key}=") or line.strip().startswith(f"# {key}="):
                lines[i] = f"{key}={value}"
                found = True
                break
        if not found:
            lines.append(f"{key}={value}")

    if req.language is not None:
        set_env_var("APP_LANGUAGE", req.language)
    if req.deepseek_api_key is not None and not req.deepseek_api_key.endswith("***"):
        set_env_var("OPENAI_API_KEY", req.deepseek_api_key)
    if req.deepseek_model is not None:
        set_env_var("LLM_MODEL", req.deepseek_model)
    if req.vision_api_key is not None and not req.vision_api_key.endswith("***"):
        set_env_var("VISION_API_KEY", req.vision_api_key)
    if req.vision_model is not None:
        set_env_var("VISION_MODEL", req.vision_model)

    # 写回 .env
    env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    # 重新加载环境变量到当前进程
    import os as _os
    from dotenv import load_dotenv
    load_dotenv(env_path, override=True)

    # 清除 LLM 客户端缓存（使新 key 生效）
    try:
        from src.llm_client import _client_cache
        _client_cache.clear()
    except Exception:
        pass

    return {"message": "设置已更新", "restart_required": False}


# ========== 挂载子路由 ==========
app.include_router(agent_router)
app.include_router(phase_router)
app.include_router(fullscan_router)
app.include_router(chat_router)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
