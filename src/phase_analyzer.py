"""项目阶段（Phase）分析。

把文件夹结构理解为研究/项目的"阶段"，每个 phase 是一组在同一目录下的文档。
- 半自动：LLM 提议候选 + 用户确认
- 每个 phase 跑一段 B 级总结（目标/方法/产出/关键发现）
"""
from __future__ import annotations
import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Optional

from src.llm_client import chat
from src.storage import load_graph, DATA_DIR


# ============ Stage 1: 自动从目录结构提议候选 ============

PHASE_HINT_KEYWORDS = [
    # 中文阶段词
    "阶段", "第一阶段", "第二阶段", "第三阶段", "第四阶段",
    "阶段一", "阶段二", "阶段三", "阶段四",
    "一期", "二期", "三期",
    # 研究流程词
    "调研", "访谈", "实施", "执行", "总结", "汇总",
    "规划", "计划", "启动", "立项",
    "数据", "分析", "报告",
    # 英文
    "phase", "stage", "iteration", "milestone",
    "v1", "v2", "v3",
]


def _looks_like_phase_dir(name: str) -> bool:
    """目录名是否像阶段标签"""
    n = name.lower()
    for kw in PHASE_HINT_KEYWORDS:
        if kw.lower() in n:
            return True
    # 数字前缀也常常是阶段（如 "01_启动"）
    if re.match(r'^\d{1,2}[_\-\s]', name):
        return True
    return False


def propose_phases(graph_name: str, max_depth: int = 2) -> dict:
    """从 doc 的 rel_path 推断候选阶段（默认 2 层）。

    返回:
        {
            "candidates": [
                {
                    "id": "phase_xxx",
                    "name": "阶段一访谈",
                    "path_pattern": "研究内容/阶段一访谈",
                    "doc_ids": [...],         # 本层直接归属的（子层不重复）
                    "order": 1,
                    "auto_score": 0.9,
                    "depth": 2,                # 路径层级
                    "level": 0,                # phase 树中的层级 (0=顶层)
                    "children": [...]          # 子阶段
                }
            ],
            "uncategorized_doc_ids": [...]
        }
    """
    graph = load_graph(graph_name)
    if not graph:
        raise ValueError(f"图谱不存在: {graph_name}")

    docs = graph.get("docs", [])

    # 计算每个 doc 的目录路径（不含文件名）
    doc_dir_parts: dict[str, list[str]] = {}
    for d in docs:
        rel = d.get("rel_path", "")
        parts = rel.split("/")
        doc_dir_parts[d["id"]] = parts[:-1] if len(parts) > 1 else []

    def _build_level(parent_prefix: tuple, candidate_doc_ids: set, current_level: int) -> list[dict]:
        """在 parent_prefix 下，从候选 docs 中接着划分下一层。"""
        if current_level >= max_depth:
            return []

        # 按“下一层目录名”聚合候选 docs
        by_next_dir: dict[str, list[str]] = defaultdict(list)
        for did in candidate_doc_ids:
            parts = doc_dir_parts.get(did, [])
            # parts 必须包含 parent_prefix 作为前缀
            if len(parts) <= len(parent_prefix):
                continue
            if tuple(parts[:len(parent_prefix)]) != parent_prefix:
                continue
            next_dir = parts[len(parent_prefix)]
            by_next_dir[next_dir].append(did)

        # 评分 + 选择
        ranked = []
        for next_dir, ids in by_next_dir.items():
            if len(ids) < 2:
                continue
            score = 0.0
            if _looks_like_phase_dir(next_dir):
                score += 1.0
            # 顶层 (level=0) 偏好有阶段词汇的名字；子层偏好有一定文档量
            score += 0.4 - 0.1 * current_level
            n = len(ids)
            if 3 <= n <= 20:
                score += 0.3
            elif n > 30:
                score -= 0.2
            ranked.append((score, next_dir, sorted(set(ids))))

        # 贪心选取：顶层需要 score >= 0.3；子层只要 doc 数 >= 2 就考虑
        ranked.sort(key=lambda x: -x[0])
        chosen_groups = []
        covered: set = set()
        threshold = 0.3 if current_level == 0 else 0.0
        for score, name, ids in ranked:
            if score < threshold:
                continue
            new_ids = set(ids) - covered
            if len(new_ids) < 2:
                continue
            chosen_groups.append({
                "name": name,
                "doc_ids": sorted(new_ids),
                "score": round(score, 2),
                "depth_in_path": len(parent_prefix) + 1,
            })
            covered |= new_ids

        # 构建节点
        nodes = []
        for i, g in enumerate(chosen_groups):
            new_prefix = parent_prefix + (g["name"],)
            # 递归取子阶段
            children = _build_level(new_prefix, set(g["doc_ids"]), current_level + 1)
            # 子阶段占据的 doc_ids 从本层移走
            child_owned: set = set()
            def _collect_owned(ns):
                for n in ns:
                    child_owned.update(n["doc_ids"])
                    _collect_owned(n.get("children") or [])
            _collect_owned(children)
            own_ids = sorted(set(g["doc_ids"]) - child_owned)
            nodes.append({
                "id": "",  # 在外层统一分配
                "name": g["name"],
                "path_pattern": "/".join(new_prefix),
                "doc_ids": own_ids,
                "all_doc_ids": g["doc_ids"],  # 含子层（辅助信息）
                "order": i + 1,
                "depth": len(new_prefix),
                "level": current_level,
                "auto_score": g["score"],
                "doc_count": len(g["doc_ids"]),  # 含子层总数
                "children": children,
            })
        return nodes

    all_doc_ids = set(d["id"] for d in docs)
    candidates = _build_level((), all_doc_ids, 0)

    # 展平提升：如果某个顶层节点本层 0 文档且有多个子层（说明只是个壳），
    # 把子层提升到顶层。
    promoted = []
    for c in candidates:
        children = c.get("children") or []
        # 本层文档很少 (≤ 2) 且有多个子层 -> 该层是“壳”，提升子层
        if len(c["doc_ids"]) <= 2 and len(children) >= 2:
            for ch in children:
                ch["level"] = 0
            promoted.extend(children)
        else:
            promoted.append(c)
    candidates = promoted

    # 按 path_pattern 字母序作为 order 雏形（LLM 会后续调整）
    candidates.sort(key=lambda x: x["path_pattern"])

    # 统一分配全局 id
    counter = [0]
    def _assign_ids(nodes, parent_id=""):
        for i, n in enumerate(nodes):
            counter[0] += 1
            n["id"] = f"phase_{counter[0]}"
            n["order"] = i + 1
            _assign_ids(n.get("children") or [], n["id"])
    _assign_ids(candidates)

    # 未归类：不在任何顶层 phase 下的文档
    covered_top: set = set()
    def _collect_all(nodes):
        for n in nodes:
            covered_top.update(n["doc_ids"])
            _collect_all(n.get("children") or [])
    _collect_all(candidates)
    uncategorized = sorted(d["id"] for d in docs if d["id"] not in covered_top)

    return {
        "candidates": candidates,
        "uncategorized_doc_ids": uncategorized,
        "total_docs": len(docs),
        "max_depth": max_depth,
    }


