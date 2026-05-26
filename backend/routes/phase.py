"""阶段（Phase）相关 API 路由。"""
import json
from typing import Optional
from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel

from src.storage import load_graph, write_doc_meta, DATA_DIR
from shared import task_status, task_lock

router = APIRouter(prefix="/api", tags=["phases"])


# ========== 数据模型 ==========

class PhaseConfirmRequest(BaseModel):
    graph_name: str
    phases: list[dict]
    generate_summaries: bool = True
    model: Optional[str] = None


class PhasesSaveRequest(BaseModel):
    phases: list[dict]


class PhasesAutoUpdateRequest(BaseModel):
    generate_summaries_for_new: bool = True
    model: Optional[str] = None


class PhaseFlowRequest(BaseModel):
    model: Optional[str] = None


class CategoryMergeRequest(BaseModel):
    mapping: dict[str, str]


class CategoryRenameRequest(BaseModel):
    old_name: str
    new_name: str


# ========== 阶段路由 ==========

@router.get("/graphs/{name}/phases/propose")
def api_phases_propose(name: str, refine: bool = True):
    """提议阶段划分（不写入）。"""
    from src.phase_analyzer import propose_phases, refine_phases_with_llm
    g = load_graph(name)
    if not g:
        raise HTTPException(404, f"图谱不存在: {name}")
    r = propose_phases(name)
    if refine and r["candidates"]:
        r["candidates"] = refine_phases_with_llm(r["candidates"], g)
    return r


@router.get("/graphs/{name}/phases")
def api_phases_get(name: str):
    """获取已保存的阶段。"""
    g = load_graph(name)
    if not g:
        raise HTTPException(404, f"图谱不存在: {name}")
    return {"phases": g.get("phases", [])}


@router.post("/graphs/{name}/phases/confirm")
def api_phases_confirm(name: str, req: PhaseConfirmRequest, background_tasks: BackgroundTasks):
    """确认阶段划分，可选后台生成总结。"""
    with task_lock:
        if task_status["phases"]["running"]:
            raise HTTPException(409, "阶段任务运行中")

    from src.phase_analyzer import save_phases, summarize_phase, flatten_phases

    save_phases(name, req.phases)

    if not req.generate_summaries:
        return {"message": "阶段已保存（未生成总结）", "phase_count": len(req.phases)}

    def run():
        st = task_status["phases"]
        graph = load_graph(name)
        all_nodes = flatten_phases(graph.get("phases") or [])
        nodes_to_summarize = [n for n in all_nodes if n.get("doc_ids")]

        st.update({"running": True, "progress": 0, "total": len(nodes_to_summarize), "current": "", "result": None})
        try:
            id_to_summary = {}
            for i, p in enumerate(nodes_to_summarize):
                st["progress"] = i
                st["current"] = p.get("_full_path") or p.get("name", "")
                try:
                    summary_data = summarize_phase(p, graph, model=req.model or "deepseek-v4-flash")
                    summary_data.pop("tokens", None)
                    id_to_summary[p["id"]] = summary_data
                except Exception as e:
                    id_to_summary[p["id"]] = {"summary": f"[总结失败: {str(e)[:80]}]"}

            def _apply(nodes):
                for n in nodes:
                    if n["id"] in id_to_summary:
                        n.update(id_to_summary[n["id"]])
                    _apply(n.get("children") or [])
            tree = graph.get("phases") or []
            _apply(tree)
            save_phases(name, tree)
            st["progress"] = len(nodes_to_summarize)
            st["result"] = {"phase_count": len(nodes_to_summarize)}
        except Exception as e:
            st["result"] = {"error": str(e)}
        finally:
            st["running"] = False

    background_tasks.add_task(run)
    return {"message": "阶段已保存，总结生成任务已启动", "phase_count": len(req.phases)}


@router.delete("/graphs/{name}/phases")
def api_phases_clear(name: str):
    """清除阶段划分。"""
    g = load_graph(name)
    if not g:
        raise HTTPException(404, f"图谱不存在: {name}")
    g.pop("phases", None)
    g.pop("phase_flow", None)
    from src.storage import _atomic_write
    path = DATA_DIR / f"{name}.json"
    _atomic_write(path, g)
    return {"message": "已清除阶段划分"}


@router.put("/graphs/{name}/phases")
def api_phases_save(name: str, req: PhasesSaveRequest):
    """直接保存编辑后的阶段树。"""
    from src.phase_analyzer import save_phases
    g = load_graph(name)
    if not g:
        raise HTTPException(404, f"图谱不存在: {name}")
    save_phases(name, req.phases)
    return {"message": "阶段已保存", "phase_count": len(req.phases)}


