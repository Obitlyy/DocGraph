"""Agent JSON API 路由

为外部 AI Agent 提供规范化的文档查询接口。

所有返回包含：
- schema_version: 接口版本
- graph: 图谱名称
- data: 实际数据
- meta: 补充元信息（不必须）
"""
from fastapi import APIRouter, HTTPException, Query
from typing import Optional

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from src.storage import load_graph, list_graphs
from src.recommender import recommend_related

router = APIRouter(prefix="/agent/v1", tags=["agent"])

SCHEMA_VERSION = "1.0"


def _wrap(graph_name: str, data, meta: Optional[dict] = None) -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "graph": graph_name,
        "data": data,
        "meta": meta or {},
    }


def _doc_brief(d: dict) -> dict:
    """精简版文档信息（列表用）"""
    return {
        "id": d["id"],
        "name": d["name"],
        "category": d.get("category"),
        "summary": d.get("summary"),
        "keywords": d.get("keywords") or [],
        "people": d.get("people") or [],
        "phase": d.get("phase"),
    }


def _doc_full(d: dict) -> dict:
    """完整文档信息，包含所有抽取字段"""
    return {
        "id": d["id"],
        "name": d["name"],
        "rel_path": d.get("rel_path"),
        "ext": d.get("ext"),
        "char_count": d.get("char_count"),
        "category": d.get("category"),
        "summary": d.get("summary"),
        "keywords": d.get("keywords") or [],
        "people": d.get("people") or [],
        "phase": d.get("phase"),
        "metrics": d.get("metrics") or [],
        "timeline": d.get("timeline") or [],
        "entities": d.get("entities") or [],
        "citations": d.get("citations") or [],
    }


@router.get("/graphs")
def agent_list_graphs():
    """列出所有可用图谱"""
    items = []
    for name in list_graphs():
        g = load_graph(name)
        if g:
            items.append({
                "name": name,
                "doc_count": len(g.get("docs", [])),
                "relation_count": len(g.get("relations", [])),
            })
    return _wrap("*", items)


@router.get("/docs")
def agent_list_docs(
    graph: str = Query(..., description="图谱名"),
    category: Optional[str] = Query(None, description="按分类过滤"),
    person: Optional[str] = Query(None, description="按人物过滤"),
):
    """列出文档（精简版），支持过滤"""
    g = load_graph(graph)
    if not g:
        raise HTTPException(404, f"图谱不存在: {graph}")

    docs = g.get("docs", [])
    if category:
        docs = [d for d in docs if d.get("category") == category]
    if person:
        docs = [d for d in docs if person in (d.get("people") or [])]

    return _wrap(
        graph,
        [_doc_brief(d) for d in docs],
        {"total": len(docs), "filters": {"category": category, "person": person}},
    )


@router.get("/doc/{doc_id}")
def agent_get_doc(graph: str, doc_id: str):
    """获取单个文档的完整信息"""
    g = load_graph(graph)
    if not g:
        raise HTTPException(404, f"图谱不存在: {graph}")
    doc = next((d for d in g["docs"] if d["id"] == doc_id), None)
    if not doc:
        raise HTTPException(404, f"文档不存在: {doc_id}")
    return _wrap(graph, _doc_full(doc))


@router.get("/doc/{doc_id}/related")
def agent_get_related(graph: str, doc_id: str, top_n: int = 8):
    """返回与该文档相关的其他文档"""
    g = load_graph(graph)
    if not g:
        raise HTTPException(404, f"图谱不存在: {graph}")
    related = recommend_related(g, doc_id, top_n=top_n)
    return _wrap(graph, related, {"top_n": top_n, "source_doc_id": doc_id})


@router.get("/doc/{doc_id}/sources")
def agent_get_sources(graph: str, doc_id: str):
    """返回该文档的上游来源链（提供数据/旧版本/衍生源头）"""
    g = load_graph(graph)
    if not g:
        raise HTTPException(404, f"图谱不存在: {graph}")

    relations = g.get("relations", [])
    docs = {d["id"]: d for d in g["docs"]}

    # 上游关系类型（有向边，to=当前文档）
    upstream_types = {"提供数据", "浓缩版本", "旧版本", "衍生文档"}

    sources = []
    visited = set()

    def trace(target_id: str, depth: int = 0):
        if depth > 5 or target_id in visited:
            return
        visited.add(target_id)
        for r in relations:
            if r["to"] == target_id and r["type"] in upstream_types:
                src = docs.get(r["from"])
                if not src:
                    continue
                sources.append({
                    "doc_id": src["id"],
                    "doc_name": src["name"],
                    "category": src.get("category"),
                    "summary": src.get("summary"),
                    "relation_type": r["type"],
                    "confidence": r.get("confidence", 0.7),
                    "depth": depth + 1,
                })
                trace(src["id"], depth + 1)

    trace(doc_id)
    return _wrap(graph, sources, {"source_doc_id": doc_id, "max_depth": 5})


