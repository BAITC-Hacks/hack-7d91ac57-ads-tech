"""Minimal RAG store: embeddings via any OpenAI-compatible /embeddings endpoint,
cosine search with numpy, JSON persistence. Falls back to keyword scoring when
DEMO_MODE is on or no API key is set, so the app always works.
"""
from __future__ import annotations

import json
import logging
import math
import re
from pathlib import Path
from typing import Any

import numpy as np
from openai import AsyncOpenAI

from .config import get_settings
from .ingest import chunk_text

log = logging.getLogger("rag")
STORE_PATH = Path("data/rag_store.json")


class RagStore:
    def __init__(self) -> None:
        self.docs: list[dict[str, Any]] = []  # {id, source, text, meta}
        self.vecs: np.ndarray | None = None
        self._load()

    # ---------- persistence
    def _load(self) -> None:
        if STORE_PATH.exists():
            raw = json.loads(STORE_PATH.read_text())
            self.docs = raw["docs"]
            self.vecs = np.array(raw["vecs"], dtype=np.float32) if raw.get("vecs") else None

    def _save(self) -> None:
        try:
            STORE_PATH.parent.mkdir(exist_ok=True)
            STORE_PATH.write_text(
                json.dumps({"docs": self.docs, "vecs": self.vecs.tolist() if self.vecs is not None else None})
            )
        except OSError as e:  # keep serving from memory; persistence is best-effort
            log.warning("cannot persist rag store to %s: %s", STORE_PATH, e)

    def clear(self) -> None:
        self.docs, self.vecs = [], None
        self._save()

    # ---------- embeddings
    def _use_embeddings(self) -> bool:
        s = get_settings()
        return not s.demo_mode and bool(s.llm_api_key)

    async def _embed(self, texts: list[str]) -> np.ndarray:
        s = get_settings()
        client = AsyncOpenAI(api_key=s.llm_api_key, base_url=s.embed_base_url or s.llm_base_url)
        out: list[list[float]] = []
        for i in range(0, len(texts), 64):
            resp = await client.embeddings.create(model=s.embed_model, input=texts[i : i + 64])
            out.extend(d.embedding for d in resp.data)
        arr = np.array(out, dtype=np.float32)
        return arr / (np.linalg.norm(arr, axis=1, keepdims=True) + 1e-9)

    # ---------- api
    async def add(self, source: str, text: str, meta: dict[str, Any] | None = None) -> int:
        chunks = chunk_text(text)
        start = len(self.docs)
        self.docs.extend(
            {"id": start + i, "source": source, "text": c, "meta": meta or {}} for i, c in enumerate(chunks)
        )
        if self._use_embeddings() and chunks:
            new = await self._embed(chunks)
            self.vecs = new if self.vecs is None else np.vstack([self.vecs, new])
        else:
            self.vecs = None  # keyword mode
        self._save()
        return len(chunks)

    async def search(self, query: str, k: int = 5) -> list[dict[str, Any]]:
        if not self.docs:
            return []
        if self._use_embeddings() and self.vecs is not None and len(self.vecs) == len(self.docs):
            q = (await self._embed([query]))[0]
            scores = self.vecs @ q
        else:
            scores = np.array([_keyword_score(query, d["text"]) for d in self.docs], dtype=np.float32)
        idx = np.argsort(-scores)[:k]
        return [{**self.docs[i], "score": float(scores[i])} for i in idx if scores[i] > 0]


_WORD = re.compile(r"\w+", re.UNICODE)


def _keyword_score(query: str, text: str) -> float:
    q = {w.lower() for w in _WORD.findall(query) if len(w) > 2}
    if not q:
        return 0.0
    t = [w.lower() for w in _WORD.findall(text)]
    if not t:
        return 0.0
    hits = sum(1 for w in t if w in q)
    return hits / math.sqrt(len(t))


store = RagStore()
