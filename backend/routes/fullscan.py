"""全量扫描相关 API 路由。"""
import json
import logging
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel

logger = logging.getLogger(__name__)

from src.full_scan import list_subdirs, full_scan_workflow
from src.storage import DATA_DIR

router = APIRouter(prefix="/api", tags=["fullscan"])

# 全量扫描状态（模块级单例）
_full_scan_state = {
    "running": False,
    "phase": "",
    "message": "",
    "progress": 0,
    "result": None,
    "current_id": None,
    "error": None,
    "started_at": None,
}


def _fullscan_dir():
    """扫描历史持久化目录"""
    p = DATA_DIR / "fullscans"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _suggest_scan_name(paths: list[str]) -> str:
    if not paths:
        return "未命名扫描"
    if len(paths) == 1:
        return Path(paths[0]).name or paths[0]
    return f"{Path(paths[0]).name} 等 {len(paths)} 处"


# ========== 数据模型 ==========

class FullScanListRequest(BaseModel):
    roots: list[str]


class FullScanRequest(BaseModel):
    paths: list[str]
    use_llm: bool = True
    deep_explore: bool = False
    name: Optional[str] = None


class FullScanRenameRequest(BaseModel):
    name: str


class ClusterUpdateRequest(BaseModel):
    label: Optional[str] = None
    llm_kind: Optional[str] = None
    redundant: Optional[bool] = None
    info_score: Optional[float] = None


class ClusterMergeRequest(BaseModel):
    cluster_ids: list[str]
    new_label: Optional[str] = None
    new_kind: Optional[str] = None


class ClusterSplitRequest(BaseModel):
    file_paths: list[str]
    new_label: str
    new_kind: Optional[str] = None


class CrossLinkApplyRequest(BaseModel):
    link_indexes: list[int]


# ========== 工具函数 ==========

