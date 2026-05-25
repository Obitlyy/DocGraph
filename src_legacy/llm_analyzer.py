"""LLM 自动分析模块:直接调 DeepSeek API 完成

1. 文档分类 + 关键词 + 摘要(每个文档独立一次调用,可批量并发)
2. 关系推断(两阶段:先识别一对一关系,再识别项目/批次群组)

分析模式:
- fast: 快速分析,最低成本,适合初步浏览
- standard: 中度分析,平衡效率与质量(默认)
- deep: 深度分析,使用强模型+思考,最高质量
"""
import json
import time
import re
import concurrent.futures
from pathlib import Path
from typing import Callable, Optional

from src.llm_client import chat, DEFAULT_MODEL
from src.scanner import extract_text
from src.storage import load_graph, write_doc_meta, write_relations, RELATION_TYPES


# ============ 分析模式配置 ============
ANALYSIS_MODES = {
    "fast": {
        "model": "deepseek-v4-flash",
        "thinking": "disabled",
        "max_chars": 6000,
        "max_tokens_meta": 800,
        "max_tokens_pair": 3000,
        "max_tokens_group": 2000,
        "temperature": 0.3,
        "max_workers": 8,
        "chunk_size": 60,
    },
    "standard": {
        "model": "deepseek-v4-flash",
        "thinking": "disabled",
        "max_chars": 15000,
        "max_tokens_meta": 1500,
        "max_tokens_pair": 6000,
        "max_tokens_group": 4000,
        "temperature": 0.2,
        "max_workers": 5,
        "chunk_size": 50,
    },
    "deep": {
        "model": "deepseek-reasoner",
        "thinking": "enabled",
        "max_chars": 50000,
        "max_tokens_meta": 4000,
        "max_tokens_pair": 16000,
        "max_tokens_group": 8000,
        "temperature": 0.1,
        "max_workers": 3,
        "chunk_size": 40,
    },
}


def get_mode_config(mode: str = "standard") -> dict:
    """Get analysis mode configuration, fallback to standard."""
    return ANALYSIS_MODES.get(mode, ANALYSIS_MODES["standard"])


# ============ 文档分类提示词(分模式)============
META_SYSTEM = "你是文档分析师,输出严格 JSON,不要任何解释。"

# 快速模式 prompt（精简字段，降低 token）
META_PROMPT_FAST = """分析文档，返回 JSON：
{{
  "category": "分类（6-10字，表示文档在项目中的角色）",
  "keywords": ["关键词1", "关键词2", "关键词3"],
  "summary": "一句话摘要（30字内）",
  "people": ["相关人名"],
  "phase": "阶段（研究计划/调研执行/数据分析/成果交付/未知）"
}}
分类原则：
- 体现文档的功能角色，用高层次、可复用的名称
- 同一功能的文档必须复用同一分类名
- 避免过度细分：相似功能合并为一类
文档名: {name}
内容（前{max_chars}字）:
{text}
"""

# 标准模式 prompt（完整字段）
META_PROMPT_STANDARD = """请分析以下文档，返回 JSON：
{{
  "category": "分类（6-10字，表示文档在项目中的角色）",
  "keywords": ["关键词1", "关键词2", "关键词3"],
  "summary": "一句话摘要（30字内）",
  "people": ["相关人名"],
  "phase": "阶段（研究计划/调研执行/数据分析/成果交付/未知）",
  "metrics": [{{"name": "指标名", "value": "数值", "unit": "单位", "context": "上下文（20字内）"}}],
  "timeline": [{{"date": "YYYY-MM-DD", "event": "事件（20字内）"}}],
  "entities": [{{"name": "名称", "type": "公司/产品/项目/其他"}}],
  "citations": [{{"source": "引用来源", "context": "描述（30字内）"}}]
}}

分类原则：
- category 体现文档的功能角色，用高层次、可复用的名称
- 同一功能的文档必须复用同一分类名（如“调研提纲”“访谈问题库”“访谈指南”同属一类）
- 避免过度细分：相似功能合并为一类

文档名: {name}
文档内容（前 {max_chars} 字）:
{text}

提取要求：
- keywords: 3-5个核心概念（避免空泛词）
- summary: 一句说清文档是什么、起什么作用
- people: 真实人名，最多5个
- metrics: 关键业务指标，不超过8个
- timeline: 关键时间点，不超过5个
- entities: 公司/产品/项目名，不超过8个
- citations: 明确引用来源，没有就返回[]
- 某项不适用则返回空数组
"""

