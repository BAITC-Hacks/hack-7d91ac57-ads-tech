"""Runtime settings. All values come from environment / .env (see .env.example)."""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "hackalem-app"
    app_env: str = "dev"
    api_port: int = 8000
    cors_origins: str = "http://localhost:5173,http://localhost:3000,http://localhost:8080"

    # LLM provider. Any OpenAI-compatible endpoint works:
    #   OpenAI:      LLM_BASE_URL=https://api.openai.com/v1        LLM_MODEL=gpt-4.1-mini
    #   NVIDIA NIM:  LLM_BASE_URL=https://integrate.api.nvidia.com/v1  LLM_MODEL=meta/llama-3.3-70b-instruct
    #   Ollama:      LLM_BASE_URL=http://localhost:11434/v1        LLM_MODEL=llama3.1
    llm_api_key: str = ""
    llm_base_url: str = "https://api.openai.com/v1"
    llm_model: str = "gpt-4.1-mini"
    llm_temperature: float = 0.2
    llm_max_tool_rounds: int = 8

    # DEMO_MODE=true makes the app work without any API key (canned answers) so
    # reviewers can always run the main scenario.
    demo_mode: bool = False

    # Embeddings (RAG). Defaults to the LLM provider; OpenAI: text-embedding-3-small
    embed_model: str = "text-embedding-3-small"
    embed_base_url: str = ""

    database_url: str = "sqlite:///./data/app.db"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
