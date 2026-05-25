"""数字索引：扫描整个图谱的所有文档，建立"数字 -> 文档"索引。

设计目标：
- 一次性扫描所有文档，提取数字 + 日期 + 上下文
- 持久化到 data/<graph>_numbers.json
- 提供搜索接口：按数字查文档（快速），按数值范围查（粗匹配）
"""
import json
import time
from pathlib import Path
from typing import Optional
from collections import defaultdict

from src.number_extractor import (
    extract_numbers, extract_dates, estimate_doc_time,
    numbers_might_be_same,
)
from src.scanner import extract_text
from src.storage import load_graph, DATA_DIR


def build_number_index(graph_name: str, context_chars: int = 80, min_value: float = 1.0) -> dict:
    """为指定图谱建立数字索引。

    返回:
        {
            "graph": graph_name,
            "built_at": timestamp,
            "doc_times": {doc_id: {best_iso, source, candidates}},
            "numbers": [
                {
                    "doc_id": str,
                    "doc_name": str,
                    "raw": "30%",
                    "real_value": 30.0,
                    "is_percent": bool,
                    "context": str,
                    "position": int,
                    "doc_time": "2025-09-30",
                }, ...
            ]
        }
    """
    graph = load_graph(graph_name)
    if not graph:
        raise ValueError(f"图谱不存在: {graph_name}")

    # 重新读取全文（图谱保存时去掉了 text）
    docs_full = []
    for d in graph["docs"]:
        abs_path = d.get("abs_path")
        if abs_path and Path(abs_path).exists():
            text = extract_text(Path(abs_path))
        else:
            text = d.get("preview", "")
        d_full = {**d, "text": text}
        docs_full.append(d_full)

    # 估算每个文档的时间
    doc_times = {}
    for d in docs_full:
        t = estimate_doc_time(d)
        doc_times[d["id"]] = t

    # 提取所有数字
    all_numbers = []
    for d in docs_full:
        text = d.get("text", "")
        nums = extract_numbers(text, context_chars=context_chars, min_value=min_value)
        for n in nums:
            all_numbers.append({
                "doc_id": d["id"],
                "doc_name": d["name"],
                "doc_path": d.get("rel_path", ""),
                "raw": n["raw"],
                "real_value": n["real_value"],
                "value": n["value"],
                "is_percent": n["is_percent"],
                "unit": n["unit"],
                "context": n["context"],
                "position": n["position"],
                "doc_time": doc_times[d["id"]]["best_iso"],
                "doc_time_source": doc_times[d["id"]]["source"],
            })

    index = {
        "graph": graph_name,
        "built_at": time.time(),
        "doc_count": len(docs_full),
        "number_count": len(all_numbers),
        "doc_times": doc_times,
        "numbers": all_numbers,
    }

    # 持久化
    out_path = DATA_DIR / f"{graph_name}_numbers.json"
    out_path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    return index


def load_number_index(graph_name: str) -> Optional[dict]:
    path = DATA_DIR / f"{graph_name}_numbers.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def search_number(
    index: dict,
    query: str,
    tol: float = 0.001,
    fuzzy: bool = True,
) -> list[dict]:
    """在索引里搜索数字。

    参数:
        index: build_number_index 的输出
        query: 用户输入，可以是 "30%"、"5.2亿"、"1234"
        tol: 相对误差容忍度（fuzzy=True 时生效）
        fuzzy: 是否模糊匹配（True 时按数值匹配，False 时按原始字符串）

    返回:
        命中的 numbers 列表，按文档时间升序（早→晚，便于追溯）
    """
    if not query.strip():
        return []

    if fuzzy:
        # 解析 query 为数值
        from src.number_extractor import extract_numbers as _en
        parsed = _en(query, context_chars=0, min_value=0)
        if not parsed:
            # 退化到字符串匹配
            return [n for n in index["numbers"] if query in n["raw"] or query in n["context"]]
        target = parsed[0]

        hits = []
        for n in index["numbers"]:
            if numbers_might_be_same(target, n, tol=tol):
                hits.append(n)
    else:
        hits = [n for n in index["numbers"] if query in n["raw"]]

    # 按文档时间升序（最早的在前面 = 最可能是源头）
    hits.sort(key=lambda x: (x.get("doc_time") or "9999", x["doc_id"], x["position"]))
    return hits


def group_hits_by_doc(hits: list[dict]) -> list[dict]:
    """按文档分组，便于展示。"""
    by_doc = defaultdict(list)
    for h in hits:
        by_doc[h["doc_id"]].append(h)

    result = []
    for doc_id, items in by_doc.items():
        result.append({
            "doc_id": doc_id,
            "doc_name": items[0]["doc_name"],
            "doc_path": items[0]["doc_path"],
            "doc_time": items[0]["doc_time"],
            "doc_time_source": items[0]["doc_time_source"],
            "occurrences": items,
            "count": len(items),
        })
    # 按文档时间升序
    result.sort(key=lambda x: x.get("doc_time") or "9999")
    return result
