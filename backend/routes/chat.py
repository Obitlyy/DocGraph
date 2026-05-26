"""超级搜索对话 API — LLM + Tool Use。"""
import json
import re
from typing import Optional
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from src.storage import load_graph, list_graphs
from src.llm_client import chat_with_tools, chat_stream
from src.chat_tools import TOOLS, execute_tool

router = APIRouter(prefix="/api", tags=["chat"])

SYSTEM_PROMPT = """你是 DocGraph 文档助手。用户已经加载了多个文档图谱，你可以通过工具搜索和分析这些文档。

核心规则：
- 用户问问题时，你必须调用工具获取数据，然后直接给出答案
- 绝对不要说"让我查看"、"我来读取"之类的过渡语——直接调用工具，拿到结果后直接回答
- 典型流程：search_docs 找到文档 → read_doc_content 读取内容 → 直接输出答案和数据
- 一次回复中可以调用多个工具，不需要分步骤
- 回答必须包含具体数据（数字、比例、名称等），不要模糊回答
- 如果文档中找不到答案，明确说"文档中未找到相关数据"
- 引用数据时标注来源文档名
- 回复使用中文
"""

MAX_TOOL_ROUNDS = 5  # 最多进行 5 轮工具调用


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
    force_tool = False

    for round_idx in range(MAX_TOOL_ROUNDS):
        resp = chat_with_tools(
            messages=messages,
            tools=TOOLS,
            tool_choice="required" if force_tool else "auto",
            temperature=0.3,
            max_tokens=8000,
        )
        total_tokens += resp["tokens"].get("total", 0)
        force_tool = False

        tool_calls = resp["tool_calls"]
        content = resp.get("content", "")

        # 检测 DSML hallucinated tool calls
        if not tool_calls and "DSML" in content:
            content = _clean_dsml(content)
            if not content.strip():
                final_resp = chat_with_tools(
                    messages=messages,
                    tools=TOOLS,
                    tool_choice="none",
                    temperature=0.3,
                    max_tokens=8000,
                )
                content = final_resp.get("content", "")
                total_tokens += final_resp["tokens"].get("total", 0)
            break

        # 没有工具调用 → 检查是否是过渡语
        if not tool_calls:
            if round_idx < MAX_TOOL_ROUNDS - 1 and _is_transitional(content):
                # 过渡语：下一轮强制调工具
                messages.append({"role": "assistant", "content": content})
                messages.append({"role": "user", "content": "继续，直接调用工具。"})
                force_tool = True
                continue
            break

        # 有工具调用 → 执行工具，把结果加入消息
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

    # 最终回复 — 无论如何都强制做一次纯文本总结
    final_reply = _clean_dsml(resp.get("content", ""))

    # 如果回复为空、是过渡语、或者有工具结果需要总结 → 强制 LLM 输出最终答案
    if not final_reply.strip() or _is_transitional(final_reply) or collected_results:
        # 追加明确指令要求总结
        messages.append({"role": "user", "content": "根据以上工具返回的数据，直接回答我的问题。给出具体数字和结论，不要再调用工具。"})
        final_resp = chat_with_tools(
            messages=messages,
            tools=TOOLS,
            tool_choice="none",
            temperature=0.3,
            max_tokens=8000,
        )
        final_reply = _clean_dsml(final_resp.get("content", ""))
        total_tokens += final_resp["tokens"].get("total", 0)

    return {
        "reply": final_reply,
        "results": collected_results[:20],
        "tokens_used": total_tokens,
    }


