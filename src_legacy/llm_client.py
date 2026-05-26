"""统一的 DeepSeek/OpenAI 兼容 LLM 客户端封装。

特性：
- 单例连接池复用（避免每次请求创建新 TCP 连接）
- 自动重试（429 限流、5xx 服务端错误、网络超时）
- 请求级超时配置
- 默认关闭思考模式（更快、更省 token）
- 支持 JSON 输出模式
- 自动注入 .env 配置
- 统一的 token 统计返回
"""
import os
import json
import time
import logging
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

# 支持 Electron 传入的 .env 路径
_env_path = os.environ.get("DOCGRAPH_ENV_PATH", str(Path(__file__).parent.parent / ".env"))
load_dotenv(_env_path)

logger = logging.getLogger(__name__)

DEFAULT_MODEL = os.getenv("LLM_MODEL", "deepseek-v4-flash")
DEFAULT_THINKING = os.getenv("LLM_THINKING", "disabled")  # disabled | enabled
DEFAULT_TIMEOUT = int(os.getenv("LLM_TIMEOUT", "180"))  # 秒

# 重试配置
MAX_RETRIES = 3
RETRY_BACKOFF = [2, 5, 10]  # 每次重试的等待秒数
RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}

# 单例客户端缓存
_client_cache: dict = {}


def get_client():
    """获取或复用 OpenAI 客户端实例（连接池）。"""
    from openai import OpenAI

    api_key = os.getenv("OPENAI_API_KEY")
    base_url = os.getenv("OPENAI_BASE_URL", "https://api.deepseek.com")
    if not api_key or api_key.startswith("sk-请") or len(api_key.strip()) < 5:
        raise RuntimeError("请先在设置中填写 DeepSeek API Key")

    # 用 key+url 作为缓存键，配置变化时自动创建新实例
    cache_key = f"{api_key}:{base_url}"
    if cache_key not in _client_cache:
        _client_cache[cache_key] = OpenAI(
            api_key=api_key,
            base_url=base_url,
            timeout=DEFAULT_TIMEOUT,
            max_retries=0,  # 我们自己管理重试逻辑
        )
    return _client_cache[cache_key]


def chat(
    prompt: str,
    *,
    system: str = "",
    model: Optional[str] = None,
    json_mode: bool = False,
    thinking: Optional[str] = None,
    temperature: float = 0.1,
    max_tokens: int = 4000,
    timeout: Optional[int] = None,
) -> dict:
    """发送一次对话请求（含自动重试）。

    返回:
        {
            "content": str,           # 模型输出（JSON 模式下可直接 json.loads）
            "data": dict | None,      # JSON 模式自动解析的对象
            "tokens": {prompt, completion, total},
            "model": str,
            "error": str | None,      # 仅当 JSON 解析失败时设置
        }
    """
    model = model or DEFAULT_MODEL
    thinking = thinking if thinking is not None else DEFAULT_THINKING

    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    extra_body = {"thinking": {"type": thinking}}
    kwargs = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "extra_body": extra_body,
    }
    # 思考模式下不支持 temperature
    if thinking == "disabled":
        kwargs["temperature"] = temperature
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}
    if timeout:
        kwargs["timeout"] = timeout

    client = get_client()

    # 带重试的请求
    last_error = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            t0 = time.time()
            resp = client.chat.completions.create(**kwargs)
            elapsed = time.time() - t0
            logger.debug(f"[LLM] {model} · {elapsed:.1f}s · attempt={attempt + 1}")
            break
        except Exception as e:
            last_error = e
            error_str = str(e)

            # 判断是否可重试
            is_retryable = False
            if "timeout" in error_str.lower() or "timed out" in error_str.lower():
                is_retryable = True
            elif hasattr(e, "status_code") and e.status_code in RETRYABLE_STATUS_CODES:
                is_retryable = True
            elif "rate_limit" in error_str.lower() or "429" in error_str:
                is_retryable = True
            elif any(f"{code}" in error_str for code in [500, 502, 503, 504]):
                is_retryable = True

            if is_retryable and attempt < MAX_RETRIES:
                wait = RETRY_BACKOFF[min(attempt, len(RETRY_BACKOFF) - 1)]
                logger.warning(f"[LLM] 重试 {attempt + 1}/{MAX_RETRIES} · 等待 {wait}s · 错误: {error_str[:100]}")
                time.sleep(wait)
                continue
            else:
                raise last_error

    content = (resp.choices[0].message.content or "").strip()

    # 清掉可能的 markdown 代码块（兼容 ```json / ```python / ```javascript 等任意语言标识）
    if content.startswith("```"):
        # 去掉开头的 ``` 行（含语言标识）和结尾的 ```
        lines = content.split("\n")
        # 第一行是 ```xxx，去掉
        lines = lines[1:]
        # 最后一行如果是 ```，去掉
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        content = "\n".join(lines).strip()

    # 安全获取 usage 信息
    tokens = {"prompt": 0, "completion": 0, "total": 0}
    if resp.usage:
        tokens = {
            "prompt": resp.usage.prompt_tokens or 0,
            "completion": resp.usage.completion_tokens or 0,
            "total": resp.usage.total_tokens or 0,
        }

    out = {
        "content": content,
        "data": None,
        "error": None,
        "model": model,
        "tokens": tokens,
    }
    if json_mode:
        try:
            out["data"] = json.loads(content)
        except json.JSONDecodeError as e:
            out["error"] = f"JSON 解析失败: {e}"
    return out