@router.get("/search")
def agent_search(
    graph: str,
    q: str = Query(..., description="查询词"),
    fields: str = Query("all", description="搜索范围: all/keywords/summary/name/people"),
    limit: int = Query(20, le=50),
):
    """关键词搜索文档"""
    g = load_graph(graph)
    if not g:
        raise HTTPException(404, f"图谱不存在: {graph}")

    q_lower = q.lower()
    target_fields = fields.split(",") if fields != "all" else ["name", "summary", "keywords", "people", "category"]

    results = []
    for d in g.get("docs", []):
        match_reasons = []
        if "name" in target_fields and q_lower in d["name"].lower():
            match_reasons.append("name")
        if "summary" in target_fields and q_lower in (d.get("summary") or "").lower():
            match_reasons.append("summary")
        if "keywords" in target_fields:
            for k in d.get("keywords") or []:
                if q_lower in k.lower():
                    match_reasons.append(f"keyword:{k}")
                    break
        if "people" in target_fields:
            for p in d.get("people") or []:
                if q_lower in p.lower():
                    match_reasons.append(f"person:{p}")
                    break
        if "category" in target_fields and q_lower in (d.get("category") or "").lower():
            match_reasons.append("category")

        if match_reasons:
            results.append({
                **_doc_brief(d),
                "match_reasons": match_reasons,
            })

    return _wrap(graph, results[:limit], {"query": q, "total_matches": len(results), "fields": target_fields})


@router.get("/metrics")
def agent_list_metrics(graph: str, name: Optional[str] = None):
    """列出图谱中所有指标（可跨文档聚合同名指标）"""
    g = load_graph(graph)
    if not g:
        raise HTTPException(404, f"图谱不存在: {graph}")

    by_name = {}
    for d in g.get("docs", []):
        for m in d.get("metrics") or []:
            mname = m.get("name")
            if not mname:
                continue
            if name and name.lower() not in mname.lower():
                continue
            by_name.setdefault(mname, []).append({
                "doc_id": d["id"],
                "doc_name": d["name"],
                "value": m.get("value"),
                "unit": m.get("unit"),
                "context": m.get("context"),
            })

    items = [
        {"name": k, "occurrences": v, "doc_count": len({i["doc_id"] for i in v})}
        for k, v in by_name.items()
    ]
    items.sort(key=lambda x: x["doc_count"], reverse=True)
    return _wrap(graph, items, {"filter": name})


@router.get("/entities")
def agent_list_entities(graph: str):
    """列出所有提及的实体（公司/产品/项目等）"""
    g = load_graph(graph)
    if not g:
        raise HTTPException(404, f"图谱不存在: {graph}")

    by_name = {}
    for d in g.get("docs", []):
        for e in d.get("entities") or []:
            if not isinstance(e, dict) or not e.get("name"):
                continue
            ename = e["name"]
            if ename not in by_name:
                by_name[ename] = {"name": ename, "type": e.get("type", "其他"), "doc_ids": set()}
            by_name[ename]["doc_ids"].add(d["id"])

    items = [
        {"name": v["name"], "type": v["type"], "doc_count": len(v["doc_ids"]), "doc_ids": list(v["doc_ids"])}
        for v in by_name.values()
    ]
    items.sort(key=lambda x: x["doc_count"], reverse=True)
    return _wrap(graph, items)


@router.get("/timeline")
def agent_get_timeline(graph: str):
    """返回整个图谱的时间轴汇总（所有文档的 timeline 合并按时间排序）"""
    g = load_graph(graph)
    if not g:
        raise HTTPException(404, f"图谱不存在: {graph}")

    events = []
    for d in g.get("docs", []):
        for t in d.get("timeline") or []:
            if not isinstance(t, dict):
                continue
            events.append({
                "date": t.get("date"),
                "event": t.get("event"),
                "doc_id": d["id"],
                "doc_name": d["name"],
            })

    events.sort(key=lambda x: x.get("date") or "")
    return _wrap(graph, events)
