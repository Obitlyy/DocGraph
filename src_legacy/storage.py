"""图谱数据持久化 + Schema 定义"""
import json
import tempfile
import os
from pathlib import Path
from typing import Optional

from src.relation_schemas import (
    SCHEMAS, get_schema, get_relation_types, get_directional,
)

DATA_DIR = Path(__file__).parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)

# 默认关系类型（向后兼容）——作为 fallback
RELATION_TYPES = get_relation_types("general")
DIRECTIONAL = get_directional("general")

# 收集所有 schema 中出现过的类型（用于完全向后兼容的校验）
ALL_RELATION_TYPES = set()
for _sid, _s in SCHEMAS.items():
    for _r in _s["relations"]:
        ALL_RELATION_TYPES.add(_r["type"])


def _atomic_write(path: Path, data: dict) -> None:
    """原子写入 JSON 文件：先写临时文件，再 rename 覆盖，防止崩溃导致数据损坏。"""
    content = json.dumps(data, ensure_ascii=False, indent=2)
    fd, tmp_path = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp_path, str(path))
    except Exception:
        # 写入失败时清理临时文件
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def get_graph_relation_types(name: str) -> list[str]:
    """根据图谱的 schema 返回其关系类型列表。"""
    g = load_graph(name)
    if not g:
        return RELATION_TYPES
    sid = g.get("schema") or "general"
    return get_relation_types(sid)


def get_graph_directional(name: str) -> set:
    g = load_graph(name)
    if not g:
        return DIRECTIONAL
    sid = g.get("schema") or "general"
    return get_directional(sid)


def save_graph(name: str, docs: list[dict], relations: list[dict], folder: Optional[str] = None, schema: Optional[str] = None) -> str:
    """保存图谱（去掉 text 减小体积）。folder 记录扫描源目录以支持增量更新。"""
    docs_lite = [{k: v for k, v in d.items() if k != "text"} for d in docs]

    # 读取一次现有数据，复用 folder/schema 等字段
    existing = load_graph(name)

    payload = {
        "name": name,
        "docs": docs_lite,
        "relations": relations,
    }
    if folder:
        payload["folder"] = folder
    elif existing and existing.get("folder"):
        payload["folder"] = existing["folder"]

    if schema:
        payload["schema"] = schema
    elif existing and existing.get("schema"):
        payload["schema"] = existing["schema"]
    else:
        payload["schema"] = "general"

    # 保留 existing 中的其他字段（groups/phases/phase_flow 等），避免丢失
    if existing:
        for key in ("groups", "phases", "phase_flow"):
            if key in existing and key not in payload:
                payload[key] = existing[key]

    path = DATA_DIR / f"{name}.json"
    _atomic_write(path, payload)
    return str(path)


def load_graph(name: str) -> Optional[dict]:
    path = DATA_DIR / f"{name}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def list_graphs() -> list[str]:
    """列出所有图谱名，过滤掉内部文件（_numbers.json 等）。"""
    return sorted(
        p.stem for p in DATA_DIR.glob("*.json")
        if not p.stem.startswith("_") and not p.stem.endswith("_numbers")
    )


def write_relations(name: str, relations: list[dict]) -> str:
    """只更新关系（保留已有 docs），用于 Agent 分析后写回。根据图谱的 schema 验证关系类型。"""
    existing = load_graph(name) or {"name": name, "docs": [], "relations": []}
    valid_ids = {d["id"] for d in existing["docs"]}
    schema_id = existing.get("schema") or "general"
    valid_types = set(get_relation_types(schema_id))
    directional = get_directional(schema_id)

    cleaned = []
    for r in relations:
        if not isinstance(r, dict):
            continue
        if r.get("from") not in valid_ids or r.get("to") not in valid_ids:
            continue
        if r.get("type") not in valid_types:
            continue
        if r["from"] == r["to"]:
            continue
        cleaned.append({
            "from": r["from"],
            "to": r["to"],
            "type": r["type"],
            "confidence": float(r.get("confidence", 0.7)),
            "reason": str(r.get("reason", ""))[:200],
            "directional": r["type"] in directional,
        })

    existing["relations"] = cleaned
    path = DATA_DIR / f"{name}.json"
    _atomic_write(path, existing)
    return str(path)


