from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class TileDBVcfQueryResponse(BaseModel):
    regions: list[str]
    samples_filter: list[str] | None = None
    row_count: int
    complete: bool = Field(description="False if results were truncated at max_rows")
    rows: list[dict[str, Any]] = Field(default_factory=list)
