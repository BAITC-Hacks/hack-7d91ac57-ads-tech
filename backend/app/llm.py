"""Thin LLM client with a tool-calling agent loop.

Works with any OpenAI-compatible API (OpenAI, NVIDIA NIM, Ollama, vLLM).
Register tools with @tool, then call run_agent(messages).
"""
from __future__ import annotations

import inspect
import json
import logging
from typing import Any, Awaitable, Callable

from openai import AsyncOpenAI

from .config import get_settings

log = logging.getLogger("llm")

ToolFn = Callable[..., Any | Awaitable[Any]]

_TOOLS: dict[str, dict[str, Any]] = {}


def tool(description: str, parameters: dict[str, Any] | None = None):
    """Register a python function as an LLM tool.

    parameters: JSON schema for the arguments. If omitted, a simple schema is
    derived from the signature (all args typed as string).
    """

    def deco(fn: ToolFn):
        sig = inspect.signature(fn)
        schema = parameters or {
            "type": "object",
            "properties": {p: {"type": "string"} for p in sig.parameters},
            "required": [p for p, v in sig.parameters.items() if v.default is inspect._empty],
        }
        _TOOLS[fn.__name__] = {
            "fn": fn,
            "spec": {
                "type": "function",
                "function": {"name": fn.__name__, "description": description, "parameters": schema},
            },
        }
        return fn

    return deco


def tool_specs() -> list[dict[str, Any]]:
    return [t["spec"] for t in _TOOLS.values()]


def _client() -> AsyncOpenAI:
    s = get_settings()
    return AsyncOpenAI(api_key=s.llm_api_key or "missing", base_url=s.llm_base_url)


async def _call_tool(name: str, raw_args: str) -> str:
    entry = _TOOLS.get(name)
    if not entry:
        return json.dumps({"error": f"unknown tool {name}"})
    try:
        args = json.loads(raw_args or "{}")
        result = entry["fn"](**args)
        if inspect.isawaitable(result):
            result = await result
        return result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, default=str)
    except Exception as e:  # noqa: BLE001
        log.exception("tool %s failed", name)
        return json.dumps({"error": str(e)})


async def chat(messages: list[dict[str, Any]], **kwargs: Any) -> str:
    """Single completion, no tools."""
    s = get_settings()
    if s.demo_mode:
        return "[DEMO MODE] " + (messages[-1].get("content") or "")[:200]
    resp = await _client().chat.completions.create(
        model=s.llm_model, messages=messages, temperature=s.llm_temperature, **kwargs
    )
    return resp.choices[0].message.content or ""


async def run_agent(messages: list[dict[str, Any]], system: str | None = None) -> dict[str, Any]:
    """Tool-calling loop. Returns {"answer": str, "steps": [...], "messages": [...]}"""
    s = get_settings()
    history: list[dict[str, Any]] = ([{"role": "system", "content": system}] if system else []) + list(messages)
    steps: list[dict[str, Any]] = []

    if s.demo_mode:
        # No LLM available: still exercise the tools so reviewers see a real result.
        user_text = next((m.get("content") or "" for m in reversed(messages) if m.get("role") == "user"), "")
        if "search_documents" in _TOOLS and user_text:
            out = await _call_tool("search_documents", json.dumps({"query": user_text, "k": 2}))
            steps.append({"tool": "search_documents", "args": json.dumps({"query": user_text}), "result": out[:2000]})
            hits = json.loads(out) if out.startswith("[") else []
            if hits:
                answer = "[DEMO MODE, без LLM] Наиболее релевантные фрагменты из материалов:\n\n" + "\n\n".join(
                    f"— {h['text'][:500]}\n(источник: {h['source']})" for h in hits
                )
                return {"answer": answer, "steps": steps, "messages": history}
        return {
            "answer": "[DEMO MODE, без LLM] Материалы не загружены. Загрузите файл, и я покажу релевантные фрагменты.",
            "steps": steps,
            "messages": history,
        }

    client = _client()
    specs = tool_specs()
    for _ in range(s.llm_max_tool_rounds):
        resp = await client.chat.completions.create(
            model=s.llm_model,
            messages=history,
            temperature=s.llm_temperature,
            tools=specs or None,
        )
        msg = resp.choices[0].message
        history.append(msg.model_dump(exclude_none=True))
        if not msg.tool_calls:
            return {"answer": msg.content or "", "steps": steps, "messages": history}
        for tc in msg.tool_calls:
            out = await _call_tool(tc.function.name, tc.function.arguments)
            steps.append({"tool": tc.function.name, "args": tc.function.arguments, "result": out[:2000]})
            history.append({"role": "tool", "tool_call_id": tc.id, "content": out})
    return {"answer": "Reached max tool rounds.", "steps": steps, "messages": history}
