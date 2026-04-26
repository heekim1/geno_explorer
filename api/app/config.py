from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    # Optional: filesystem (or cloud) URI of a TileDB-VCF dataset for /api/tiledb-vcf/*
    tiledb_vcf_uri: str | None = None


def get_settings() -> Settings:
    return Settings()