# 深度模式 prompt
META_PROMPT_DEEP = """请深度分析以下文档，返回 JSON：
{{
  "category": "分类（6-10字，表示文档在项目中的角色）",
  "keywords": ["关键词1", "关键词2", ...最多5个],
  "summary": "深度摘要（50字内，包含核心观点和结论）",
  "people": ["相关人名（含可推断的）"],
  "phase": "阶段",
  "metrics": [{{"name": "指标名", "value": "数值", "unit": "单位", "context": "上下文含对比基准（40字内）"}}],
  "timeline": [{{"date": "YYYY-MM-DD", "event": "事件含因果（40字内）"}}],
  "entities": [{{"name": "名称", "type": "类型"}}],
  "citations": [{{"source": "来源", "context": "描述（50字内）"}}]
}}

分类原则：
- category 体现文档在项目中的功能角色
- 使用高层次、可复用的名称，同一功能复用同一名称
- 避免过度细分，同项目下应该多个文档共享同一分类

文档名: {name}
文档内容（前 {max_chars} 字）:
{text}

深度分析要求：
- 仔细思考后再输出，识别隐含因果关系和逻辑链条
- keywords: 5个最具区分度的概念
- summary: 包含核心观点、结论和与其他文档的关系
- people: 含可推断的人物
- metrics: 含计算公式、对比基准，最多12个
- timeline: 捕获隐含里程碑，最多8个
- entities: 包含上下游关系，最多12个
- citations: 含引用的网址、文档名、会议记录等
"""