@router.post("/chat/stream")
def api_chat_stream(req: ChatRequest):
    """流式对话。先执行工具获取数据，然后流式输出最终回答。

    SSE 格式：
    - data: {"type":"status","text":"搜索中..."} — 状态更新
    - data: {"type":"token","text":"..."} — 逐 token 输出
    - data: {"type":"results","data":[...]} — 搜索结果
    - data: {"type":"done"} — 完成
    """

    def generate():
        # 加载图谱
        graph_names = list_graphs()
        graphs = []
        for name in graph_names:
            g = load_graph(name)
            if g:
                graphs.append(g)

        if not graphs:
            yield f"data: {json.dumps({'type': 'token', 'text': '暂无已加载的图谱数据。'}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
            return

        # 构建消息
        system_content = SYSTEM_PROMPT
        if req.mode and req.mode != 'all':
            mode_hints = {
                'keyword': '用户倾向于关键词搜索。',
                'number': '用户倾向于数字追踪。优先使用 search_numbers 工具。',
                'category': '用户倾向于按分类搜索。',
                'relation': '用户倾向于查找关联文档。',
                'phase': '用户倾向于按阶段搜索。',
            }
            system_content += f"\n\n提示：{mode_hints.get(req.mode, '')}"

        graph_summary = "、".join(f"「{g['name']}」({len(g.get('docs', []))}篇)" for g in graphs[:10])
        system_content += f"\n\n当前已加载的图谱：{graph_summary}"

        messages = [{"role": "system", "content": system_content}]
        for msg in req.messages:
            messages.append({"role": msg.role, "content": msg.content})

        # Tool Use 阶段（非流式，快速执行）
        yield f"data: {json.dumps({'type': 'status', 'text': '正在分析问题...'}, ensure_ascii=False)}\n\n"

        collected_results = []
        force_tool = False

        for round_idx in range(MAX_TOOL_ROUNDS):
            resp = chat_with_tools(
                messages=messages,
                tools=TOOLS,
                tool_choice="required" if force_tool else "auto",
                temperature=0.3,
                max_tokens=8000,
            )
            force_tool = False
            tool_calls = resp["tool_calls"]
            content = resp.get("content", "")

            if not tool_calls and "DSML" in content:
                break

            if not tool_calls:
                if round_idx < MAX_TOOL_ROUNDS - 1 and _is_transitional(content):
                    messages.append({"role": "assistant", "content": content})
                    messages.append({"role": "user", "content": "继续，直接调用工具。"})
                    force_tool = True
                    continue
                break

            yield f"data: {json.dumps({'type': 'status', 'text': '正在查找文档...'}, ensure_ascii=False)}\n\n"

            messages.append(resp["message"])
            for tc in tool_calls:
                tool_result = execute_tool(tc["name"], tc["arguments"], graphs)
                _collect_results(tc["name"], tool_result, collected_results)
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": tool_result,
                })

        # 发送搜索结果
        if collected_results:
            yield f"data: {json.dumps({'type': 'results', 'data': collected_results[:20]}, ensure_ascii=False)}\n\n"

        # 流式生成最终回答
        yield f"data: {json.dumps({'type': 'status', 'text': '正在生成回答...'}, ensure_ascii=False)}\n\n"

        messages.append({"role": "user", "content": "根据以上工具返回的数据，直接回答我的问题。给出具体数字和结论，不要再调用工具。"})

        try:
            for token in chat_stream(messages=messages, temperature=0.3, max_tokens=8000):
                yield f"data: {json.dumps({'type': 'token', 'text': token}, ensure_ascii=False)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'token', 'text': f'[生成出错: {str(e)[:100]}]'}, ensure_ascii=False)}\n\n"

        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


def _clean_dsml(text: str) -> str:
    """清除 DeepSeek 模型可能输出的 DSML 格式 hallucinated tool calls。"""
    if "DSML" not in text:
        return text
    # 移除所有 DSML 标签块
    text = re.sub(r'<｜｜DSML｜｜[\s\S]*?(?:</｜｜DSML｜｜tool_calls>|$)', '', text)
    text = re.sub(r'<\|?\|?DSML\|?\|?[^>]*>[\s\S]*?(?:</[^>]*>|$)', '', text)
    return text.strip()


def _is_transitional(content: str) -> bool:
    """检测内容是否只是过渡语（模型在描述下一步而非给出答案）。"""
    if not content or len(content) > 200:
        return False
    transitional_patterns = [
        "让我", "我来", "我先", "让我来", "我需要",
        "找到了相关", "查看一下", "读取",
        "Let me", "I'll", "I need to",
    ]
    return any(p in content for p in transitional_patterns)


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