def write_doc_meta(name: str, meta_list: list[dict]) -> str:
    """更新文档的分类/关键词/摘要。meta_list 中每项需含 id。"""
    existing = load_graph(name)
    if not existing:
        raise ValueError(f"图谱不存在: {name}")
    by_id = {m["id"]: m for m in meta_list if m.get("id")}
    updated = 0
    for d in existing["docs"]:
        m = by_id.get(d["id"])
        if not m:
            continue
        if "category" in m:
            d["category"] = str(m["category"])[:30]
        if "keywords" in m:
            kws = m["keywords"]
            if isinstance(kws, str):
                kws = [k.strip() for k in kws.replace("，", ",").split(",") if k.strip()]
            d["keywords"] = [str(k)[:20] for k in kws][:5]
        if "summary" in m:
            d["summary"] = str(m["summary"])[:200]
        if "people" in m:
            ppl = m["people"] or []
            if isinstance(ppl, str):
                ppl = [p.strip() for p in ppl.replace("，", ",").split(",") if p.strip()]
            d["people"] = [str(p)[:30] for p in ppl][:5]
        if "phase" in m:
            d["phase"] = str(m["phase"])[:20]
        # 新增结构化字段
        if "metrics" in m:
            d["metrics"] = m["metrics"] if isinstance(m["metrics"], list) else []
        if "timeline" in m:
            d["timeline"] = m["timeline"] if isinstance(m["timeline"], list) else []
        if "entities" in m:
            d["entities"] = m["entities"] if isinstance(m["entities"], list) else []
        if "citations" in m:
            d["citations"] = m["citations"] if isinstance(m["citations"], list) else []
        updated += 1
    path = DATA_DIR / f"{name}.json"
    _atomic_write(path, existing)
    return f"{path} (更新了 {updated} 个文档)"


def apply_doc_diff(
    name: str,
    added: list[dict],
    modified: list[dict],
    deleted_ids: list[str],
    folder: Optional[str] = None,
) -> dict:
    """对图谱执行增量更新：新增/修改/删除 docs，并清理失效关系。

    - 新增 doc 直接加入（含 mtime/preview/char_count 等基础字段，分类等待后续 LLM 填充）
    - 修改 doc 复用旧 id，更新文件相关字段（mtime/size/preview/char_count），
      但保留 LLM 之前打的标签（category/keywords/summary/...）作为提示，待重新分析后覆盖
    - 删除 doc 从 docs 列表移除，相关 relations 清理掉
    返回：摘要 dict
    """
    existing = load_graph(name)
    if not existing:
        raise ValueError(f"图谱不存在: {name}")

    docs = existing.get("docs", [])
    by_id = {d["id"]: d for d in docs}

    # 删除
    for did in deleted_ids:
        by_id.pop(did, None)

    # 修改：保留 LLM 标签字段，刷新文件字段
    LLM_FIELDS = {
        "category", "keywords", "summary", "phase", "people",
        "metrics", "timeline", "entities", "citations",
    }
    FILE_FIELDS = {"name", "rel_path", "abs_path", "ext", "size", "mtime", "preview", "char_count"}

    for fdoc in modified:
        old = by_id.get(fdoc["id"])
        if old is None:
            # 安全降级：不存在就当新增
            by_id[fdoc["id"]] = {k: v for k, v in fdoc.items() if k != "text"}
            continue
        for k in FILE_FIELDS:
            if k in fdoc:
                old[k] = fdoc[k]
        # LLM 字段保持原样，等重分析覆盖

    # 新增
    for fdoc in added:
        by_id[fdoc["id"]] = {k: v for k, v in fdoc.items() if k != "text"}

    new_docs = list(by_id.values())
    valid_ids = set(by_id.keys())

    # 清理失效关系（指向被删 doc 的）
    relations = existing.get("relations", [])
    kept_relations = [r for r in relations if r.get("from") in valid_ids and r.get("to") in valid_ids]
    removed_relations = len(relations) - len(kept_relations)

    existing["docs"] = new_docs
    existing["relations"] = kept_relations
    if folder:
        existing["folder"] = folder

    path = DATA_DIR / f"{name}.json"
    _atomic_write(path, existing)

    return {
        "added_count": len(added),
        "modified_count": len(modified),
        "deleted_count": len(deleted_ids),
        "removed_relations": removed_relations,
        "total_docs": len(new_docs),
    }


def write_groups(name: str, groups: list[dict]) -> str:
    """写入文档分组（同一批次/同一项目这类元数据级归属）。"""
    existing = load_graph(name)
    if not existing:
        raise ValueError(f"图谱不存在: {name}")
    valid_ids = {d["id"] for d in existing.get("docs", [])}
    cleaned = []
    for g in groups:
        ids = [i for i in (g.get("doc_ids") or []) if i in valid_ids]
        if len(ids) < 2:
            continue
        cleaned.append({
            "type": g.get("type", "同一批次"),
            "doc_ids": sorted(ids),
            "topic": str(g.get("topic", ""))[:120],
        })
    existing["groups"] = cleaned
    path = DATA_DIR / f"{name}.json"
    _atomic_write(path, existing)
    return str(path)
