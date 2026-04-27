from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from app.config import Settings, get_settings
from app.schemas import TileDBVcfQueryResponse
from app.tiledb_vcf_reader import list_sample_names, read_query, sample_count, tiledbvcf_available

router = APIRouter(prefix="/api/tiledb-vcf", tags=["tiledb-vcf"])


def _require_tiledb(settings: Settings) -> str:
    uri = (settings.tiledb_vcf_uri or "").strip()
    if not uri:
        raise HTTPException(
            status_code=503,
            detail="Set TILEDB_VCF_URI to your TileDB-VCF dataset path (see scripts/tiledb_vcf_gvcf.py).",
        )
    if not Path(uri).exists():
        raise HTTPException(
            status_code=503,
            detail=f"TILEDB_VCF_URI path does not exist: {uri!r}",
        )
    if not tiledbvcf_available():
        raise HTTPException(
            status_code=503,
            detail="Python package tiledbvcf is not installed (e.g. mamba install -c conda-forge tiledbvcf-py).",
        )
    return uri


def get_settings_dep() -> Settings:
    return get_settings()


@router.get("/health")
def tiledb_health(settings: Settings = Depends(get_settings_dep)) -> dict[str, Any]:
    """Return whether TileDB-VCF is configured and importable."""
    uri = (settings.tiledb_vcf_uri or "").strip()
    out: dict[str, Any] = {
        "configured": bool(uri),
        "uri": uri if uri else None,
        "path_exists": Path(uri).exists() if uri else False,
        "tiledbvcf_importable": tiledbvcf_available(),
        "ready": False,
    }
    if out["configured"] and out["path_exists"] and out["tiledbvcf_importable"]:
        try:
            out["sample_count"] = sample_count(uri)
            out["ready"] = True
        except OSError as e:
            out["error"] = str(e)
    rb = (settings.geno_reference_build or "").strip()
    if rb:
        out["reference_build"] = rb
    ci = (settings.geno_vcf_caller_info or "").strip()
    if ci:
        out["vcf_caller_info"] = ci
    return out


@router.get("/samples")
def tiledb_samples(settings: Settings = Depends(get_settings_dep)) -> dict[str, list[str]]:
    uri = _require_tiledb(settings)
    try:
        names = list_sample_names(uri)
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    return {"samples": names}


@router.get("/query", response_model=TileDBVcfQueryResponse)
def tiledb_query(
    regions: str = Query(
        ...,
        description="Comma-separated regions, e.g. chr21:33000000-33001000,chr22:16000000-16000100",
    ),
    samples: str | None = Query(
        None,
        description="Optional comma-separated sample names to restrict the scan",
    ),
    max_rows: int = Query(200_000, ge=1, le=500_000),
    settings: Settings = Depends(get_settings_dep),
) -> TileDBVcfQueryResponse:
    """
    Query the TileDB-VCF dataset for one or more genomic intervals.

    Rows are the native attributes stored in the dataset (schema depends on ingest).
    """
    uri = _require_tiledb(settings)
    reg_list = [r.strip() for r in regions.split(",") if r.strip()]
    if not reg_list:
        raise HTTPException(status_code=400, detail="No regions provided.")
    sample_list = [s.strip() for s in samples.split(",") if s.strip()] if samples else None
    try:
        rows, complete = read_query(uri, reg_list, samples=sample_list, max_rows=max_rows)
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"TileDB query failed: {e}") from e
    return TileDBVcfQueryResponse(
        regions=reg_list,
        samples_filter=sample_list,
        row_count=len(rows),
        complete=complete,
        rows=rows,
    )
