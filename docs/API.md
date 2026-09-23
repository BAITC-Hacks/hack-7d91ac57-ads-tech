# Контракт API (источник правды для фронтенда)

Base URL в dev: `/api` (Vite проксирует на `http://localhost:8000`). Все ответы JSON, ошибки — `{"detail": "..."}` с HTTP 4xx/5xx.

## GET /api/health
```json
{"status":"ok","app":"hackalem-app","env":"dev","model":"gpt-4.1-mini","provider":"https://api.openai.com/v1","demo_mode":false,"tools":["now","lookup","search_documents"]}
```

## POST /api/chat
Запрос:
```json
{"messages":[{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}
```
Ответ:
```json
{"answer":"текст ответа","steps":[{"tool":"search_documents","args":"{\"query\":\"...\"}","result":"..."}],"latency_ms":1234}
```
`steps` — вызовы инструментов по порядку, показывать в панели «Шаги агента». `latency_ms` — показывать в UI (стоимость/скорость).

## POST /api/documents  (multipart/form-data, поле `file`)
Поддерживаются: pdf, docx, txt, md, csv, json. Ответ:
```json
{"source":"lesson.pdf","chunks":12,"total_chunks":30}
```
Ошибки: 400 `empty file`, 400 `cannot parse <name>: ...`.

## GET /api/documents
```json
{"sources":{"lesson.pdf":12,"notes.txt":3},"total_chunks":15,"mode":"embeddings|keyword"}
```

## DELETE /api/documents
```json
{"ok":true}
```

## GET /api/search?q=...&k=5
```json
{"query":"...","hits":[{"id":0,"source":"lesson.pdf","text":"...","meta":{},"score":0.83}]}
```

## Изменения (дописывать сверху вниз)
| Время | Что изменилось |
|---|---|
| | |