@router.post("/graphs/{name}/phases/auto-update")
def api_phases_auto_update(name: str, req: PhasesAutoUpdateRequest, background_tasks: BackgroundTasks):
    """基于当前目录结构重新提议阶段，并合并到现有阶段中。"""
    with task_lock:
        if task_status["phases"]["running"]:
            raise HTTPException(409, "阶段任务运行中")
        task_status["phases"].update({"running": True, "progress": 0, "total": 0, "current": "合并阶段中...", "result": None})

    from src.phase_analyzer import auto_update_phases, summarize_phase, flatten_phases

    def run():
        st = task_status["phases"]
        try:
            r = auto_update_phases(name)
            new_count = len(r["new_phases"])
            added_total = sum(a["added_count"] for a in r["added_to_existing"])

            if req.generate_summaries_for_new and new_count > 0:
                graph = load_graph(name)
                all_nodes = flatten_phases(graph.get("phases") or [])
                new_paths = {p["path_pattern"] for p in r["new_phases"] if p.get("path_pattern")}
                targets = [n for n in all_nodes if n.get("path_pattern") in new_paths and n.get("doc_ids")]
                st["total"] = len(targets)
                id_to_summary = {}
                for i, p in enumerate(targets):
                    st["progress"] = i
                    st["current"] = p.get("_full_path") or p.get("name", "")
                    try:
                        summary_data = summarize_phase(p, graph, model=req.model or "deepseek-v4-flash")
                        summary_data.pop("tokens", None)
                        id_to_summary[p["id"]] = summary_data
                    except Exception as e:
                        id_to_summary[p["id"]] = {"summary": f"[总结失败: {str(e)[:80]}]"}
                def _apply(nodes):
                    for n in nodes:
                        if n["id"] in id_to_summary:
                            n.update(id_to_summary[n["id"]])
                        _apply(n.get("children") or [])
                tree = graph.get("phases") or []
                _apply(tree)
                from src.phase_analyzer import save_phases
                save_phases(name, tree)
                st["progress"] = len(targets)

            st["result"] = {
                "new_phases": r["new_phases"],
                "added_to_existing": r["added_to_existing"],
                "removed_doc_ids": r["removed_doc_ids"],
                "total_phases": r["total_phases"],
                "new_phase_count": new_count,
                "added_doc_count": added_total,
            }
        except Exception as e:
            st["result"] = {"error": str(e)}
        finally:
            st["running"] = False

    background_tasks.add_task(run)
    return {"message": "自动更新阶段任务已启动"}


@router.post("/graphs/{name}/phases/flow")
def api_phases_flow_analyze(name: str, req: PhaseFlowRequest, background_tasks: BackgroundTasks):
    """基于阶段总结分析阶段间的内容流程关系。"""
    with task_lock:
        if task_status["phases"]["running"]:
            raise HTTPException(409, "阶段任务运行中")
        task_status["phases"].update({"running": True, "progress": 0, "total": 1, "current": "分析阶段流程...", "result": None})

    from src.phase_analyzer import analyze_phase_flow

    def run():
        st = task_status["phases"]
        try:
            flow = analyze_phase_flow(name, model=req.model or "deepseek-v4-flash")
            st["progress"] = 1
            st["result"] = {
                "node_count": len(flow.get("nodes", [])),
                "edge_count": len(flow.get("edges", [])),
                "tokens": flow.get("tokens", 0),
            }
        except Exception as e:
            st["result"] = {"error": str(e)}
        finally:
            st["running"] = False

    background_tasks.add_task(run)
    return {"message": "阶段流程分析任务已启动"}


@router.get("/graphs/{name}/phases/flow")
def api_phases_flow_get(name: str):
    """获取已生成的阶段流程。"""
    g = load_graph(name)
    if not g:
        raise HTTPException(404, f"图谱不存在: {name}")
    return {"flow": g.get("phase_flow")}


# ========== 分类管理 ==========

@router.post("/graphs/{name}/categories/merge")
def api_merge_categories(name: str, req: CategoryMergeRequest):
    """批量合并分类。"""
    g = load_graph(name)
    if not g:
        raise HTTPException(404, f"图谱不存在: {name}")

    changed = 0
    for doc in g["docs"]:
        old_cat = doc.get("category", "")
        if old_cat in req.mapping:
            doc["category"] = req.mapping[old_cat]
            changed += 1

    results = [{"id": d["id"], **{k: v for k, v in d.items() if k != "id"}} for d in g["docs"]]
    write_doc_meta(name, results)
    return {"changed": changed, "categories": _count_categories(g["docs"])}


@router.post("/graphs/{name}/categories/rename")
def api_rename_category(name: str, req: CategoryRenameRequest):
    """重命名单个分类。"""
    return api_merge_categories(name, CategoryMergeRequest(mapping={req.old_name: req.new_name}))


@router.get("/graphs/{name}/categories")
def api_list_categories(name: str):
    """列出所有分类及文档数。"""
    g = load_graph(name)
    if not g:
        raise HTTPException(404, f"图谱不存在: {name}")
    return {"categories": _count_categories(g["docs"])}


def _count_categories(docs: list) -> list:
    cats = {}
    for d in docs:
        c = d.get("category", "未分类")
        cats[c] = cats.get(c, 0) + 1
    return [{"name": k, "count": v} for k, v in sorted(cats.items(), key=lambda x: -x[1])]