# ============ Stage 2: LLM 优化候选（命名 + 排序） ============

ORDER_PROMPT = """以下是一个研究/项目的目录结构和文档分布。请根据文档内容和目录命名，判断这些「阶段」的执行顺序，并给每个阶段起一个简短清晰的名字。

候选阶段：
{phases}

输出 JSON：
{{
  "phases": [
    {{
      "id": "phase_x",
      "name": "推荐的阶段名（5-15字，简洁）",
      "order": 1,
      "rationale": "为什么是这个顺序"
    }}
  ]
}}

要求：
- order 从 1 递增，反映项目实际推进顺序
- 时间线索：路径里的"阶段一/二""规划/启动/执行/总结"或文档时间
- 名字要简短，不要复制原始目录名（除非已经很好）
- 必须每个候选都返回，id 必须对得上
"""


def refine_phases_with_llm(candidates: list[dict], graph: dict, model: str = "deepseek-v4-flash") -> list[dict]:
    """用 LLM 优化阶段命名和排序（仅顶层，子层保留原始名以节 token）。"""
    if len(candidates) <= 1:
        return candidates

    # 准备 prompt 输入
    docs_by_id = {d["id"]: d for d in graph.get("docs", [])}
    lines = []
    for c in candidates:
        sample_names = []
        sample_summaries = []
        # 顶层可能只有子层（本层 doc_ids 为空），看 all_doc_ids
        sample_pool = c.get("all_doc_ids") or c["doc_ids"]
        for did in sample_pool[:5]:
            d = docs_by_id.get(did, {})
            sample_names.append(d.get("name", ""))
            if d.get("summary"):
                sample_summaries.append(d["summary"][:60])
        children_info = ""
        if c.get("children"):
            children_info = f" 含子阶段={','.join(ch['name'] for ch in c['children'])}"
        lines.append(
            f"- id={c['id']} | 路径={c['path_pattern']} | 文档数={c['doc_count']} | "
            f"样例文件={', '.join(sample_names[:3])}{children_info}"
        )

    prompt = ORDER_PROMPT.format(phases="\n".join(lines))
    try:
        resp = chat(
            prompt,
            system="你是项目结构分析专家。",
            model=model,
            json_mode=True,
            max_tokens=1500,
            temperature=0.2,
            thinking="disabled",
        )
        data = resp.get("data") or {}
        refined_map = {p["id"]: p for p in data.get("phases", [])}
        for c in candidates:
            r = refined_map.get(c["id"])
            if r:
                c["name"] = (r.get("name") or c["name"])[:30]
                c["order"] = int(r.get("order", c["order"]))
                if r.get("rationale"):
                    c["rationale"] = r["rationale"][:100]
        candidates.sort(key=lambda x: x["order"])
        for i, c in enumerate(candidates):
            c["order"] = i + 1
    except Exception:
        pass
    return candidates


