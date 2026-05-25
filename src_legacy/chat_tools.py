"""超级搜索工具定义 + 执行器。

为 LLM Function Calling 提供工具 schema 和执行逻辑。
所有工具操作的是内存中已加载的图谱数据，无需额外 I/O。
"""
import json
from typing import Optional

# ========== 工具 Schema 定义 ==========

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_docs",
            "description": "在所有图谱中搜索文档。根据关键词匹配文档名称、摘要、关键词。返回匹配的文档列表。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "搜索关键词",
                    },
                    "graph_name": {
                        "type": "string",
                        "description": "可选，指定在某个图谱中搜索。不填则搜索所有图谱。",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_numbers",
            "description": "在文档中搜索数字。支持金额、百分比、普通数字。可用于追踪某个数字的来源。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "要搜索的数字，如 '3.14'、'100%'、'1.5亿'、'2023'",
                    },
                    "tolerance": {
                        "type": "number",
                        "description": "容差比例，默认 0.01（1%）。设为 0 则精确匹配。",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_all_graphs",
            "description": "列出所有已加载的图谱及其基本信息（文档数、关系数）。",
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_doc_detail",
            "description": "获取某篇文档的详细信息，包括分类、关键词、摘要、所属阶段等。",
            "parameters": {
                "type": "object",
                "properties": {
                    "doc_name": {
                        "type": "string",
                        "description": "文档名称（支持部分匹配）",
                    },
                    "graph_name": {
                        "type": "string",
                        "description": "可选，指定图谱。不填则在所有图谱中查找。",
                    },
                },
                "required": ["doc_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "find_related",
            "description": "查找与指定文档相关联的其他文档。基于文档关系图谱推荐。",
            "parameters": {
                "type": "object",
                "properties": {
                    "doc_name": {
                        "type": "string",
                        "description": "起始文档名称",
                    },
                    "top_n": {
                        "type": "integer",
                        "description": "返回结果数量，默认 8",
                    },
                },
                "required": ["doc_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_by_category",
            "description": "按分类名称搜索文档。可列出某个分类下的所有文档。",
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {
                        "type": "string",
                        "description": "分类名称（支持部分匹配）",
                    },
                },
                "required": ["category"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_by_phase",
            "description": "按项目阶段搜索文档。查看某个阶段包含哪些文档。",
            "parameters": {
                "type": "object",
                "properties": {
                    "phase_name": {
                        "type": "string",
                        "description": "阶段名称（支持部分匹配）",
                    },
                },
                "required": ["phase_name"],
            },
        },
    },
]


# ========== 工具执行器 ==========

def execute_tool(name: str, arguments: str, graphs: list[dict]) -> str:
    """执行一个工具调用，返回 JSON 字符串结果。

    Args:
        name: 工具名称
        arguments: JSON 字符串参数
        graphs: 所有已加载的图谱数据列表（每个含 name/docs/relations/phases 等）

    Returns:
        结果的 JSON 字符串（给 LLM 阅读）
    """
    try:
        args = json.loads(arguments) if arguments else {}
    except json.JSONDecodeError:
        return json.dumps({"error": "参数解析失败"}, ensure_ascii=False)

    try:
        if name == "search_docs":
            return _search_docs(args, graphs)
        elif name == "search_numbers":
            return _search_numbers(args, graphs)
        elif name == "list_all_graphs":
            return _list_all_graphs(graphs)
        elif name == "get_doc_detail":
            return _get_doc_detail(args, graphs)
        elif name == "find_related":
            return _find_related(args, graphs)
        elif name == "search_by_category":
            return _search_by_category(args, graphs)
        elif name == "search_by_phase":
            return _search_by_phase(args, graphs)
        else:
            return json.dumps({"error": f"未知工具: {name}"}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": str(e)}, ensure_ascii=False)


# ========== 工具实现 ==========

def _search_docs(args: dict, graphs: list[dict]) -> str:
    query = args.get("query", "").lower()
    target_graph = args.get("graph_name")
    if not query:
        return json.dumps({"results": [], "message": "请提供搜索关键词"}, ensure_ascii=False)

    results = []
    for g in graphs:
        if target_graph and g.get("name") != target_graph:
            continue
        for doc in g.get("docs", []):
            score = 0
            if query in doc.get("name", "").lower():
                score += 3
            if query in (doc.get("summary") or "").lower():
                score += 1
            if any(query in k.lower() for k in (doc.get("keywords") or [])):
                score += 2
            if score > 0:
                results.append({
                    "name": doc["name"],
                    "id": doc["id"],
                    "graph": g["name"],
                    "category": doc.get("category", ""),
                    "summary": (doc.get("summary") or "")[:100],
                    "score": score,
                })

    results.sort(key=lambda x: x["score"], reverse=True)
    results = results[:15]
    return json.dumps({"total": len(results), "results": results}, ensure_ascii=False)


def _search_numbers(args: dict, graphs: list[dict]) -> str:
    query = args.get("query", "")
    tolerance = args.get("tolerance", 0.01)
    if not query:
        return json.dumps({"results": [], "message": "请提供数字"}, ensure_ascii=False)

    # 调用数字索引搜索
    from src.number_index import load_number_index, search_number, group_hits_by_doc

    results = []
    for g in graphs:
        graph_name = g.get("name", "")
        idx = load_number_index(graph_name)
        if not idx:
            continue
        hits = search_number(idx, query, tol=tolerance, fuzzy=True)
        grouped = group_hits_by_doc(hits)
        for group in grouped[:5]:
            for hit in group.get("docs", [])[:3]:
                results.append({
                    "doc_name": hit.get("doc_name", ""),
                    "doc_id": hit.get("doc_id", ""),
                    "graph": graph_name,
                    "numbers": [
                        {"raw": n.get("raw"), "context": n.get("context", "")[:80]}
                        for n in (hit.get("numbers") or [])[:3]
                    ],
                })

    return json.dumps({"total": len(results), "results": results[:15]}, ensure_ascii=False)


def _list_all_graphs(graphs: list[dict]) -> str:
    items = []
    for g in graphs:
        items.append({
            "name": g.get("name", ""),
            "doc_count": len(g.get("docs", [])),
            "relation_count": len(g.get("relations", [])),
            "has_phases": bool(g.get("phases")),
            "schema": g.get("schema", "general"),
        })
    return json.dumps({"graphs": items, "total": len(items)}, ensure_ascii=False)


def _get_doc_detail(args: dict, graphs: list[dict]) -> str:
    doc_name = args.get("doc_name", "").lower()
    target_graph = args.get("graph_name")
    if not doc_name:
        return json.dumps({"error": "请提供文档名称"}, ensure_ascii=False)

    for g in graphs:
        if target_graph and g.get("name") != target_graph:
            continue
        for doc in g.get("docs", []):
            if doc_name in doc.get("name", "").lower():
                return json.dumps({
                    "name": doc["name"],
                    "id": doc["id"],
                    "graph": g["name"],
                    "category": doc.get("category", ""),
                    "keywords": doc.get("keywords", []),
                    "summary": doc.get("summary", ""),
                    "people": doc.get("people", []),
                    "phase": doc.get("phase", ""),
                    "ext": doc.get("ext", ""),
                    "size": doc.get("size", 0),
                    "char_count": doc.get("char_count", 0),
                }, ensure_ascii=False)

    return json.dumps({"error": f"未找到文档: {args.get('doc_name')}"}, ensure_ascii=False)


def _find_related(args: dict, graphs: list[dict]) -> str:
    doc_name = args.get("doc_name", "").lower()
    top_n = args.get("top_n", 8)
    if not doc_name:
        return json.dumps({"error": "请提供文档名称"}, ensure_ascii=False)

    from src.recommender import recommend_related

    for g in graphs:
        for doc in g.get("docs", []):
            if doc_name in doc.get("name", "").lower():
                try:
                    related = recommend_related(g, doc["id"], top_n=top_n)
                    return json.dumps({
                        "source_doc": doc["name"],
                        "graph": g["name"],
                        "related": [
                            {
                                "name": r.get("doc_name", ""),
                                "doc_id": r.get("doc_id", ""),
                                "score": r.get("score", 0),
                                "reasons": [rr.get("type", "") for rr in (r.get("reasons") or [])],
                            }
                            for r in related[:top_n]
                        ],
                    }, ensure_ascii=False)
                except Exception as e:
                    return json.dumps({"error": f"查找关联失败: {e}"}, ensure_ascii=False)

    return json.dumps({"error": f"未找到文档: {args.get('doc_name')}"}, ensure_ascii=False)


def _search_by_category(args: dict, graphs: list[dict]) -> str:
    category = args.get("category", "").lower()
    if not category:
        return json.dumps({"error": "请提供分类名称"}, ensure_ascii=False)

    results = []
    for g in graphs:
        for doc in g.get("docs", []):
            if category in (doc.get("category") or "").lower():
                results.append({
                    "name": doc["name"],
                    "id": doc["id"],
                    "graph": g["name"],
                    "category": doc.get("category", ""),
                    "summary": (doc.get("summary") or "")[:80],
                })

    return json.dumps({"total": len(results), "results": results[:20]}, ensure_ascii=False)


def _search_by_phase(args: dict, graphs: list[dict]) -> str:
    phase_name = args.get("phase_name", "").lower()
    if not phase_name:
        return json.dumps({"error": "请提供阶段名称"}, ensure_ascii=False)

    results = []

    def walk(phases, graph_name, docs_map):
        for p in phases:
            if phase_name in p.get("name", "").lower():
                for doc_id in p.get("doc_ids", [])[:10]:
                    doc = docs_map.get(doc_id)
                    if doc:
                        results.append({
                            "name": doc["name"],
                            "id": doc["id"],
                            "graph": graph_name,
                            "phase": p["name"],
                        })
            if p.get("children"):
                walk(p["children"], graph_name, docs_map)

    for g in graphs:
        docs_map = {d["id"]: d for d in g.get("docs", [])}
        walk(g.get("phases") or [], g.get("name", ""), docs_map)

    return json.dumps({"total": len(results), "results": results[:20]}, ensure_ascii=False)
