"""深度探索模块 - 发现跨组文件的潜在逻辑关联

流程:
1. summarize_files: 快速读取每个文档,LLM 生成简短摘要
2. find_candidates: 跨组两两比对摘要,找出可能有关联的 pairs
3. confirm_links: 对 candidate pairs 精读确认
"""
import json
import time
import hashlib
from pathlib import Path
from typing import Optional
from collections import defaultdict

from src.scanner import extract_text
from src.llm_client import chat

# 支持深度探索的文件扩展名
EXPLORABLE_EXTS = {
    ".md", ".txt", ".pdf", ".docx", ".doc", ".pptx", ".ppt",
    ".xlsx", ".csv", ".py", ".js", ".ts", ".tsx", ".jsx",
    ".go", ".rs", ".java", ".html", ".json", ".yaml", ".yml",
    ".sh", ".sql", ".r", ".ipynb",
}

# 摘要截取长度
SUMMARY_INPUT_CHARS = 1500
# 每批摘要数量
SUMMARY_BATCH_SIZE = 20
# 候选对最大数量（避免爆 token）
MAX_CANDIDATES = 60


def _file_id(path: str) -> str:
    return hashlib.md5(path.encode()).hexdigest()[:10]


def summarize_files(
    clusters: list[dict],
    on_progress=None,
    model: str = "deepseek-v4-flash",
) -> dict[str, dict]:
    """Phase 1: 快速摘要每个可探索的文件。

    Returns:
        {file_path: {"summary": str, "cluster_id": str, "name": str}}
    """
    # 收集所有可探索的文件
    file_items = []
    for c in clusters:
        for f in c.get("files", []):
            ext = Path(f["path"]).suffix.lower()
            if ext in EXPLORABLE_EXTS and f.get("size", 0) < 10 * 1024 * 1024:
                file_items.append({
                    "path": f["path"],
                    "name": f["name"],
                    "cluster_id": c["id"],
                    "cluster_label": c.get("label", ""),
                })

    total = len(file_items)
    if total == 0:
        return {}

    if on_progress:
        on_progress({"phase": "deep_summarize", "message": f"快速摘要 {total} 个文件...", "progress": 0, "total": total})

    summaries = {}
    batch = []

    for idx, item in enumerate(file_items):
        try:
            text = extract_text(Path(item["path"]))
            if not text or len(text.strip()) < 50:
                continue
            snippet = text[:SUMMARY_INPUT_CHARS]
            batch.append({
                "path": item["path"],
                "name": item["name"],
                "cluster_id": item["cluster_id"],
                "snippet": snippet,
            })
        except Exception:
            continue

        # 批量发 LLM
        if len(batch) >= SUMMARY_BATCH_SIZE or idx == total - 1:
            if batch:
                results = _batch_summarize(batch, model)
                summaries.update(results)
                batch = []

            if on_progress:
                on_progress({
                    "phase": "deep_summarize",
                    "message": f"已摘要 {min(idx + 1, total)}/{total}",
                    "progress": min(idx + 1, total),
                    "total": total,
                })

    return summaries


def _batch_summarize(batch: list[dict], model: str) -> dict[str, dict]:
    """批量摘要（单次 LLM 调用处理多个文件）"""
    file_texts = []
    for i, item in enumerate(batch):
        file_texts.append(f"[{i}] 文件: {item['name']}\n内容片段:\n{item['snippet'][:800]}")

    prompt = f"""请为以下 {len(batch)} 个文件各生成一句话摘要（20-50字），概括其核心内容/用途。

{chr(10).join(file_texts)}

输出严格 JSON 数组，每项: {{"idx": 数字, "summary": "一句话摘要"}}"""

    try:
        resp = chat(
            prompt=prompt,
            system="你是文件分析助手，输出严格 JSON。",
            model=model,
            json_mode=True,
            temperature=0.1,
            max_tokens=3000,
        )
        content = resp.get("content", "")
        # 解析 JSON
        import re
        m = re.search(r"\[[\s\S]*\]", content)
        if m:
            items = json.loads(m.group(0))
        else:
            return {}

        result = {}
        for item in items:
            idx = item.get("idx")
            summary = item.get("summary", "")
            if idx is not None and 0 <= idx < len(batch) and summary:
                b = batch[idx]
                result[b["path"]] = {
                    "summary": summary,
                    "cluster_id": b["cluster_id"],
                    "name": b["name"],
                }
        return result
    except Exception as e:
        print(f"[deep_explore] 批量摘要失败: {e}")
        return {}


