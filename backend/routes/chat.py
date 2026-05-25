"""超级搜索对话 API — LLM + Tool Use。"""
import json
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from src.storage import load_graph, list_graphs
from src.llm_client import chat_with_tools
from src.chat_tools import TOOLS, execute_tool

router = APIRouter(prefix="/api", tags=["chat"])

SYSTEM_PROMPT = """你是 DocGraph 文档助手。用户已经加载了多个文档图谱，你可以通过工具搜索和分析这些文档。

规则：
- 根据用户的问题，选择合适的工具来搜索文档
- 如果用户问的问题涉及数字（金额、百分比等），优先使用 search_numbers
- 如果用户想了解文档之间的关系，使用 find_related
- 给出简洁有用的回答，不要废话
- 引用文档时使用文档名称
- 回复使用中文
"""

MAX_TOOL_ROUNDS = 3  # 最多进行 3 轮工具调用


class ChatMessage(BaseModel):
    role: str  # user / assistant / system
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    mode: Optional[str] = None  # 可选提示 LLM 偏好哪种搜索


class ChatResponse(BaseModel):
    reply: str
    results: list[dict]  # [{id, title, preview, graphName, icon, docId}]
    tokens_used: int


@router.post("/chat")
def api_chat(req: ChatRequest):
    """对话式文档搜索。LLM 通过 Function Calling 调用搜索工具。"""

    # 加载所有图谱数据
    graph_names = list_graphs()
    graphs = []
    for name in graph_names:
        g = load_graph(name)
        if g:
            graphs.append(g)

    if not graphs:
        return ChatResponse(reply="暂无已加载的图谱数据。请先在「文档图谱」中创建图谱。", results=[], tokens_used=0)

    # 构建消息
    system_content = SYSTEM_PROMPT
    if req.mode and req.mode != 'all':
        mode_hints = {
            'keyword': '用户倾向于关键词搜索。',
            'number': '用户倾向于数字追踪。优先使用 search_numbers 工具。',
            'category': '用户倾向于按分类搜索。优先使用 search_by_category 工具。',
            'relation': '用户倾向于查找关联文档。优先使用 find_related 工具。',
            'phase': '用户倾向于按阶段搜索。优先使用 search_by_phase 工具。',
        }
        system_content += f"\n\n提示：{mode_hints.get(req.mode, '')}"

    # 添加图谱上下文
    graph_summary = "、".join(f"「{g['name']}」({len(g.get('docs', []))}篇)" for g in graphs[:10])
    system_content += f"\n\n当前已加载的图谱：{graph_summary}"

    messages = [{"role": "system", "content": system_content}]
    for msg in req.messages:
        messages.append({"role": msg.role, "content": msg.content})

    # Tool Use 循环
    total_tokens = 0
    collected_results = []

    for _ in range(MAX_TOOL_ROUNDS):
        resp = chat_with_tools(
            messages=messages,
            tools=TOOLS,
            temperature=0.3,
            max_tokens=2000,
        )
        total_tokens += resp["tokens"].get("total", 0)

        tool_calls = resp["tool_calls"]

        # 没有工具调用 → LLM 直接回复，结束
        if not tool_calls:
            break

        # 有工具调用 → 执行工具，把结果加入消息
        # 先把 assistant 的 tool_calls 消息加入
        messages.append(resp["message"])

        for tc in tool_calls:
            tool_result = execute_tool(tc["name"], tc["arguments"], graphs)

            # 收集结果用于前端展示
            _collect_results(tc["name"], tool_result, collected_results)

            # 把工具结果作为 tool 消息加入
            messages.append({
                "role": "tool",
                "tool_call_id": tc["id"],
                "content": tool_result,
            })

    # 最终回复（如果最后一次有 content 就用，否则再调一次）
    final_reply = resp.get("content", "")
    if not final_reply and tool_calls:
        # 工具执行完后让 LLM 总结
        final_resp = chat_with_tools(
            messages=messages,
            tools=TOOLS,
            tool_choice="none",  # 强制不调用工具，只生成回复
            temperature=0.3,
            max_tokens=2000,
        )
        final_reply = final_resp.get("content", "")
        total_tokens += final_resp["tokens"].get("total", 0)

    return {
        "reply": final_reply,
        "results": collected_results[:20],
        "tokens_used": total_tokens,
    }


def _collect_results(tool_name: str, tool_result_str: str, collected: list):
    """从工具结果中提取文档条目，转为前端可展示的 ResultItem。"""
    try:
        data = json.loads(tool_result_str)
    except json.JSONDecodeError:
        return

    icon_map = {
        "search_docs": "📄",
        "search_numbers": "🔢",
        "find_related": "🔗",
        "search_by_category": "🏷️",
        "search_by_phase": "📊",
        "get_doc_detail": "📋",
    }
    icon = icon_map.get(tool_name, "📄")

    # 处理各种工具返回格式
    results = data.get("results", [])
    related = data.get("related", [])

    for item in results:
        collected.append({
            "id": f"{item.get('graph', '')}:{item.get('id') or item.get('doc_id', '')}",
            "docId": item.get("id") or item.get("doc_id", ""),
            "title": item.get("name") or item.get("doc_name", ""),
            "preview": item.get("summary") or item.get("context") or item.get("category") or "",
            "graphName": item.get("graph", ""),
            "icon": icon,
        })

    for item in related:
        collected.append({
            "id": f"{data.get('graph', '')}:{item.get('doc_id', '')}",
            "docId": item.get("doc_id", ""),
            "title": item.get("name", ""),
            "preview": f"关联: {', '.join(item.get('reasons', []))}",
            "graphName": data.get("graph", ""),
            "icon": "🔗",
        })

    # get_doc_detail 单条
    if tool_name == "get_doc_detail" and "name" in data and "error" not in data:
        collected.append({
            "id": f"{data.get('graph', '')}:{data.get('id', '')}",
            "docId": data.get("id", ""),
            "title": data.get("name", ""),
            "preview": data.get("summary", ""),
            "graphName": data.get("graph", ""),
            "icon": "📋",
        })
