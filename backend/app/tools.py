"""Domain tools exposed to the agent. Replace with real ones during the hackathon."""
from datetime import datetime, timezone

from .llm import tool


@tool("Get the current UTC date and time.")
def now() -> str:
    return datetime.now(timezone.utc).isoformat()


@tool(
    "Example lookup tool. Replace with domain logic.",
    {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
)
def lookup(query: str) -> dict:
    return {"query": query, "results": []}


@tool(
    "Search the uploaded knowledge base (documents, materials). Returns the most relevant passages with sources.",
    {"type": "object", "properties": {"query": {"type": "string"}, "k": {"type": "integer", "default": 5}}, "required": ["query"]},
)
async def search_documents(query: str, k: int = 5) -> list[dict]:
    from .rag import store

    hits = await store.search(query, k=k)
    return [{"source": h["source"], "text": h["text"], "score": round(h["score"], 3)} for h in hits]
