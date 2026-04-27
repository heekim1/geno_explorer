"""Optional TileDB-VCF reads (requires ``tiledbvcf`` + native libraries)."""

from __future__ import annotations

import math
from typing import Any


def tiledbvcf_available() -> bool:
    try:
        import tiledbvcf  # noqa: F401
    except ImportError:
        return False
    return True


def _json_safe(v: Any) -> Any:
    """Best-effort conversion for numpy/pandas scalars and nested containers."""
    # numpy arrays need conversion before scalar .item() handling.
    if hasattr(v, "tolist") and callable(getattr(v, "tolist")):
        try:
            vv = v.tolist()
            # Preserve scalars as-is, recurse containers.
            if isinstance(vv, (list, tuple, dict)):
                return _json_safe(vv)
            v = vv
        except Exception:
            pass
    # numpy/pandas scalar types often expose .item()
    if hasattr(v, "item") and callable(getattr(v, "item")):
        try:
            v = v.item()
        except Exception:
            pass
    if isinstance(v, dict):
        return {str(k): _json_safe(x) for k, x in v.items()}
    if isinstance(v, (list, tuple, set)):
        return [_json_safe(x) for x in v]
    if isinstance(v, float) and math.isnan(v):
        return None
    return v


def _records_from_df(df) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    safe = df.astype(object).where(df.notna(), None)
    for rec in safe.to_dict(orient="records"):
        row: dict[str, Any] = {str(k): _json_safe(v) for k, v in rec.items()}
        out.append(row)
    return out


_READ_ATTR_CHAINS: tuple[list[str], ...] = (
    # Preferred: FORMAT + site-level QUAL/FILTER where schema supports them.
    [
        "sample_name",
        "contig",
        "pos_start",
        "pos_end",
        "alleles",
        "fmt_GT",
        "fmt_GQ",
        "fmt_DP",
        "fmt_MIN_DP",
        "fmt_AD",
        "fmt_VAF",
        "fmt_PL",
        "fmt_GL",
        "qual",
        "filters",
        "filter_ids",
    ],
    [
        "sample_name",
        "contig",
        "pos_start",
        "pos_end",
        "alleles",
        "fmt_GT",
        "fmt_GQ",
        "fmt_DP",
        "fmt_MIN_DP",
        "fmt_AD",
        "fmt_VAF",
        "fmt_PL",
    ],
)


def read_query(
    uri: str,
    regions: list[str],
    *,
    samples: list[str] | None = None,
    max_rows: int = 10_000,
) -> tuple[list[dict[str, Any]], bool]:
    """
    Read variant rows from a TileDB-VCF dataset for the given regions.

    Returns ``(records, complete)`` where ``complete`` is False if the library
    truncated the scan before returning all rows (TileDB-VCF may paginate).
    """
    import tiledbvcf

    ds = tiledbvcf.Dataset(uri=uri, mode="r")
    df = None
    for attrs in _READ_ATTR_CHAINS:
        kwargs: dict[str, Any] = {"regions": regions, "attrs": attrs}
        if samples:
            kwargs["samples"] = samples
        try:
            df = ds.read(**kwargs)
            break
        except Exception:
            continue
    if df is None:
        # Fallback for datasets/schemas that don't expose requested attrs.
        fallback: dict[str, Any] = {"regions": regions}
        if samples:
            fallback["samples"] = samples
        df = ds.read(**fallback)
    rows: list[dict[str, Any]] = []
    while True:
        if df is not None and not getattr(df, "empty", True):
            for r in _records_from_df(df):
                rows.append(r)
                if len(rows) >= max_rows:
                    return rows, False
        if ds.read_completed():
            break
        df = ds.continue_read()
    return rows, True


def list_sample_names(uri: str) -> list[str]:
    import tiledbvcf

    ds = tiledbvcf.Dataset(uri=uri, mode="r")
    names = ds.samples()
    return sorted(names) if names else []


def sample_count(uri: str) -> int:
    import tiledbvcf

    ds = tiledbvcf.Dataset(uri=uri, mode="r")
    return int(ds.sample_count())