def find_candidates(
    summaries: dict[str, dict],
    clusters: list[dict],
    on_progress=None,
    model: str = "deepseek-v4-flash",
) -> list[dict]:
    """Phase 2: 跨组比对摘要，找出可能关联的文件对。

    策略: 按 cluster 分组，每次取两个不同 cluster 的摘要集合丢给 LLM 判断。
    为减少调用次数，先按 cluster 生成"组摘要"，然后组间比对。
    """
    if on_progress:
        on_progress({"phase": "deep_candidates", "message": "分析跨组关联候选..."})

    # 按 cluster 聚合
    cluster_files: dict[str, list[dict]] = defaultdict(list)
    for path, info in summaries.items():
        cluster_files[info["cluster_id"]].append({
            "path": path,
            "name": info["name"],
            "summary": info["summary"],
        })

    cluster_ids = list(cluster_files.keys())
    n = len(cluster_ids)
    if n < 2:
        return []

    # 生成每个 cluster 的汇总描述（用于高效比对）
    cluster_briefs = {}
    for cid in cluster_ids:
        files = cluster_files[cid]
        c = next((c for c in clusters if c["id"] == cid), None)
        label = c.get("label", cid) if c else cid
        brief_lines = [f"组「{label}」({len(files)} 文件):"]
        for f in files[:15]:  # 最多 15 个摘要
            brief_lines.append(f"  - {f['name']}: {f['summary']}")
        if len(files) > 15:
            brief_lines.append(f"  ... 还有 {len(files) - 15} 个")
        cluster_briefs[cid] = "\n".join(brief_lines)

    # 两两组合（大于 20 组时抽样）
    pairs_to_check = []
    for i in range(n):
        for j in range(i + 1, n):
            pairs_to_check.append((cluster_ids[i], cluster_ids[j]))

    # 限制最多 50 对（避免爆）
    if len(pairs_to_check) > 50:
        import random
        random.shuffle(pairs_to_check)
        pairs_to_check = pairs_to_check[:50]

    if on_progress:
        on_progress({"phase": "deep_candidates", "message": f"比对 {len(pairs_to_check)} 组对..."})

    # 批量提交（每次最多 8 对）
    all_candidates = []
    BATCH = 8
    for batch_start in range(0, len(pairs_to_check), BATCH):
        batch_pairs = pairs_to_check[batch_start:batch_start + BATCH]
        candidates = _batch_find_links(batch_pairs, cluster_briefs, cluster_files, model)
        all_candidates.extend(candidates)

        if on_progress:
            on_progress({
                "phase": "deep_candidates",
                "message": f"已比对 {min(batch_start + BATCH, len(pairs_to_check))}/{len(pairs_to_check)} 组对",
                "progress": min(batch_start + BATCH, len(pairs_to_check)),
                "total": len(pairs_to_check),
            })

    # 去重 + 限数
    seen = set()
    unique = []
    for c in all_candidates:
        key = tuple(sorted([c["source_file"], c["target_file"]]))
        if key not in seen:
            seen.add(key)
            unique.append(c)

    return unique[:MAX_CANDIDATES]


def _batch_find_links(
    pairs: list[tuple[str, str]],
    cluster_briefs: dict[str, str],
    cluster_files: dict[str, list[dict]],
    model: str,
) -> list[dict]:
    """一次 LLM 调用比对多组组对"""
    sections = []
    for idx, (cid_a, cid_b) in enumerate(pairs):
        sections.append(f"--- 组对 {idx} ---\n{cluster_briefs[cid_a]}\n\n{cluster_briefs[cid_b]}")

    prompt = f"""以下是 {len(pairs)} 对文件组。每对包含两个不同组的文件摘要。
请找出每对中可能存在逻辑关联的文件对（如：重复造轮子、引用相同数据源、解决相同问题、互为上下游等）。

仅输出你有较高信心（>60%）确实相关的。如果某组对没有关联，跳过。

{chr(10).join(sections)}

输出严格 JSON 数组，每项:
{{"pair_idx": 数字, "source_file": "文件名", "target_file": "文件名", "reason": "关联原因(一句话)", "confidence": 0.0-1.0}}

如果完全没有关联，返回空数组 []。"""

    try:
        resp = chat(
            prompt=prompt,
            system="你是跨项目关联分析专家。仅输出 JSON。",
            model=model,
            json_mode=True,
            temperature=0.15,
            max_tokens=4000,
        )
        content = resp.get("content", "")
        import re
        m = re.search(r"\[[\s\S]*\]", content)
        if not m:
            return []
        items = json.loads(m.group(0))

        results = []
        for item in items:
            pidx = item.get("pair_idx")
            if pidx is None or pidx >= len(pairs):
                continue
            cid_a, cid_b = pairs[pidx]
            # 找到对应的完整路径
            src_name = item.get("source_file", "")
            tgt_name = item.get("target_file", "")
            src_path = _find_file_path(src_name, cluster_files[cid_a]) or _find_file_path(src_name, cluster_files[cid_b])
            tgt_path = _find_file_path(tgt_name, cluster_files[cid_b]) or _find_file_path(tgt_name, cluster_files[cid_a])

            if not src_path or not tgt_path:
                continue

            # 确定哪个属于哪个 cluster
            src_cid = cid_a if any(f["path"] == src_path for f in cluster_files[cid_a]) else cid_b
            tgt_cid = cid_b if any(f["path"] == tgt_path for f in cluster_files[cid_b]) else cid_a

            results.append({
                "source_cluster_id": src_cid,
                "target_cluster_id": tgt_cid,
                "source_file": src_path,
                "source_name": src_name,
                "target_file": tgt_path,
                "target_name": tgt_name,
                "reason": item.get("reason", ""),
                "confidence": float(item.get("confidence", 0.6)),
            })
        return results
    except Exception as e:
        print(f"[deep_explore] 批量比对失败: {e}")
        return []


