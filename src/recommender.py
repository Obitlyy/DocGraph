"""相关文档推荐引擎

多维度计算文档间相似度：
- 直接关系（图谱边）：权重最高
- 关键词重叠 (Jaccard)
- 分类相同
- 共享人物
- 共享实体
- 共享指标
"""
from typing import Optional


def jaccard(a: set, b: set) -> float:
    if not a and not b:
        return 0.0
    return len(a & b) / max(len(a | b), 1)


def doc_similarity(doc_a: dict, doc_b: dict, relations: list) -> dict:
    """计算 doc_a 和 doc_b 的相似度分数，返回详细拆解"""
    if doc_a["id"] == doc_b["id"]:
        return {"score": 0.0, "reasons": []}

    score = 0.0
    reasons = []

    # 1. 直接关系（图谱边）
    for r in relations:
        if (r["from"] == doc_a["id"] and r["to"] == doc_b["id"]) or \
           (r["from"] == doc_b["id"] and r["to"] == doc_a["id"]):
            w = 1.0 * r.get("confidence", 0.7)
            score += w
            reasons.append({"type": "direct_relation", "detail": r["type"], "weight": round(w, 3)})
            break

    # 2. 分类相同
    if doc_a.get("category") and doc_a.get("category") == doc_b.get("category"):
        score += 0.2
        reasons.append({"type": "same_category", "detail": doc_a["category"], "weight": 0.2})

    # 3. 关键词 Jaccard
    kw_a = set(doc_a.get("keywords") or [])
    kw_b = set(doc_b.get("keywords") or [])
    if kw_a and kw_b:
        sim = jaccard(kw_a, kw_b)
        if sim > 0:
            w = sim * 0.5
            score += w
            shared = list(kw_a & kw_b)
            if shared:
                reasons.append({"type": "shared_keywords", "detail": shared, "weight": round(w, 3)})

    # 4. 共享人物
    p_a = set(doc_a.get("people") or [])
    p_b = set(doc_b.get("people") or [])
    shared_people = list(p_a & p_b)
    if shared_people:
        w = 0.3 * len(shared_people)
        score += w
        reasons.append({"type": "shared_people", "detail": shared_people, "weight": round(w, 3)})

    # 5. 共享实体
    e_a = {e.get("name") for e in (doc_a.get("entities") or []) if isinstance(e, dict)}
    e_b = {e.get("name") for e in (doc_b.get("entities") or []) if isinstance(e, dict)}
    e_a.discard(None)
    e_b.discard(None)
    shared_entities = list(e_a & e_b)
    if shared_entities:
        w = 0.25 * len(shared_entities)
        score += w
        reasons.append({"type": "shared_entities", "detail": shared_entities, "weight": round(w, 3)})

    # 6. 共享指标名
    m_a = {m.get("name") for m in (doc_a.get("metrics") or []) if isinstance(m, dict)}
    m_b = {m.get("name") for m in (doc_b.get("metrics") or []) if isinstance(m, dict)}
    m_a.discard(None)
    m_b.discard(None)
    shared_metrics = list(m_a & m_b)
    if shared_metrics:
        w = 0.4 * len(shared_metrics)
        score += w
        reasons.append({"type": "shared_metrics", "detail": shared_metrics, "weight": round(w, 3)})

    return {"score": round(score, 3), "reasons": reasons}


def recommend_related(graph: dict, doc_id: str, top_n: int = 8) -> list:
    """返回 Top-N 相关文档"""
    docs = graph.get("docs", [])
    relations = graph.get("relations", [])

    target = next((d for d in docs if d["id"] == doc_id), None)
    if not target:
        return []

    scored = []
    for d in docs:
        if d["id"] == doc_id:
            continue
        sim = doc_similarity(target, d, relations)
        if sim["score"] > 0:
            scored.append({
                "doc_id": d["id"],
                "doc_name": d["name"],
                "category": d.get("category"),
                "summary": d.get("summary"),
                "score": sim["score"],
                "reasons": sim["reasons"],
            })

    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:top_n]
