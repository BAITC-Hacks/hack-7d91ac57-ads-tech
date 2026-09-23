.PHONY: setup dev backend frontend up down verify commit

setup: ## install backend venv + frontend deps
	cd backend && python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt
	cd frontend && npm install
	[ -f .env ] || cp .env.example .env

backend: ## run API with reload on :8000
	cd backend && .venv/bin/uvicorn app.main:app --reload --port 8000

frontend: ## run vite on :5173 (proxies /api to :8000)
	cd frontend && npm run dev

up: ## docker compose full stack on :8080
	docker compose up --build -d

down:
	docker compose down

verify: ## run the reviewer's main-scenario check
	bash scripts/verify.sh

commit: ## quick checkpoint commit
	git add -A && git commit -m "checkpoint: $$(date +%H:%M)" && git push
