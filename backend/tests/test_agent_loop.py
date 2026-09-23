"""Tool-calling loop with a fake LLM client: the model asks for explain_sku, gets engine facts back, answers.
No network: the OpenAI client is replaced."""
import asyncio
import json
from types import SimpleNamespace as NS

from app import llm, tools  # noqa: F401  (registers tools)


class FakeCompletions:
    def __init__(self):
        self.calls = []

    async def create(self, **kw):
        self.calls.append({**kw, "messages": list(kw["messages"])})
        if len(self.calls) == 1:
            tc = NS(id="c1", function=NS(name="explain_sku", arguments=json.dumps({"sku": "LMP-006"})))
            return NS(choices=[NS(message=NS(content=None, tool_calls=[tc]))])
        return NS(choices=[NS(message=NS(content="Рекомендовано 200 шт: см. факты инструмента.", tool_calls=None))])


def test_agent_calls_engine_tool_and_answers(monkeypatch):
    fake = FakeCompletions()
    monkeypatch.setattr(llm, "_client", lambda: NS(chat=NS(completions=fake)))
    s = llm.get_settings()
    monkeypatch.setattr(s, "demo_mode", False)
    monkeypatch.setattr(s, "llm_api_key", "test")
    r = asyncio.run(llm.run_agent([{"role": "user", "content": "почему LMP-006?"}], system="sys"))
    assert r["answer"].startswith("Рекомендовано")
    assert r["steps"][0]["tool"] == "explain_sku"
    facts = json.loads(r["steps"][0]["result"])
    assert facts["sku"] == "LMP-006" and facts["recommended_qty"] > 0 and "justification" in facts
    # second request carries the tool result back to the model, in a provider-neutral shape
    msgs = fake.calls[1]["messages"]
    assert msgs[-2]["role"] == "assistant" and msgs[-2]["tool_calls"][0]["function"]["name"] == "explain_sku"
    assert msgs[-1]["role"] == "tool" and msgs[-1]["tool_call_id"] == "c1"
    names = [t["function"]["name"] for t in fake.calls[0]["tools"]]
    assert {"explain_sku", "what_if", "list_orders", "run_replenishment", "draft_supplier_email"} <= set(names)