# ============ Stage 3: 生成阶段总结（B 级一段话） ============

PHASE_SUMMARY_PROMPT = """请为以下研究/项目阶段生成一段简明的总结。

阶段：{name}
路径：{path}
顺序：第 {order} 阶段
包含 {n_docs} 篇文档：

{docs}

请按以下结构输出一段连贯的中文总结（150-250 字）：
1. 这个阶段的目标是什么
2. 用了什么方法/做了什么工作
3. 产出了什么核心成果
4. 有哪些关键发现/结论（如有）

输出 JSON：
{{
  "summary": "一段连贯的总结文字...",
  "objective": "目标(20字内)",
  "outputs": ["产出1", "产出2"],
  "key_findings": ["发现1", "发现2"]
}}
"""


def summarize_phase(phase: dict, graph: dict, model: str = "deepseek-v4-flash") -> dict:
    """为单个 phase 生成总结"""
    docs_by_id = {d["id"]: d for d in graph.get("docs", [])}
    doc_lines = []
    for did in phase["doc_ids"][:30]:  # 最多看 30 篇，防止超长
        d = docs_by_id.get(did, {})
        cat = d.get("category", "")
        summary = (d.get("summary") or "")[:120]
        kws = ", ".join(d.get("keywords") or [])
        doc_lines.append(
            f"- [{cat}] {d.get('name','')} | 关键词={kws} | {summary}"
        )

    prompt = PHASE_SUMMARY_PROMPT.format(
        name=phase["name"],
        path=phase["path_pattern"],
        order=phase["order"],
        n_docs=len(phase["doc_ids"]),
        docs="\n".join(doc_lines),
    )

    resp = chat(
        prompt,
        system="你是项目研究总结专家，擅长把碎片文档归纳为连贯叙述。",
        model=model,
        json_mode=True,
        max_tokens=1500,
        temperature=0.3,
        thinking="disabled",
    )
    data = resp.get("data") or {}
    return {
        "summary": (data.get("summary") or "").strip(),
        "objective": (data.get("objective") or "").strip()[:50],
        "outputs": data.get("outputs", [])[:5],
        "key_findings": data.get("key_findings", [])[:5],
        "tokens": resp.get("tokens", {}).get("total", 0),
    }


# ============ 持久化 ============

