import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import tools  # noqa: F401  (registers tools)
from .config import get_settings
from .ingest import extract_text
from .llm import run_agent, tool_specs
from .rag import store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
settings = get_settings()

SYSTEM_PROMPT = (
    "You are a helpful assistant. Use tools when they help. Answer in the user's language."
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    Path("data").mkdir(exist_ok=True)
    yield


app = FastAPI(title=settings.app_name, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]


class ChatResponse(BaseModel):
    answer: str
    steps: list[dict]
    latency_ms: int


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "app": settings.app_name,
        "env": settings.app_env,
        "model": settings.llm_model,
        "provider": settings.llm_base_url,
        "demo_mode": settings.demo_mode,
        "tools": [t["function"]["name"] for t in tool_specs()],
    }


@app.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    t0 = time.perf_counter()
    result = await run_agent([m.model_dump() for m in req.messages], system=SYSTEM_PROMPT)
    return ChatResponse(
        answer=result["answer"], steps=result["steps"], latency_ms=int((time.perf_counter() - t0) * 1000)
    )


# ---------- documents / RAG
@app.post("/api/documents")
async def upload_document(file: UploadFile = File(...)):
    data = await file.read()
    if not data:
        raise HTTPException(400, "empty file")
    try:
        text = extract_text(file.filename or "file.txt", data)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"cannot parse {file.filename}: {e}") from e
    n = await store.add(file.filename or "file", text)
    return {"source": file.filename, "chunks": n, "total_chunks": len(store.docs)}


@app.get("/api/documents")
def list_documents():
    sources: dict[str, int] = {}
    for d in store.docs:
        sources[d["source"]] = sources.get(d["source"], 0) + 1
    return {"sources": sources, "total_chunks": len(store.docs), "mode": "embeddings" if store.vecs is not None else "keyword"}


@app.delete("/api/documents")
def clear_documents():
    store.clear()
    return {"ok": True}


@app.get("/api/search")
async def search(q: str, k: int = 5):
    return {"query": q, "hits": await store.search(q, k=k)}