def _find_file_path(name: str, files: list[dict]) -> Optional[str]:
    """模糊匹配文件名 → 完整路径"""
    name_lower = name.lower().strip()
    # 精确
    for f in files:
        if f["name"].lower() == name_lower:
            return f["path"]
    # 包含
    for f in files:
        if name_lower in f["name"].lower() or f["name"].lower() in name_lower:
            return f["path"]
    return None


def confirm_links(
    candidates: list[dict],
    on_progress=None,
    model: Optional[str] = None,
) -> list[dict]:
    """Phase 3: 精读确认候选关联。

    用 standard 模式读取两个文件内容片段，确认是否真正相关。
    """
    model = model or "deepseek-v4-flash"  # 中度模式
    total = len(candidates)
    if total == 0:
        return []

    if on_progress:
        on_progress({"phase": "deep_confirm", "message": f"精读确认 {total} 对候选...", "progress": 0, "total": total})

    confirmed = []
    BATCH = 5

    for batch_start in range(0, total, BATCH):
        batch = candidates[batch_start:batch_start + BATCH]
        results = _batch_confirm(batch, model)
        confirmed.extend(results)

        if on_progress:
            on_progress({
                "phase": "deep_confirm",
                "message": f"已确认 {min(batch_start + BATCH, total)}/{total}",
                "progress": min(batch_start + BATCH, total),
                "total": total,
            })

    return confirmed


def _batch_confirm(candidates: list[dict], model: str) -> list[dict]:
    """批量精读确认"""
    sections = []
    for idx, c in enumerate(candidates):
        src_text = ""
        tgt_text = ""
        try:
            src_text = extract_text(Path(c["source_file"]))[:2000]
        except Exception:
            pass
        try:
            tgt_text = extract_text(Path(c["target_file"]))[:2000]
        except Exception:
            pass

        if not src_text or not tgt_text:
            continue

        sections.append(f"""--- 对 {idx} ---
初筛原因: {c.get('reason', '未知')}
文件A [{c['source_name']}]:
{src_text[:1500]}

文件B [{c['target_name']}]:
{tgt_text[:1500]}""")

    if not sections:
        return []

    prompt = f"""以下是 {len(sections)} 对候选关联文件。请精读内容，判断是否存在真实的逻辑关联。

关联类型包括但不限于:
- duplicate: 重复造轮子（解决相同问题的不同实现）
- shared_data: 引用或生成相同数据
- upstream: 互为上下游（A的输出是B的输入）
- reference: 引用/参考关系
- evolution: 同一事物的不同版本/迭代
- topic: 讨论相同主题/概念

{chr(10).join(sections)}

对每对输出判断。输出严格 JSON 数组:
{{"idx": 数字, "confirmed": true/false, "link_type": "类型", "detail": "具体解释(1-2句)", "confidence": 0.0-1.0}}"""

    try:
        resp = chat(
            prompt=prompt,
            system="你是代码与文档关联分析专家。仔细阅读后判断。输出 JSON。",
            model=model,
            json_mode=True,
            temperature=0.1,
            max_tokens=4000,
        )
        content = resp.get("content", "")
        import re
        m = re.search(r"\[[\s\S]*\]", content)
        if not m:
            return []
        items = json.loads(m.group(0))

        confirmed = []
        for item in items:
            idx = item.get("idx")
            if idx is None or idx >= len(candidates) or not item.get("confirmed"):
                continue
            c = candidates[idx]
            confirmed.append({
                **c,
                "link_type": item.get("link_type", "reference"),
                "detail": item.get("detail", c.get("reason", "")),
                "confidence": float(item.get("confidence", 0.7)),
            })
        return confirmed
    except Exception as e:
        print(f"[deep_explore] 精读确认失败: {e}")
        return []


def deep_explore_workflow(
    clusters: list[dict],
    on_progress=None,
    fast_model: str = "deepseek-v4-flash",
    confirm_model: Optional[str] = None,
) -> list[dict]:
    """完整深度探索流程。

    Returns:
        cross_links: [{source_cluster_id, target_cluster_id, source_file, target_file,
                       source_name, target_name, link_type, detail, confidence}]
    """
    confirm_model = confirm_model or fast_model
    t0 = time.time()

    # Phase 1
    summaries = summarize_files(clusters, on_progress=on_progress, model=fast_model)
    if not summaries:
        return []

    # Phase 2
    candidates = find_candidates(summaries, clusters, on_progress=on_progress, model=fast_model)
    if not candidates:
        return []

    # Phase 3
    confirmed = confirm_links(candidates, on_progress=on_progress, model=confirm_model)

    elapsed = round(time.time() - t0, 2)
    if on_progress:
        on_progress({
            "phase": "deep_done",
            "message": f"深度探索完成: {len(confirmed)} 条跨组关联 ({elapsed}s)",
        })

    return confirmed
