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

    if s.demo_mode or not s.llm_api_key:
        # No LLM available (DEMO_MODE or no key): still exercise the tools so reviewers see a real result.
        user_text = next((m.get("content") or "" for m in reversed(messages) if m.get("role") == "user"), "")
        import re

        m = re.search(r"[A-Za-z]{3}-\d{3}|\d{9}_?", user_text)
        if m and "explain_sku" in _TOOLS:
            out = await _call_tool("explain_sku", json.dumps({"sku": m.group(0).upper()}))
            steps.append({"tool": "explain_sku", "args": json.dumps({"sku": m.group(0).upper()}), "result": out[:2000]})
            d = json.loads(out)
            answer = "[DEMO MODE, без LLM] " + (d.get("justification") or d.get("error", ""))
            return {"answer": answer, "steps": steps, "messages": history}
        if "list_orders" in _TOOLS:
            out = await _call_tool("list_orders", json.dumps({"urgency": "critical", "limit": 5}))
            steps.append({"tool": "list_orders", "args": json.dumps({"urgency": "critical"}), "result": out[:2000]})
            d = json.loads(out)
            rows = d.get("orders", [])
            answer = "[DEMO MODE, без LLM] Критичные позиции: " + "; ".join(f"{r['sku']} {r['name']} — {r['recommended_qty']} шт ({r['supplier']})" for r in rows) if rows else "[DEMO MODE] Критичных позиций нет."
            return {"answer": answer, "steps": steps, "messages": history}
        return {"answer": "[DEMO MODE, без LLM] Укажите артикул (например, LMP-001) или спросите про критичные позиции.", "steps": steps, "messages": history}

    client = _client()
    specs = tool_specs()
    for _ in range(s.llm_max_tool_rounds):
        try:
            resp = await client.chat.completions.create(
                model=s.llm_model,
                messages=history,
                temperature=s.llm_temperature,
                tools=specs or None,
            )
        except Exception as e:  # noqa: BLE001 — never turn an LLM outage into a 500
            log.exception("LLM call failed")
            return {"answer": f"LLM недоступен ({type(e).__name__}). Включите DEMO_MODE=true или проверьте LLM_API_KEY. Расчёт и экспорт работают без LLM.", "steps": steps, "messages": history}
        msg = resp.choices[0].message
        # clean, provider-neutral assistant message (OpenAI, NVIDIA NIM, vLLM all accept this shape)
        am: dict[str, Any] = {"role": "assistant", "content": msg.content or ""}
        if msg.tool_calls:
            am["tool_calls"] = [{"id": tc.id, "type": "function", "function": {"name": tc.function.name, "arguments": tc.function.arguments or "{}"}} for tc in msg.tool_calls]
        history.append(am)
        if not msg.tool_calls:
            return {"answer": msg.content or "", "steps": steps, "messages": history}
        for tc in msg.tool_calls:
            out = await _call_tool(tc.function.name, tc.function.arguments)
            steps.append({"tool": tc.function.name, "args": tc.function.arguments, "result": out[:2000]})
            history.append({"role": "tool", "tool_call_id": tc.id, "content": out})
    return {"answer": "Reached max tool rounds.", "steps": steps, "messages": history}