def _load_scan(scan_id: str) -> dict:
    p = _fullscan_dir() / f"{scan_id}.json"
    if not p.exists():
        raise HTTPException(404, "扫描记录不存在")
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def _save_scan(scan_id: str, data: dict):
    p = _fullscan_dir() / f"{scan_id}.json"
    with open(p, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    if _full_scan_state.get("current_id") == scan_id:
        _full_scan_state["result"] = data
    with open(DATA_DIR / "_fullscan_latest.json", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _next_cluster_id(clusters: list) -> str:
    used = {c["id"] for c in clusters}
    base = len(clusters) + 1
    while True:
        candidate = f"u{base}{uuid.uuid4().hex[:4]}"
        if candidate not in used:
            return candidate
        base += 1


def _recompute_cluster(cluster: dict):
    files = cluster.get("files", [])
    cluster["file_count"] = len(files)
    cluster["total_bytes"] = sum(f.get("size", 0) for f in files)
    from collections import Counter
    cluster["ext_distribution"] = dict(Counter(f.get("ext", "") for f in files).most_common(10))


def _link_type_to_relation(link_type: str) -> str:
    return {
        "duplicate": "重复造轮",
        "shared_data": "共享数据",
        "upstream": "上下游",
        "reference": "引用参考",
        "evolution": "版本迭代",
        "topic": "同一主题",
    }.get(link_type, "引用参考")


# ========== 路由 ==========

@router.post("/fullscan/list")
def api_fullscan_list(req: FullScanListRequest):
    out = []
    for r in req.roots:
        out.append(list_subdirs(r))
    return {"items": out}


@router.get("/fullscan/defaults")
def api_fullscan_defaults():
    home = Path.home()
    candidates = [
        ("桌面", home / "Desktop"),
        ("文档", home / "Documents"),
        ("下载", home / "Downloads"),
    ]
    return {
        "roots": [
            {"label": label, "path": str(p), "exists": p.exists()}
            for label, p in candidates
        ]
    }


@router.post("/fullscan/scan")
def api_fullscan_scan(req: FullScanRequest, background_tasks: BackgroundTasks):
    if _full_scan_state["running"]:
        raise HTTPException(409, "扫描任务进行中")

    scan_id = uuid.uuid4().hex[:12]
    scan_name = (req.name or "").strip() or _suggest_scan_name(req.paths)

    _full_scan_state.update({
        "running": True,
        "phase": "starting",
        "message": "启动中...",
        "progress": 0,
        "result": None,
        "current_id": scan_id,
        "error": None,
        "started_at": time.time(),
    })

    def _run():
        try:
            def on_progress(info: dict):
                _full_scan_state["phase"] = info.get("phase", "")
                _full_scan_state["message"] = info.get("message", "")
                _full_scan_state["progress"] = info.get("progress", 0)

            result = full_scan_workflow(paths=req.paths, use_llm=req.use_llm, on_progress=on_progress)
            result["id"] = scan_id
            result["name"] = scan_name

            if req.deep_explore:
                from src.deep_explore import deep_explore_workflow
                cross_links = deep_explore_workflow(clusters=result["clusters"], on_progress=on_progress)
                result["cross_links"] = cross_links
            else:
                result["cross_links"] = []

            _full_scan_state["result"] = result
            _full_scan_state["phase"] = "done"
            _full_scan_state["message"] = f"完成：{result['cluster_count']} 组 / {result['file_count']} 个文件"
            if result.get("cross_links"):
                _full_scan_state["message"] += f" / {len(result['cross_links'])} 条跨组关联"

            scans_dir = _fullscan_dir()
            with open(scans_dir / f"{scan_id}.json", "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False, indent=2)
            with open(DATA_DIR / "_fullscan_latest.json", "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False, indent=2)
        except Exception as e:
            _full_scan_state["error"] = str(e)
            _full_scan_state["phase"] = "error"
            _full_scan_state["message"] = f"错误：{e}"
        finally:
            _full_scan_state["running"] = False

    background_tasks.add_task(_run)
    return {"started": True, "id": scan_id, "name": scan_name}


@router.get("/fullscan/status")
def api_fullscan_status():
    return {
        "running": _full_scan_state["running"],
        "phase": _full_scan_state["phase"],
        "message": _full_scan_state["message"],
        "progress": _full_scan_state["progress"],
        "error": _full_scan_state["error"],
        "started_at": _full_scan_state["started_at"],
        "has_result": _full_scan_state["result"] is not None,
    }


@router.get("/fullscan/result")
def api_fullscan_result():
    if _full_scan_state["result"]:
        return _full_scan_state["result"]
    p = DATA_DIR / "_fullscan_latest.json"
    if p.exists():
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    raise HTTPException(404, "还没有扫描结果")


@router.get("/fullscan/history")
def api_fullscan_history():
    items = []
    for p in _fullscan_dir().glob("*.json"):
        try:
            with open(p, encoding="utf-8") as f:
                d = json.load(f)
            items.append({
                "id": d.get("id") or p.stem,
                "name": d.get("name") or p.stem,
                "scan_paths": d.get("scan_paths", []),
                "file_count": d.get("file_count", 0),
                "cluster_count": d.get("cluster_count", 0),
                "scanned_at": d.get("scanned_at", 0),
                "elapsed_sec": d.get("elapsed_sec", 0),
                "llm_used": d.get("llm_used", False),
            })
        except Exception:
            continue
    items.sort(key=lambda x: x["scanned_at"], reverse=True)
    return {"items": items}


@router.get("/fullscan/history/{scan_id}")
def api_fullscan_history_get(scan_id: str):
    p = _fullscan_dir() / f"{scan_id}.json"
    if not p.exists():
        raise HTTPException(404, "扫描记录不存在")
    with open(p, encoding="utf-8") as f:
        result = json.load(f)
    _full_scan_state["result"] = result
    _full_scan_state["current_id"] = scan_id
    return result


@router.delete("/fullscan/history/{scan_id}")
def api_fullscan_history_delete(scan_id: str):
    p = _fullscan_dir() / f"{scan_id}.json"
    if not p.exists():
        raise HTTPException(404, "扫描记录不存在")
    p.unlink()
    if _full_scan_state.get("current_id") == scan_id:
        _full_scan_state["result"] = None
        _full_scan_state["current_id"] = None
    return {"deleted": True}


@router.post("/fullscan/history/{scan_id}/rename")
def api_fullscan_history_rename(scan_id: str, req: FullScanRenameRequest):
    p = _fullscan_dir() / f"{scan_id}.json"
    if not p.exists():
        raise HTTPException(404, "扫描记录不存在")
    name = req.name.strip()
    if not name:
        raise HTTPException(400, "name 不能为空")
    with open(p, encoding="utf-8") as f:
        d = json.load(f)
    d["name"] = name
    with open(p, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
    if _full_scan_state.get("current_id") == scan_id and _full_scan_state.get("result"):
        _full_scan_state["result"]["name"] = name
    return {"id": scan_id, "name": name}


# ---------- 群结构编辑 ----------

@router.patch("/fullscan/history/{scan_id}/clusters/{cluster_id}")
def api_cluster_update(scan_id: str, cluster_id: str, req: ClusterUpdateRequest):
    data = _load_scan(scan_id)
    target = next((c for c in data["clusters"] if c["id"] == cluster_id), None)
    if not target:
        raise HTTPException(404, "群不存在")
    if req.label is not None:
        target["label"] = req.label.strip() or target["label"]
    if req.llm_kind is not None:
        target["llm_kind"] = req.llm_kind
    if req.redundant is not None:
        target["redundant"] = bool(req.redundant)
    if req.info_score is not None:
        target["info_score"] = max(0, min(100, float(req.info_score)))
    _save_scan(scan_id, data)
    return target


@router.delete("/fullscan/history/{scan_id}/clusters/{cluster_id}")
def api_cluster_delete(scan_id: str, cluster_id: str):
    data = _load_scan(scan_id)
    cs = data["clusters"]
    target = next((c for c in cs if c["id"] == cluster_id), None)
    if not target:
        raise HTTPException(404, "群不存在")
    to_delete = {cluster_id}
    while True:
        added = False
        for c in cs:
            if c["id"] in to_delete:
                continue
            if c.get("parent_id") in to_delete:
                to_delete.add(c["id"])
                added = True
        if not added:
            break
    for c in cs:
        c["child_ids"] = [cid for cid in c.get("child_ids", []) if cid not in to_delete]
    data["clusters"] = [c for c in cs if c["id"] not in to_delete]
    data["cluster_count"] = len(data["clusters"])
    data["file_count"] = sum(c["file_count"] for c in data["clusters"] if not c.get("parent_id"))
    _save_scan(scan_id, data)
    return {"deleted": list(to_delete)}


@router.post("/fullscan/history/{scan_id}/clusters/merge")
def api_cluster_merge(scan_id: str, req: ClusterMergeRequest):
    if len(req.cluster_ids) < 2:
        raise HTTPException(400, "至少两个群才能合并")
    data = _load_scan(scan_id)
    cs = data["clusters"]
    targets = [c for c in cs if c["id"] in req.cluster_ids]
    if len(targets) != len(req.cluster_ids):
        raise HTTPException(404, "部分群不存在")
    head = next(c for c in cs if c["id"] == req.cluster_ids[0])
    others = [c for c in cs if c["id"] in req.cluster_ids[1:]]

    head["label"] = (req.new_label or "").strip() or head["label"]
    if req.new_kind:
        head["llm_kind"] = req.new_kind

    seen = {f["path"] for f in head.get("files", [])}
    for o in others:
        for f in o.get("files", []):
            if f["path"] not in seen:
                head["files"].append(f)
                seen.add(f["path"])
    _recompute_cluster(head)

    other_ids = {o["id"] for o in others}
    for c in cs:
        if c.get("parent_id") in other_ids:
            c["parent_id"] = head["id"]
            if c["id"] not in head.setdefault("child_ids", []):
                head["child_ids"].append(c["id"])
    for c in cs:
        if c.get("child_ids"):
            c["child_ids"] = [cid for cid in c["child_ids"] if cid not in other_ids]
    data["clusters"] = [c for c in cs if c["id"] not in other_ids]
    data["cluster_count"] = len(data["clusters"])
    data["file_count"] = sum(c["file_count"] for c in data["clusters"] if not c.get("parent_id"))
    _save_scan(scan_id, data)
    return head


@router.post("/fullscan/history/{scan_id}/clusters/{cluster_id}/split")
def api_cluster_split(scan_id: str, cluster_id: str, req: ClusterSplitRequest):
    if not req.file_paths:
        raise HTTPException(400, "请选择要拆出的文件")
    label = req.new_label.strip()
    if not label:
        raise HTTPException(400, "新群名不能为空")
    data = _load_scan(scan_id)
    cs = data["clusters"]
    src = next((c for c in cs if c["id"] == cluster_id), None)
    if not src:
        raise HTTPException(404, "源群不存在")
    paths_set = set(req.file_paths)
    moving = [f for f in src.get("files", []) if f["path"] in paths_set]
    if not moving:
        raise HTTPException(400, "选中的文件不在源群中")
    src["files"] = [f for f in src.get("files", []) if f["path"] not in paths_set]
    _recompute_cluster(src)

    new_id = _next_cluster_id(cs)
    scan_root = src.get("scan_root") or (moving[0].get("scan_root") if moving else "")
    new_cluster = {
        "id": new_id,
        "kind": src.get("kind", "project"),
        "llm_kind": req.new_kind or src.get("llm_kind"),
        "label": label,
        "root_path": src.get("root_path", scan_root),
        "scan_root": scan_root,
        "files": moving,
        "parent_id": src.get("parent_id"),
        "child_ids": [],
        "redundant": False,
        "split_hint": [],
        "info_score": 50,
    }
    _recompute_cluster(new_cluster)
    cs.append(new_cluster)

    if new_cluster["parent_id"]:
        parent = next((c for c in cs if c["id"] == new_cluster["parent_id"]), None)
        if parent:
            parent.setdefault("child_ids", []).append(new_id)

    data["cluster_count"] = len(data["clusters"])
    data["file_count"] = sum(c["file_count"] for c in data["clusters"] if not c.get("parent_id"))
    _save_scan(scan_id, data)
    return new_cluster


@router.post("/fullscan/history/{scan_id}/cross-links/apply")
def api_cross_links_apply(scan_id: str, req: CrossLinkApplyRequest):
    """一键将跨组关联同步到已有图谱。"""
    from src.scanner import scan_files

    data = _load_scan(scan_id)
    cross_links = data.get("cross_links", [])
    if not cross_links:
        raise HTTPException(400, "该扫描没有跨组关联")

    graph_files = []
    for gf in DATA_DIR.glob("*.json"):
        if gf.name.startswith("_") or gf.name.endswith("_numbers.json"):
            continue
        try:
            with open(gf, encoding="utf-8") as f:
                gd = json.load(f)
            if not isinstance(gd, dict) or "docs" not in gd:
                continue
            path_map = {d.get("abs_path") or d.get("path"): d["id"] for d in gd.get("docs", []) if d.get("id")}
            graph_files.append({"name": gd.get("name") or gf.stem, "file": gf, "data": gd, "path_map": path_map})
        except Exception:
            continue

    if not graph_files:
        raise HTTPException(400, "没有可同步的图谱")

    results = []
    for idx in req.link_indexes:
        if idx < 0 or idx >= len(cross_links):
            continue
        link = cross_links[idx]
        src_path = link["source_file"]
        tgt_path = link["target_file"]

        src_in = [g for g in graph_files if src_path in g["path_map"]]
        tgt_in = [g for g in graph_files if tgt_path in g["path_map"]]

        if not src_in and not tgt_in:
            results.append({"link_idx": idx, "applied": False, "reason": "两边都不在任何图谱"})
            continue

        targets = []
        for g in src_in:
            if tgt_path not in g["path_map"]:
                targets.append((g, tgt_path))
        for g in tgt_in:
            if src_path not in g["path_map"]:
                targets.append((g, src_path))
        same_graph_pairs = [g for g in src_in if tgt_path in g["path_map"]]

        applied_in = []
        for g, missing_path in targets:
            try:
                new_docs = scan_files([missing_path], common_root=None)
                if not new_docs:
                    continue
                new_doc = new_docs[0]
                new_doc["external"] = True
                new_doc["external_source"] = scan_id

                existing_ids = {d["id"] for d in g["data"]["docs"]}
                if new_doc["id"] in existing_ids:
                    new_doc["id"] = new_doc["id"] + "_ext"

                g["data"]["docs"].append(new_doc)
                g["path_map"][missing_path] = new_doc["id"]
                src_id = g["path_map"].get(src_path)
                tgt_id = g["path_map"].get(tgt_path)
                if src_id and tgt_id and src_id != tgt_id:
                    if not any(r.get("from") == src_id and r.get("to") == tgt_id for r in g["data"]["relations"]):
                        g["data"]["relations"].append({
                            "from": src_id, "to": tgt_id,
                            "type": _link_type_to_relation(link.get("link_type", "reference")),
                            "confidence": link.get("confidence", 0.7),
                            "reason": link.get("detail") or link.get("reason", "跨组关联"),
                            "directional": False, "external": True, "external_source": scan_id,
                        })
                applied_in.append(g["name"])
            except Exception as e:
                logger.warning(f"[cross_links] import failed for {missing_path}: {e}")

        for g in same_graph_pairs:
            src_id = g["path_map"].get(src_path)
            tgt_id = g["path_map"].get(tgt_path)
            if src_id and tgt_id and src_id != tgt_id:
                if not any(r.get("from") == src_id and r.get("to") == tgt_id for r in g["data"]["relations"]):
                    g["data"]["relations"].append({
                        "from": src_id, "to": tgt_id,
                        "type": _link_type_to_relation(link.get("link_type", "reference")),
                        "confidence": link.get("confidence", 0.7),
                        "reason": link.get("detail") or link.get("reason", "跨组关联"),
                        "directional": False, "external": True, "external_source": scan_id,
                    })
                    applied_in.append(g["name"])

        results.append({"link_idx": idx, "applied": bool(applied_in), "graphs": list(set(applied_in))})

    for g in graph_files:
        try:
            with open(g["file"], "w", encoding="utf-8") as f:
                json.dump(g["data"], f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.warning(f"[cross_links] save failed for {g['name']}: {e}")

    return {"total": len(req.link_indexes), "applied": sum(1 for r in results if r["applied"]), "results": results}