def save_phases(graph_name: str, phases: list[dict]) -> str:
    """把 phases（可嵌套）写回 graph json。"""
    graph = load_graph(graph_name)
    if not graph:
        raise ValueError(f"图谱不存在: {graph_name}")
    valid_ids = {d["id"] for d in graph.get("docs", [])}

    counter = [0]
    def _clean(node: dict, level: int = 0) -> Optional[dict]:
        ids = sorted(set(i for i in node.get("doc_ids", []) if i in valid_ids))
        children_in = node.get("children") or []
        # 限制最多 3 层
        if level >= 3:
            children_in = []
        children = []
        for ch in children_in:
            cleaned = _clean(ch, level + 1)
            if cleaned:
                children.append(cleaned)
        children.sort(key=lambda x: x["order"])
        # 重新分配同级 order
        for i, ch in enumerate(children):
            ch["order"] = i + 1

        if not ids and not children:
            return None
        counter[0] += 1
        return {
            "id": node.get("id") or f"phase_{counter[0]}",
            "name": str(node.get("name", "未命名"))[:30],
            "path_pattern": str(node.get("path_pattern", ""))[:200],
            "doc_ids": ids,
            "order": int(node.get("order", counter[0])),
            "summary": (node.get("summary") or "")[:1500],
            "objective": (node.get("objective") or "")[:50],
            "outputs": (node.get("outputs") or [])[:8],
            "key_findings": (node.get("key_findings") or [])[:8],
            "children": children,
        }

    cleaned_top = []
    for p in phases:
        c = _clean(p, level=0)
        if c:
            cleaned_top.append(c)
    cleaned_top.sort(key=lambda x: x["order"])
    for i, p in enumerate(cleaned_top):
        p["order"] = i + 1

    graph["phases"] = cleaned_top
    path = DATA_DIR / f"{graph_name}.json"
    path.write_text(json.dumps(graph, ensure_ascii=False, indent=2), encoding="utf-8")
    return str(path)


def flatten_phases(phases: list[dict]) -> list[dict]:
    """展平阶段树，返回所有需要生成总结的节点（仅含其本层 doc_ids）。"""
    out = []
    def _walk(nodes, parent_path=""):
        for n in nodes:
            full_path = f"{parent_path} > {n['name']}" if parent_path else n["name"]
            n["_full_path"] = full_path
            out.append(n)
            _walk(n.get("children") or [], full_path)
    _walk(phases)
    return out


# ============ Stage 4: 自动合并新提议到现有阶段（保留用户手动编辑） ============

def auto_update_phases(graph_name: str, refine: bool = True) -> dict:
    """基于当前目录结构重新提议阶段，并将新增/变化的文档自动归并到现有阶段中。

    策略：
    - 已经被现有阶段（含子阶段）覆盖的文档：保留在原阶段中不动。
    - 新提议中出现、但现有阶段没有的文档：尝试按 path_pattern 匹配现有阶段；
      没匹配上的，作为「新阶段」追加到顶层末尾。
    - 已经在现有阶段中、但磁盘上不存在的文档（在 graph 中已被删除）：自动从阶段中剔除。
    返回：{ phases: [...], added_to_existing, new_phases, removed_doc_ids }
    """
    graph = load_graph(graph_name)
    if not graph:
        raise ValueError(f"图谱不存在: {graph_name}")

    valid_doc_ids = {d["id"] for d in graph.get("docs", [])}
    existing = graph.get("phases") or []

    # 收集现有阶段中所有文档（含子层）
    def _collect_all(nodes):
        ids = set()
        for n in nodes:
            ids.update(n.get("doc_ids") or [])
            ids.update(_collect_all(n.get("children") or []))
        return ids

    covered_now = _collect_all(existing)

    # 清理：删除已不存在的文档
    removed_ids = covered_now - valid_doc_ids
    def _clean_removed(nodes):
        for n in nodes:
            n["doc_ids"] = [d for d in (n.get("doc_ids") or []) if d in valid_doc_ids]
            _clean_removed(n.get("children") or [])
    _clean_removed(existing)

    # 重新提议
    proposal = propose_phases(graph_name)
    candidates = proposal["candidates"]

    # 用 path_pattern → 现有 phase 节点的索引（含子层）
    path_to_node: dict[str, dict] = {}
    def _index(nodes):
        for n in nodes:
            p = n.get("path_pattern")
            if p:
                path_to_node[p] = n
            _index(n.get("children") or [])
    _index(existing)

    # 重新计算覆盖（清理删除文档后）
    covered_now = _collect_all(existing)

    # 遍历新提议，把没在现有阶段中的文档分发
    added_to_existing: list[dict] = []  # [{phase_id, doc_ids}]
    new_phases: list[dict] = []

    def _walk_proposal(nodes):
        for n in nodes:
            new_doc_ids = [d for d in (n.get("doc_ids") or []) if d not in covered_now]
            if new_doc_ids:
                hit = path_to_node.get(n.get("path_pattern") or "")
                if hit:
                    # 加到现有阶段（去重）
                    existing_ids = set(hit.get("doc_ids") or [])
                    existing_ids.update(new_doc_ids)
                    hit["doc_ids"] = sorted(existing_ids)
                    added_to_existing.append({
                        "phase_id": hit["id"], "phase_name": hit["name"],
                        "added_count": len(new_doc_ids),
                    })
                    covered_now.update(new_doc_ids)
                else:
                    # 作为新顶层阶段追加（保留它的子层结构）
                    new_phases.append(n)
                    covered_now.update(_collect_all([n]))
            _walk_proposal(n.get("children") or [])
    _walk_proposal(candidates)

    # 把新阶段拼到现有阶段末尾，重新分配 order
    next_order = max((p.get("order", 0) for p in existing), default=0)
    for np in new_phases:
        next_order += 1
        np["order"] = next_order
        np["level"] = 0
        existing.append(np)

    # 落盘
    save_phases(graph_name, existing)

    return {
        "phases": existing,
        "added_to_existing": added_to_existing,
        "new_phases": [{"name": p["name"], "path_pattern": p.get("path_pattern"), "doc_count": len(p.get("doc_ids") or [])} for p in new_phases],
        "removed_doc_ids": sorted(removed_ids),
        "total_phases": len(existing),
    }


