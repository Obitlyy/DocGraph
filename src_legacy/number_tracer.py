"""LLM 数字溯源：判断同一数字在不同文档里是否真的是"同一回事"，找出源头。

设计目标：
- Token 控制：单次调用只发"数字 + 上下文片段"，不发全文
- 速度：批量打包多个候选，一次调用判断
- 默认关思考模式（DeepSeek v4 flash 非思考模式更快更便宜）
"""
from src.llm_client import chat, DEFAULT_MODEL


TRACE_PROMPT = """你是一个数据溯源专家。

用户在多份文档里搜到了同一个数字 `{query}`。下面列出了所有命中位置（按文档时间从早到晚）：

{candidates}

请判断：
1. 哪些位置指代的**真的是同一个事实/同一个数字**？（不是巧合的同形数字）
2. 哪个位置是**源头**？（最早提出这个数字的文档）
3. 数字流转路径：源头 → 衍生引用？

输出 JSON（不要任何其他文字）：
{{
  "groups": [
    {{
      "topic": "这组数字描述的是什么（一句话）",
      "source_idx": 0,
      "member_indices": [0, 2, 3],
      "reasoning": "判断依据（一两句话）"
    }}
  ],
  "noise_indices": [1]
}}

说明：
- groups 是分组，每组代表"同一个事实"
- source_idx 是该组里最早/最权威的源头（用候选的 idx）
- member_indices 是这组里所有成员的 idx（含 source_idx）
- noise_indices 是数值相同但语义无关的（比如巧合）
"""


def format_candidates(hits: list[dict], max_ctx: int = 120) -> str:
    """把命中列表格式化成提示词里的候选。"""
    lines = []
    for i, h in enumerate(hits):
        ctx = h["context"][:max_ctx].replace("\n", " ")
        time_str = h.get("doc_time") or "未知"
        lines.append(
            f"[{i}] 文档: {h['doc_name']} | 时间: {time_str}\n"
            f"    出现: {h['raw']}\n"
            f"    上下文: ...{ctx}..."
        )
    return "\n\n".join(lines)


def trace_number(
    query: str,
    hits: list[dict],
    model: str = None,
    max_candidates: int = 15,
) -> dict:
    """调用 LLM 判断同源关系。"""
    if not hits:
        return {"groups": [], "noise_indices": [], "tokens_used": None, "model": model or DEFAULT_MODEL}

    if len(hits) > max_candidates:
        step = len(hits) // max_candidates
        hits_use = hits[::max(1, step)][:max_candidates]
    else:
        hits_use = hits

    candidates_text = format_candidates(hits_use)
    prompt = TRACE_PROMPT.format(query=query, candidates=candidates_text)

    resp = chat(
        prompt,
        system="你是严谨的数据分析师，只输出 JSON。",
        model=model,
        json_mode=True,
        max_tokens=2000,
    )

    if resp.get("error"):
        return {
            "error": resp["error"],
            "raw": resp["content"],
            "groups": [],
            "noise_indices": [],
            "model": resp["model"],
            "tokens_used": resp["tokens"],
        }

    result = resp["data"] or {}
    # 把 indices 还原到原始 hits 的引用
    for g in result.get("groups", []):
        g["members"] = [hits_use[i] for i in g.get("member_indices", []) if 0 <= i < len(hits_use)]
        sidx = g.get("source_idx")
        if sidx is not None and 0 <= sidx < len(hits_use):
            g["source"] = hits_use[sidx]

    result["noise"] = [hits_use[i] for i in result.get("noise_indices", []) if 0 <= i < len(hits_use)]
    result["tokens_used"] = resp["tokens"]
    result["model"] = resp["model"]
    result["candidates_sent"] = len(hits_use)
    result["candidates_total"] = len(hits)

    return result