def analyze_one_doc(doc: dict, model: str = None, max_chars: int = 3000, mode: str = "standard", taxonomy: list = None) -> dict:
    """分析单个文档。如果提供了 taxonomy，则从中选择分类；否则自由分类。"""
    cfg = get_mode_config(mode)
    use_model = model or cfg["model"]
    use_max_chars = max_chars if model else cfg["max_chars"]
    use_max_tokens = cfg["max_tokens_meta"]
    use_temp = cfg["temperature"]
    use_thinking = cfg["thinking"]

    text = doc.get("text") or ""
    if not text and doc.get("abs_path"):
        text = extract_text(Path(doc["abs_path"]))
    text = text[:use_max_chars]

    if not text.strip():
        return {
            "id": doc["id"],
            "category": "空文档",
            "keywords": [],
            "summary": "(无内容)",
            "people": [],
            "phase": "未知",
            "tokens": 0,
        }

    # 如果有分类体系，使用约束型 prompt
    if taxonomy:
        from src.category_manager import format_taxonomy_for_prompt, CLASSIFY_PROMPT_FAST, CLASSIFY_PROMPT_STANDARD, CLASSIFY_PROMPT_DEEP, CLASSIFY_SYSTEM
        taxonomy_text = format_taxonomy_for_prompt(taxonomy)
        if mode == "fast":
            prompt_tpl = CLASSIFY_PROMPT_FAST
        elif mode == "deep":
            prompt_tpl = CLASSIFY_PROMPT_DEEP
        else:
            prompt_tpl = CLASSIFY_PROMPT_STANDARD
        prompt = prompt_tpl.format(name=doc["name"], max_chars=use_max_chars, text=text, taxonomy=taxonomy_text)
        system = CLASSIFY_SYSTEM
    else:
        # 无分类体系时使用原有自由分类 prompt
        if mode == "fast":
            prompt_tpl = META_PROMPT_FAST
        elif mode == "deep":
            prompt_tpl = META_PROMPT_DEEP
        else:
            prompt_tpl = META_PROMPT_STANDARD
        prompt = prompt_tpl.format(name=doc["name"], max_chars=use_max_chars, text=text)
        system = META_SYSTEM

    resp = chat(
        prompt,
        system=system,
        model=use_model,
        json_mode=True,
        max_tokens=use_max_tokens,
        temperature=use_temp,
        thinking=use_thinking,
    )
    data = resp.get("data") or {}

    # 如果有分类体系，校验返回的 category 是否在体系内
    if taxonomy:
        valid_names = {c["name"] for c in taxonomy}
        returned_cat = str(data.get("category", "")).strip()
        if returned_cat not in valid_names:
            # 模糊匹配：找最相似的
            best = None
            best_score = 0
            for vn in valid_names:
                # 简单字符重叠度
                overlap = len(set(returned_cat) & set(vn)) / max(len(set(returned_cat) | set(vn)), 1)
                if overlap > best_score:
                    best_score = overlap
                    best = vn
            if best and best_score > 0.3:
                data["category"] = best
            # 否则保留原值（后续可手动修正）

    # 清洗结构化字段
    def _clean_metrics(items):
        cleaned = []
        for m in (items or [])[:8]:
            if not isinstance(m, dict):
                continue
            name = str(m.get("name", ""))[:30].strip()
            value = str(m.get("value", ""))[:20].strip()
            if not name or not value:
                continue
            cleaned.append({
                "name": name,
                "value": value,
                "unit": str(m.get("unit", ""))[:10],
                "context": str(m.get("context", ""))[:100],
            })
        return cleaned

    def _clean_timeline(items):
        cleaned = []
        for t in (items or [])[:5]:
            if not isinstance(t, dict):
                continue
            date = str(t.get("date", ""))[:20].strip()
            event = str(t.get("event", ""))[:100].strip()
            if date and event:
                cleaned.append({"date": date, "event": event})
        return cleaned

    def _clean_entities(items):
        cleaned = []
        seen = set()
        for e in (items or [])[:8]:
            if not isinstance(e, dict):
                continue
            name = str(e.get("name", ""))[:30].strip()
            etype = str(e.get("type", "其他"))[:10].strip()
            if not name or name in seen:
                continue
            seen.add(name)
            cleaned.append({"name": name, "type": etype})
        return cleaned

    def _clean_citations(items):
        cleaned = []
        for c in (items or [])[:5]:
            if not isinstance(c, dict):
                continue
            src = str(c.get("source", ""))[:100].strip()
            ctx = str(c.get("context", ""))[:150].strip()
            if src:
                cleaned.append({"source": src, "context": ctx})
        return cleaned

    return {
        "id": doc["id"],
        "category": str(data.get("category", "未分类"))[:30],
        "keywords": [str(k)[:20] for k in (data.get("keywords") or [])][:5],
        "summary": str(data.get("summary", ""))[:200],
        "people": [str(p)[:30] for p in (data.get("people") or [])][:5],
        "phase": str(data.get("phase", "未知"))[:20],
        "metrics": _clean_metrics(data.get("metrics")),
        "timeline": _clean_timeline(data.get("timeline")),
        "entities": _clean_entities(data.get("entities")),
        "citations": _clean_citations(data.get("citations")),
        "tokens": resp["tokens"]["total"],
    }


# ============ 分类归并 ============
MERGE_SYSTEM = "你是文档分类专家。输出严格 JSON。"

MERGE_PROMPT = """以下是一批文档的分类结果，分类数过多（{cat_count}个），需要合并至 {target}个以内。

当前分类（名称 → 文档数）：
{categories}

请将相似/重叠的分类合并，输出 JSON 映射（旧名称 → 新名称）：
{{
  "旧分类名1": "新分类名",
  "旧分类名2": "新分类名",
  ...
}}

规则：
- 每个旧分类都必须出现在映射中
- 如果某个旧分类不需要改，保持旧名称 → 旧名称
- 新名称要概括性强，6-10字
- 合并后总分类数不超过 {target}
- 只合并真正相似的，不要强行合并不相关的分类
"""


def _merge_categories(categories: dict, target_max: int, model: str, cfg: dict) -> dict:
    """调用 AI 合并过多的分类，返回 {old_name: new_name} 映射。"""
    cat_lines = "\n".join(f"- {name} ({count}篇)" for name, count in sorted(categories.items(), key=lambda x: -x[1]))
    prompt = MERGE_PROMPT.format(
        cat_count=len(categories),
        target=target_max,
        categories=cat_lines,
    )
    resp = chat(
        prompt,
        system=MERGE_SYSTEM,
        model=model,
        json_mode=True,
        max_tokens=2000,
        temperature=0.1,
        thinking=cfg.get("thinking", "disabled"),
    )
    data = resp.get("data")
    if not data or not isinstance(data, dict):
        return None
    # 添加 token 统计
    data["_tokens"] = resp["tokens"]["total"]
    return data