# ============ Stage 5: 阶段间内容流程分析（基于阶段总结） ============

FLOW_PROMPT = """以下是一个项目的多个阶段及其总结。请分析这些阶段在内容上的逻辑流转关系（不是时间顺序），形成一张内容流程图。

阶段列表（按当前 order 排序）：
{phases}

请输出 JSON：
{{
  "nodes": [
    {{"id": "phase_x", "label": "简短的阶段标签（5-10字）", "role": "输入/分析/产出/决策"}}
  ],
  "edges": [
    {{
      "from": "phase_x",
      "to": "phase_y",
      "label": "流转关系简述（如：提供数据、推导出、得出结论）",
      "type": "feeds|derives|concludes|references"
    }}
  ],
  "insight": "对整体流程的一句话洞察"
}}

要求：
- 关注「内容上的依赖」而不是简单的时间先后（前一阶段未必直接导出后一阶段）
- edges 数量控制在 nodes 数 ± 2 之间，不要全连接
- type 取值：feeds（提供数据/材料）、derives（衍生/分析得出）、concludes（汇总结论）、references（引用/参考）
- role 描述这个阶段在整个项目中扮演什么角色
"""


def analyze_phase_flow(graph_name: str, model: str = "deepseek-v4-flash") -> dict:
    """基于已生成的阶段总结，分析阶段间的内容流转关系。"""
    graph = load_graph(graph_name)
    if not graph:
        raise ValueError(f"图谱不存在: {graph_name}")

    phases = graph.get("phases") or []
    if not phases:
        raise ValueError("还没有阶段划分，请先执行阶段划分")

    # 展平所有节点（含子层），但只取有 summary 的
    flat = flatten_phases(phases)
    nodes_for_prompt = [n for n in flat if (n.get("summary") or "").strip()]
    if len(nodes_for_prompt) < 2:
        raise ValueError("至少需要 2 个有总结的阶段才能分析流程")

    lines = []
    for n in nodes_for_prompt:
        outputs = "，".join(n.get("outputs") or [])
        findings = "；".join(n.get("key_findings") or [])
        lines.append(
            f"- id={n['id']} | 名称={n.get('_full_path') or n['name']} | "
            f"目标={n.get('objective','')} | 产出={outputs} | 发现={findings} | "
            f"总结={(n.get('summary') or '')[:200]}"
        )

    prompt = FLOW_PROMPT.format(phases="\n".join(lines))
    resp = chat(
        prompt,
        system="你是项目流程分析专家，擅长从内容总结中识别逻辑依赖。",
        model=model,
        json_mode=True,
        max_tokens=2500,
        temperature=0.2,
        thinking="disabled",
    )
    data = resp.get("data") or {}
    valid_ids = {n["id"] for n in nodes_for_prompt}
    nodes = [n for n in (data.get("nodes") or []) if n.get("id") in valid_ids]
    edges = [
        e for e in (data.get("edges") or [])
        if e.get("from") in valid_ids and e.get("to") in valid_ids and e.get("from") != e.get("to")
    ]

    flow = {
        "nodes": nodes,
        "edges": edges,
        "insight": (data.get("insight") or "").strip()[:200],
        "generated_at": int(__import__("time").time()),
    }

    # 写回 graph
    graph["phase_flow"] = flow
    path = DATA_DIR / f"{graph_name}.json"
    path.write_text(json.dumps(graph, ensure_ascii=False, indent=2), encoding="utf-8")

    return {**flow, "tokens": resp.get("tokens", {}).get("total", 0)}