def chat_with_tools(
    messages: list[dict],
    tools: list[dict],
    *,
    model: Optional[str] = None,
    tool_choice: str = "auto",
    temperature: float = 0.1,
    max_tokens: int = 4000,
    timeout: Optional[int] = None,
) -> dict:
    """带 Function Calling 的对话请求。

    参数:
        messages: OpenAI 格式的消息列表 [{role, content, ...}]
        tools: 工具定义列表 [{type: "function", function: {...}}]
        tool_choice: "auto" | "required" | "none" | {type: "function", function: {name: ...}}

    返回:
        {
            "message": dict,        # 完整的 assistant message（可能含 tool_calls）
            "tool_calls": list,     # tool_calls 列表（为空则无工具调用）
            "content": str,         # assistant 的文本内容（可能为空）
            "tokens": dict,
            "model": str,
        }
    """
    model = model or DEFAULT_MODEL
    client = get_client()

    kwargs = {
        "model": model,
        "messages": messages,
        "tools": tools,
        "tool_choice": tool_choice,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "extra_body": {"thinking": {"type": "disabled"}},  # Function Calling 不需要思考模式
    }
    if timeout:
        kwargs["timeout"] = timeout

    # 带重试的请求
    last_error = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            resp = client.chat.completions.create(**kwargs)
            break
        except Exception as e:
            last_error = e
            error_str = str(e)
            is_retryable = (
                "timeout" in error_str.lower() or
                "timed out" in error_str.lower() or
                "rate_limit" in error_str.lower() or
                "429" in error_str or
                any(f"{c}" in error_str for c in [500, 502, 503, 504])
            )
            if is_retryable and attempt < MAX_RETRIES:
                wait = RETRY_BACKOFF[min(attempt, len(RETRY_BACKOFF) - 1)]
                logger.warning(f"[LLM tools] 重试 {attempt + 1}/{MAX_RETRIES} · 等待 {wait}s")
                time.sleep(wait)
                continue
            raise last_error

    msg = resp.choices[0].message
    tool_calls = []
    if msg.tool_calls:
        tool_calls = [
            {
                "id": tc.id,
                "name": tc.function.name,
                "arguments": tc.function.arguments,  # JSON 字符串
            }
            for tc in msg.tool_calls
        ]

    tokens = {"prompt": 0, "completion": 0, "total": 0}
    if resp.usage:
        tokens = {
            "prompt": resp.usage.prompt_tokens or 0,
            "completion": resp.usage.completion_tokens or 0,
            "total": resp.usage.total_tokens or 0,
        }

    return {
        "message": {
            "role": "assistant",
            "content": msg.content or "",
            "tool_calls": msg.tool_calls,
        },
        "tool_calls": tool_calls,
        "content": msg.content or "",
        "tokens": tokens,
        "model": model,
    }


def chat_stream(
    messages: list[dict],
    *,
    model: Optional[str] = None,
    temperature: float = 0.3,
    max_tokens: int = 8000,
):
    """流式对话（不支持 tools），逐 token yield。用于最终总结步骤。

    Yields:
        str: 每次生成的文本片段
    """
    model = model or DEFAULT_MODEL
    client = get_client()

    kwargs = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": True,
        "extra_body": {"thinking": {"type": "disabled"}},
    }

    response = client.chat.completions.create(**kwargs)
    for chunk in response:
        if chunk.choices and chunk.choices[0].delta.content:
            yield chunk.choices[0].delta.content