def analyze_all_docs(
    graph_name: str,
    model: str = None,
    mode: str = "standard",
    max_workers: int = None,
    progress_cb: Optional[Callable[[int, int, str], None]] = None,
    skip_taxonomy: bool = False,
    only_doc_ids: Optional[list[str]] = None,
) -> dict:
    """分析文档。
    
    新流程（默认）：
    1. 先生成/加载分类体系
    2. 在分类体系约束下逐篇分析
    3. 校验分类结果
    
    Args:
        skip_taxonomy: 跳过分类体系生成，使用自由分类（兼容旧行为）
        only_doc_ids: 仅分析指定 id 的文档（增量更新用）。None 表示分析全部。
            该参数不会触发分类体系重生成。
    """
    from src.category_manager import generate_taxonomy, get_taxonomy

    cfg = get_mode_config(mode)
    workers = max_workers or cfg["max_workers"]

    graph = load_graph(graph_name)
    if not graph:
        raise ValueError(f"图谱不存在: {graph_name}")

    # === 阶段1：生成或加载分类体系 ===
    taxonomy = None
    taxonomy_tokens = 0
    if not skip_taxonomy:
        # 检查是否已有分类体系
        existing_taxonomy = get_taxonomy(graph_name)
        if existing_taxonomy:
            taxonomy = existing_taxonomy
            if progress_cb:
                progress_cb(0, len(graph["docs"]), "✅ 使用已有分类体系")
        else:
            # 生成新的分类体系
            if progress_cb:
                progress_cb(0, len(graph["docs"]), "📊 正在生成分类体系...")
            tax_result = generate_taxonomy(graph_name, model=model, mode=mode)
            taxonomy = tax_result["categories"]
            taxonomy_tokens = tax_result["tokens"]

    # === 阶段2：逐篇分析 ===
    # 增量模式：只拿指定子集
    target_docs = graph["docs"]
    if only_doc_ids is not None:
        wanted = set(only_doc_ids)
        target_docs = [d for d in graph["docs"] if d["id"] in wanted]
        if not target_docs:
            return {
                "doc_count": 0,
                "total_tokens": taxonomy_tokens,
                "results": [],
                "category_count": 0,
                "categories": [],
                "taxonomy_used": taxonomy is not None,
            }

    docs_full = []
    for d in target_docs:
        text = ""
        if d.get("abs_path") and Path(d["abs_path"]).exists():
            text = extract_text(Path(d["abs_path"]))
        docs_full.append({**d, "text": text})

    total = len(docs_full)
    results = []
    total_tokens = taxonomy_tokens
    done = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(analyze_one_doc, d, model, cfg["max_chars"], mode, taxonomy): d for d in docs_full}
        for fut in concurrent.futures.as_completed(futures):
            d = futures[fut]
            try:
                meta = fut.result()
                results.append(meta)
                total_tokens += meta.get("tokens", 0)
            except Exception as e:
                results.append({
                    "id": d["id"], "category": "解析失败",
                    "keywords": [], "summary": str(e)[:100],
                    "people": [], "phase": "未知"
                })
            done += 1
            if progress_cb:
                progress_cb(done, total, d["name"])

    write_doc_meta(graph_name, results)

    # === 阶段3：校验分类结果 ===
    categories = {}
    for r in results:
        c = r.get("category", "未分类")
        categories[c] = categories.get(c, 0) + 1
    
    doc_count = len(results)
    target_max = max(4, min(10, (doc_count + 4) // 5))
    
    # 如果分类体系约束后仍然过多，进行合并（仅全量分析时触发）
    if only_doc_ids is None and len(categories) > target_max and not taxonomy:
        merge_result = _merge_categories(categories, target_max, model or cfg["model"], cfg)
        if merge_result:
            for r in results:
                old_cat = r.get("category", "")
                if old_cat in merge_result:
                    r["category"] = merge_result[old_cat]
            write_doc_meta(graph_name, results)
            total_tokens += merge_result.get("_tokens", 0)

    final_categories = set(r.get("category", "") for r in results)
    return {
        "doc_count": total,
        "total_tokens": total_tokens,
        "results": results,
        "category_count": len(final_categories),
        "categories": list(final_categories),
        "taxonomy_used": taxonomy is not None,
        "partial": only_doc_ids is not None,
    }


# ============ 第一阶段:一对一关系 ============
PAIR_SYSTEM = "你是文档关系分析专家。结合文件名、时间、分类、摘要、人物、阶段,识别明确的一对一关系。"

PAIR_PROMPT_TEMPLATE = """分析下列文档,识别**一对一关系**。

可用关系类型（只能用这些）:
{relation_types}

文档列表:
{{docs}}

输出 JSON:
{{{{
  "relations": [
    {{{{
      "from": "doc_id_A",
      "to": "doc_id_B",
      "type": "类型（必须在上述可用类型中）",
      "confidence": 0.85,
      "reason": "判断理由（一句话）"
    }}}}
  ]
}}}}

要求:
- **完整覆盖**：每个文档都尝试找它的关系，不要漏
- **严格使用上述类型列表**，不要发明新类型
- 单向关系注意 from→to 方向（旧版本：早→晚；衍生：源→派生）
- confidence >=0.6 才输出
- 不要输出 from==to 的自环
- 同一对文档只出最强的那条
"""

# 向后兼容：老代码如果还在用 PAIR_PROMPT，默认为 general schema
from src.relation_schemas import format_relations_for_prompt
PAIR_PROMPT = PAIR_PROMPT_TEMPLATE.format(relation_types=format_relations_for_prompt("general"))



# ============ 第二阶段:群组关系 ============
GROUP_SYSTEM = "你是文档关系分析专家,专门识别『同一项目』『同一批次』这类群组关系。"

GROUP_PROMPT = """识别下列文档中的**同一批次**关系。

同一批次的严格定义:
- 同一次采集/采访产生的多个文档(如对同一个人的采访转写 + 纪要 + 问题表 + 记录表)
- 同一批数据处理产生的多个文档(如同期准备的几份名单)

⛔ 不要输出以下情况:
- 跨不同人物的采访文档 不是同一批次(Wesley 和 Luffy 的采访不是同一批)
- 仅因"都是采访"、"都是数据" 不足以构成同一批次
- "同一项目"不要输出(整个图谱默认就是同一项目,这里不需要重复标记)

文档列表:
{docs}

🔑 提示:
- 对同一个人名(如 Wesley)的多个文档(采访转写 + 纪要 + 问题表 + 记录表) → 同一批次
- 多个文档同期产生且主题重叠 → 可能同一批次

输出 JSON(只输出同一批次):
{{
  "groups": [
    {{
      "type": "同一批次",
      "doc_ids": ["id1", "id2", "id3"],
      "topic": "描述这个组的主题(如:Wesley 采访系列文档)"
    }}
  ]
}}

要求:
- 群组里至少 2 个文档才有意义
- 一个同一批次组不应超过 6 个文档(超过说明粒度太粗)
- 只输出**确定的**同一批次,模棱两可的不要
- 不要输出同一项目类型
"""


def format_docs_v2(docs: list[dict], include_path: bool = True) -> str:
    """更详细的文档格式化(带人名、阶段、文件夹)。"""
    from src.number_extractor import estimate_doc_time
    lines = []
    for d in docs:
        category = d.get("category") or "未分类"
        summary = (d.get("summary") or "")[:80]
        kws = ", ".join(d.get("keywords") or [])
        people = ", ".join(d.get("people") or [])
        phase = d.get("phase") or "未知"
        t = estimate_doc_time(d)
        time_str = t.get("best_iso") or "未知"
        rel_path = d.get("rel_path", "")
        folder = "/".join(rel_path.split("/")[:-1]) if "/" in rel_path else ""

        parts = [
            f'id={d["id"]}',
            f'文件名={d["name"]}',
            f'时间={time_str}',
        ]
        if folder and include_path:
            parts.append(f'目录={folder}')
        parts.extend([
            f'分类={category}',
            f'阶段={phase}',
        ])
        if people:
            parts.append(f'人物=[{people}]')
        if kws:
            parts.append(f'关键词=[{kws}]')
        if summary:
            parts.append(f'摘要={summary}')
        lines.append('- ' + ' | '.join(parts))
    return "\n".join(lines)


def _dedup_relations(relations: list[dict], valid_ids: set, valid_types: set, directional: set) -> list[dict]:
    """清洗 + 去重:自环过滤、双向去重、有效 id 校验。"""
    seen = set()
    cleaned = []
    for r in relations:
        if not isinstance(r, dict):
            continue
        f, t, ty = r.get("from"), r.get("to"), r.get("type")
        if f not in valid_ids or t not in valid_ids:
            continue
        if f == t:
            continue
        if ty not in valid_types:
            continue
        if ty in directional:
            key = (f, t, ty)
        else:
            key = (frozenset([f, t]), ty)
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(r)
    return cleaned


def analyze_relations(
    graph_name: str,
    model: str = None,
    mode: str = "standard",
    chunk_size: int = None,
    use_thinking: bool = None,
) -> dict:
    """两阶段关系推断。支持 fast/standard/deep 模式。"""
    cfg = get_mode_config(mode)
    use_model = model or cfg["model"]
    chunk = chunk_size or cfg["chunk_size"]
    thinking = cfg["thinking"] if use_thinking is None else ("enabled" if use_thinking else "disabled")
    temp = cfg["temperature"]

    graph = load_graph(graph_name)
    if not graph:
        raise ValueError(f"图谱不存在: {graph_name}")
    docs = graph["docs"]
    if not docs:
        return {"relations": [], "tokens": 0}

    # 根据图谱的 schema 动态生成关系类型列表和 prompt
    from src.relation_schemas import (
        format_relations_for_prompt, get_relation_types as _get_rt,
        get_directional as _get_dir,
    )
    schema_id = graph.get("schema") or "general"
    valid_types = set(_get_rt(schema_id))
    directional = _get_dir(schema_id)
    relation_types_text = format_relations_for_prompt(schema_id)
    pair_prompt_template = PAIR_PROMPT_TEMPLATE.format(relation_types=relation_types_text)

    valid_ids = {d["id"] for d in docs}
    total_tokens = 0

    # ===== 阶段1: 一对一关系 =====
    pair_relations = []
    chunks = [docs[i:i+chunk] for i in range(0, len(docs), chunk)]
    for ch in chunks:
        docs_text = format_docs_v2(ch)
        prompt = pair_prompt_template.format(docs=docs_text)
        resp = chat(
            prompt,
            system=PAIR_SYSTEM,
            model=use_model,
            json_mode=True,
            max_tokens=cfg["max_tokens_pair"],
            temperature=temp,
            thinking=thinking,
        )
        data = resp.get("data") or {}
        pair_relations.extend(data.get("relations", []))
        total_tokens += resp["tokens"]["total"]

    # ===== 阶段2: 群组关系（仅在 schema 含“同一批次”时执行）=====
    groups = []
    if "同一批次" in valid_types:
        docs_text = format_docs_v2(docs)
        prompt = GROUP_PROMPT.format(docs=docs_text)
        resp = chat(
            prompt,
            system=GROUP_SYSTEM,
            model=use_model,
            json_mode=True,
            max_tokens=cfg["max_tokens_group"],
            temperature=temp,
            thinking=thinking,
        )
        data = resp.get("data") or {}
        total_tokens += resp["tokens"]["total"]

        for g in data.get("groups", []):
            ids = [i for i in (g.get("doc_ids") or []) if i in valid_ids]
            if len(ids) < 2:
                continue
            if len(ids) > 8:
                continue
            gtype = g.get("type")
            if gtype != "同一批次":
                continue
            topic = (g.get("topic") or "")[:80]
            groups.append({
                "type": gtype,
                "doc_ids": sorted(ids),
                "topic": topic,
            })

    # 只对 pair 关系走去重、清洗
    cleaned = _dedup_relations(pair_relations, valid_ids, valid_types, directional)
    write_relations(graph_name, cleaned)
    # 同时写入 groups
    from src.storage import write_groups
    write_groups(graph_name, groups)

    return {
        "relations": cleaned,
        "tokens": total_tokens,
        "pair_count": len(cleaned),
        "group_count": len(groups),
        "groups": groups,
    }
