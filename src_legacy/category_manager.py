"""分类体系自适应生成 + 手动编辑功能

解决问题：LLM 逐篇分析时分类过多、不一致
方案：两阶段自适应 + 人工兜底
"""
import json
from pathlib import Path
from typing import Optional

from src.llm_client import chat
from src.storage import load_graph, write_doc_meta, DATA_DIR


# ============ 阶段1：生成分类体系 ============
TAXONOMY_SYSTEM = "你是文档分类体系设计专家。根据文件列表设计一套分类体系，输出严格 JSON。"

TAXONOMY_PROMPT = """以下是一个项目中的所有文档（共 {doc_count} 篇）。
请设计一套分类体系，让每篇文档都能被归入其中一个类别。

文档列表：
{doc_list}

要求：
- 分类数量建议 {min_cats}-{max_cats} 个（你可以根据实际情况浮动 ±2）
- 每个分类用 6-10 字描述文档的功能角色
- 每个分类至少应该有 2 篇文档能归入
- 避免过于细分（如"Wesley采访纪要"和"Ahri采访纪要"应属同一分类"采访纪要"）
- 避免过于宽泛（如不要所有文档都叫"项目资料"）

输出 JSON：
{{
  "categories": [
    {{
      "name": "分类名称",
      "description": "简要说明什么样的文档属于这一类",
      "expected_docs": ["预期归入的文档名（2-3个示例）"]
    }}
  ],
  "reasoning": "简要说明你的分类逻辑"
}}
"""

# ============ 阶段2：校准分类数量 ============
ADJUST_SYSTEM = "你是文档分类专家。输出严格 JSON。"

ADJUST_MERGE_PROMPT = """当前分类体系有 {cat_count} 个类别，过多了（目标 {target} 个以内）。
请合并相似类别。

当前分类：
{categories}

输出合并后的分类体系 JSON：
{{
  "categories": [
    {{
      "name": "分类名称",
      "description": "简要说明",
      "merged_from": ["被合并的原分类名1", "原分类名2"]
    }}
  ]
}}

规则：
- 只合并真正语义相似的分类
- 合并后总数不超过 {target}
- 新名称要有概括性
"""

ADJUST_SPLIT_PROMPT = """当前分类体系只有 {cat_count} 个类别，过少了（建议至少 {target} 个）。
某些类别包含了太多不同功能的文档，需要拆分。

当前分类及包含的文档：
{categories}

请拆分过大的类别，输出新分类体系 JSON：
{{
  "categories": [
    {{
      "name": "分类名称",
      "description": "简要说明",
      "split_from": "原分类名（如果是拆分来的）"
    }}
  ]
}}
"""

# ============ 阶段3：使用分类体系给文档归类 ============
CLASSIFY_SYSTEM = "你是文档分类师。将文档归入指定的分类体系中。输出严格 JSON。"

CLASSIFY_PROMPT_FAST = """将以下文档归入分类体系。

可用分类：
{taxonomy}

文档名: {name}
内容（前{max_chars}字）:
{text}

返回 JSON：
{{
  "category": "选择上面列表中最匹配的分类名（必须精确使用列表中的名称）",
  "keywords": ["关键词1", "关键词2", "关键词3"],
  "summary": "一句话摘要（30字内）",
  "people": ["相关人名"],
  "phase": "阶段（研究计划/调研执行/数据分析/成果交付/未知）"
}}
"""

CLASSIFY_PROMPT_STANDARD = """将以下文档归入分类体系，并提取结构化信息。

可用分类：
{taxonomy}

文档名: {name}
文档内容（前 {max_chars} 字）:
{text}

返回 JSON：
{{
  "category": "选择上面列表中最匹配的分类名（必须精确使用列表中的名称）",
  "keywords": ["关键词1", "关键词2", "关键词3"],
  "summary": "一句话摘要（30字内）",
  "people": ["相关人名"],
  "phase": "阶段（研究计划/调研执行/数据分析/成果交付/未知）",
  "metrics": [{{"name": "指标名", "value": "数值", "unit": "单位", "context": "上下文（20字内）"}}],
  "timeline": [{{"date": "YYYY-MM-DD", "event": "事件（20字内）"}}],
  "entities": [{{"name": "名称", "type": "公司/产品/项目/其他"}}],
  "citations": [{{"source": "引用来源", "context": "描述（30字内）"}}]
}}

注意：category 必须从上面的可用分类中选取，不能自己发明新分类。
如果都不太匹配，选最接近的那个。
"""

CLASSIFY_PROMPT_DEEP = """将以下文档归入分类体系，并深度提取结构化信息。

可用分类：
{taxonomy}

文档名: {name}
文档内容（前 {max_chars} 字）:
{text}

返回 JSON：
{{
  "category": "选择上面列表中最匹配的分类名（必须精确使用列表中的名称）",
  "keywords": ["关键词1", "关键词2", ...最多5个],
  "summary": "深度摘要（50字内，包含核心观点和结论）",
  "people": ["相关人名（含可推断的）"],
  "phase": "阶段",
  "metrics": [{{"name": "指标名", "value": "数值", "unit": "单位", "context": "上下文含对比基准（40字内）"}}],
  "timeline": [{{"date": "YYYY-MM-DD", "event": "事件含因果（40字内）"}}],
  "entities": [{{"name": "名称", "type": "类型"}}],
  "citations": [{{"source": "来源", "context": "描述（50字内）"}}]
}}

注意：category 必须从可用分类中选取，不能自己发明。
"""


