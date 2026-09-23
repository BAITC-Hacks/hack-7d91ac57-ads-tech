export type Msg = { role: "user" | "assistant"; content: string };
export type ChatResponse = { answer: string; steps: { tool: string; args: string; result: string }[]; latency_ms: number };

const BASE = import.meta.env.VITE_API_URL || "";

export async function health() {
  const r = await fetch(`${BASE}/api/health`);
  if (!r.ok) throw new Error(`health ${r.status}`);
  return r.json();
}

export async function chat(messages: Msg[]): Promise<ChatResponse> {
  const r = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (!r.ok) throw new Error(`chat ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function uploadDocument(file: File) {
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch(`${BASE}/api/documents`, { method: "POST", body: fd });
  if (!r.ok) throw new Error(`upload ${r.status}: ${await r.text()}`);
  return r.json() as Promise<{ source: string; chunks: number; total_chunks: number }>;
}