def generate_taxonomy(graph_name: str, model: str = None, mode: str = "standard") -> dict:
    """阶段1：根据文档列表，AI 自适应生成分类体系。
    
    Returns:
        {
            "categories": [{"name": str, "description": str, ...}],
            "tokens": int,
            "doc_count": int,
        }
    """
    from src.llm_analyzer import get_mode_config
    cfg = get_mode_config(mode)
    use_model = model or cfg["model"]

    graph = load_graph(graph_name)
    if not graph:
        raise ValueError(f"图谱不存在: {graph_name}")

    docs = graph["docs"]
    doc_count = len(docs)

    # 建议分类数范围
    min_cats = max(3, doc_count // 8)
    max_cats = max(5, doc_count // 4)
    # 合理范围限制
    min_cats = min(min_cats, 8)
    max_cats = min(max_cats, 15)

    # 构建文档列表（文件名 + 已有摘要）
    doc_lines = []
    for d in docs:
        line = f"- {d['name']}"
        if d.get("summary"):
            line += f" | 摘要: {d['summary'][:40]}"
        if d.get("people"):
            line += f" | 人物: {', '.join(d['people'][:3])}"
        doc_lines.append(line)

    prompt = TAXONOMY_PROMPT.format(
        doc_count=doc_count,
        doc_list="\n".join(doc_lines),
        min_cats=min_cats,
        max_cats=max_cats,
    )

    resp = chat(
        prompt,
        system=TAXONOMY_SYSTEM,
        model=use_model,
        json_mode=True,
        max_tokens=2000,
        temperature=0.2,
        thinking=cfg.get("thinking", "disabled"),
    )

    data = resp.get("data") or {}
    categories = data.get("categories", [])
    total_tokens = resp["tokens"]["total"]

    # 阶段2：校准数量
    cat_count = len(categories)
    target_max = max_cats
    target_min = min_cats

    if cat_count > target_max + 2:
        # 过多，让 AI 合并
        cat_lines = "\n".join(f"- {c['name']}: {c.get('description', '')}" for c in categories)
        merge_prompt = ADJUST_MERGE_PROMPT.format(
            cat_count=cat_count,
            target=target_max,
            categories=cat_lines,
        )
        merge_resp = chat(
            merge_prompt,
            system=ADJUST_SYSTEM,
            model=use_model,
            json_mode=True,
            max_tokens=1500,
            temperature=0.1,
            thinking=cfg.get("thinking", "disabled"),
        )
        merge_data = merge_resp.get("data") or {}
        if merge_data.get("categories"):
            categories = merge_data["categories"]
        total_tokens += merge_resp["tokens"]["total"]

    elif cat_count < target_min - 1:
        # 过少，让 AI 拆分
        cat_lines = "\n".join(f"- {c['name']}: {c.get('description', '')}" for c in categories)
        split_prompt = ADJUST_SPLIT_PROMPT.format(
            cat_count=cat_count,
            target=target_min,
            categories=cat_lines,
        )
        split_resp = chat(
            split_prompt,
            system=ADJUST_SYSTEM,
            model=use_model,
            json_mode=True,
            max_tokens=1500,
            temperature=0.2,
            thinking=cfg.get("thinking", "disabled"),
        )
        split_data = split_resp.get("data") or {}
        if split_data.get("categories"):
            categories = split_data["categories"]
        total_tokens += split_resp["tokens"]["total"]

    # 保存分类体系到图谱
    graph["taxonomy"] = {
        "categories": categories,
        "version": 1,
        "auto_generated": True,
    }
    path = DATA_DIR / f"{graph_name}.json"
    path.write_text(json.dumps(graph, ensure_ascii=False, indent=2), encoding="utf-8")

    return {
        "categories": categories,
        "tokens": total_tokens,
        "doc_count": doc_count,
        "cat_count": len(categories),
    }


def get_taxonomy(graph_name: str) -> Optional[list]:
    """获取图谱当前的分类体系，返回 category 列表或 None。"""
    graph = load_graph(graph_name)
    if not graph:
        return None
    taxonomy = graph.get("taxonomy")
    if not taxonomy:
        return None
    return taxonomy.get("categories", [])


def format_taxonomy_for_prompt(categories: list) -> str:
    """将分类体系格式化为 prompt 注入用的文本。"""
    lines = []
    for c in categories:
        name = c.get("name", "")
        desc = c.get("description", "")
        lines.append(f"- {name}: {desc}")
    return "\n".join(lines)


# ============ 手动分类操作 ============

def manual_set_category(graph_name: str, doc_id: str, new_category: str) -> str:
    """手动修改单篇文档的分类。"""
    graph = load_graph(graph_name)
    if not graph:
        raise ValueError(f"图谱不存在: {graph_name}")

    doc = next((d for d in graph["docs"] if d["id"] == doc_id), None)
    if not doc:
        raise ValueError(f"文档不存在: {doc_id}")

    old_cat = doc.get("category", "未分类")
    doc["category"] = new_category.strip()[:30]

    path = DATA_DIR / f"{graph_name}.json"
    path.write_text(json.dumps(graph, ensure_ascii=False, indent=2), encoding="utf-8")
    return f"已修改: [{old_cat}] → [{new_category}] ({doc['name']})"


def manual_merge_categories(graph_name: str, old_categories: list[str], new_name: str) -> str:
    """手动合并多个分类为一个新分类。"""
    graph = load_graph(graph_name)
    if not graph:
        raise ValueError(f"图谱不存在: {graph_name}")

    old_set = set(old_categories)
    merged_count = 0

    for d in graph["docs"]:
        if d.get("category") in old_set:
            d["category"] = new_name.strip()[:30]
            merged_count += 1

    # 同步更新 taxonomy
    taxonomy = graph.get("taxonomy")
    if taxonomy and taxonomy.get("categories"):
        new_cats = [c for c in taxonomy["categories"] if c.get("name") not in old_set]
        new_cats.append({
            "name": new_name,
            "description": f"合并自: {', '.join(old_categories)}",
            "merged_from": old_categories,
        })
        taxonomy["categories"] = new_cats

    path = DATA_DIR / f"{graph_name}.json"
    path.write_text(json.dumps(graph, ensure_ascii=False, indent=2), encoding="utf-8")
    return f"已合并 {len(old_categories)} 个分类为 [{new_name}]，影响 {merged_count} 篇文档"


def manual_rename_category(graph_name: str, old_name: str, new_name: str) -> str:
    """手动重命名一个分类。"""
    graph = load_graph(graph_name)
    if not graph:
        raise ValueError(f"图谱不存在: {graph_name}")

    renamed_count = 0
    for d in graph["docs"]:
        if d.get("category") == old_name:
            d["category"] = new_name.strip()[:30]
            renamed_count += 1

    # 同步更新 taxonomy
    taxonomy = graph.get("taxonomy")
    if taxonomy and taxonomy.get("categories"):
        for c in taxonomy["categories"]:
            if c.get("name") == old_name:
                c["name"] = new_name
                break

    path = DATA_DIR / f"{graph_name}.json"
    path.write_text(json.dumps(graph, ensure_ascii=False, indent=2), encoding="utf-8")
    return f"已重命名 [{old_name}] → [{new_name}]，影响 {renamed_count} 篇文档"


def manual_split_category(graph_name: str, old_name: str, splits: dict[str, list[str]]) -> str:
    """手动拆分一个分类。
    
    Args:
        splits: {new_category_name: [doc_id1, doc_id2, ...]}
    """
    graph = load_graph(graph_name)
    if not graph:
        raise ValueError(f"图谱不存在: {graph_name}")

    # 建 doc_id → new_cat 映射
    id_to_cat = {}
    for new_cat, doc_ids in splits.items():
        for did in doc_ids:
            id_to_cat[did] = new_cat.strip()[:30]

    split_count = 0
    for d in graph["docs"]:
        if d.get("category") == old_name and d["id"] in id_to_cat:
            d["category"] = id_to_cat[d["id"]]
            split_count += 1

    # 更新 taxonomy
    taxonomy = graph.get("taxonomy")
    if taxonomy and taxonomy.get("categories"):
        new_cats = [c for c in taxonomy["categories"] if c.get("name") != old_name]
        for new_cat_name in splits.keys():
            new_cats.append({
                "name": new_cat_name,
                "description": f"拆分自: {old_name}",
                "split_from": old_name,
            })
        # 如果有文档没被分配到任何新分类，保留原分类
        remaining = [d for d in graph["docs"] if d.get("category") == old_name]
        if remaining:
            new_cats.append({"name": old_name, "description": "拆分后剩余"})
        taxonomy["categories"] = new_cats

    path = DATA_DIR / f"{graph_name}.json"
    path.write_text(json.dumps(graph, ensure_ascii=False, indent=2), encoding="utf-8")
    return f"已拆分 [{old_name}] 为 {len(splits)} 个新分类，影响 {split_count} 篇文档"


def list_categories(graph_name: str) -> list[dict]:
    """列出当前所有分类及其包含的文档。"""
    graph = load_graph(graph_name)
    if not graph:
        raise ValueError(f"图谱不存在: {graph_name}")

    by_cat = {}
    for d in graph["docs"]:
        cat = d.get("category", "未分类")
        if cat not in by_cat:
            by_cat[cat] = []
        by_cat[cat].append({"id": d["id"], "name": d["name"]})

    result = []
    for cat, docs in sorted(by_cat.items(), key=lambda x: -len(x[1])):
        result.append({
            "category": cat,
            "count": len(docs),
            "docs": docs,
        })
    return result
