#!/usr/bin/env python3
"""
TileDB-VCF workflow for many bgzipped gVCF/VCF files (columnar store, region queries).

This parallels the *idea* of GATK ``GenomicsDBImport`` (merge cohort gVCFs into a
query-friendly store on TileDB). GATK's GenomicsDB is a separate format; for
native TileDB columnar storage and **incremental** sample adds, use TileDB-VCF:

  https://gatk.broadinstitute.org/hc/en-us/articles/30332006200603-GenomicsDBImport
  https://docs.tiledb.com/apis/python/vcf

**Install** (native library required; conda is usually easiest)::

  mamba install -c conda-forge tiledbvcf-py
  # or: pip install tiledbvcf

---------------------------------------------------------------------------
Complete example (initial load + append new gVCF + API)
---------------------------------------------------------------------------

From the ``api/`` directory (replace paths with yours)::

  # 0) Dependencies
  mamba install -c conda-forge tiledbvcf-py bcftools

  # 1) Create an empty TileDB-VCF dataset (once)
  cd /path/to/geno_explorer/api
  PYTHONPATH=. python scripts/tiledb_vcf_gvcf.py create --uri /data/cohort_tiledbvcf

  # 2) Ingest first batch (each file must be bgzipped + tabix .tbi or .csi)
  PYTHONPATH=. python scripts/tiledb_vcf_gvcf.py store --uri /data/cohort_tiledbvcf --threads 8 \\
    --inputs '/vault/batch1/*.g.vcf.gz'

  # 3) Append more samples later — same ``store`` command on the existing URI
  PYTHONPATH=. python scripts/tiledb_vcf_gvcf.py store --uri /data/cohort_tiledbvcf --threads 8 \\
    --resume \\
    --inputs /vault/batch2/NWD999999.g.vcf.gz

  # 4) CLI smoke query
  PYTHONPATH=. python scripts/tiledb_vcf_gvcf.py read --uri /data/cohort_tiledbvcf \\
    --regions 'chr21:33000000-33000500' --limit 30

  # 5) Point the FastAPI app at the dataset and start the server
  export TILEDB_VCF_URI=/data/cohort_tiledbvcf
  uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

  # 6) HTTP checks (from another shell)
  curl -s 'http://127.0.0.1:8000/api/tiledb-vcf/health' | python -m json.tool
  curl -s 'http://127.0.0.1:8000/api/tiledb-vcf/samples' | python -m json.tool
  curl -s 'http://127.0.0.1:8000/api/tiledb-vcf/query?regions=chr21:33000000-33000500&max_rows=100' \\
    | python -m json.tool

**Upstream CLI** (if ``tiledbvcf`` is on ``PATH``)::

  tiledbvcf create --uri /data/cohort_tiledbvcf
  tiledbvcf store --uri /data/cohort_tiledbvcf /path/*.g.vcf.gz
  tiledbvcf export --uri /data/cohort_tiledbvcf --regions chr21:10000000-10001000 -O t

Prerequisites: each ``.g.vcf.gz`` must have a matching ``.tbi`` (or ``.csi``) index.
"""

from __future__ import annotations

import argparse
import glob
import sys
from pathlib import Path


def _require_tiledbvcf():
    try:
        import tiledbvcf  # noqa: F401
    except ImportError as e:
        print(
            "tiledbvcf is not installed. Use conda: mamba install -c conda-forge tiledbvcf-py\n"
            "or pip install tiledbvcf (requires compatible native TileDB-VCF libraries).",
            file=sys.stderr,
        )
        raise SystemExit(1) from e
    return __import__("tiledbvcf")


def cmd_create(uri: str) -> None:
    tiledbvcf = _require_tiledbvcf()
    ds = tiledbvcf.Dataset(uri=uri, mode="w")
    ds.create_dataset()
    print(f"Created empty dataset at {uri}")


def cmd_store(uri: str, inputs: list[str], threads: int, resume: bool) -> None:
    tiledbvcf = _require_tiledbvcf()
    paths: list[str] = []
    for pat in inputs:
        paths.extend(sorted(glob.glob(pat)) if any(c in pat for c in "*?[") else [pat])
    paths = [p for p in paths if Path(p).is_file()]
    if not paths:
        raise SystemExit("No input files matched.")
    ds = tiledbvcf.Dataset(uri=uri, mode="w")
    if not Path(uri).exists():
        ds.create_dataset()
    try:
        ds.ingest_samples(sample_uris=paths, threads=threads, resume=resume)
    except TypeError:
        ds.ingest_samples(sample_uris=paths, threads=threads)
    action = "Resumed / appended" if resume else "Ingested"
    print(f"{action} {len(paths)} file(s) into {uri}")


def cmd_read(
    uri: str,
    regions: list[str],
    samples: list[str] | None,
    limit: int,
    attrs: list[str] | None,
) -> None:
    tiledbvcf = _require_tiledbvcf()
    ds = tiledbvcf.Dataset(uri=uri, mode="r")
    default_attrs = [
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
    ]
    kwargs: dict = {"regions": regions, "attrs": attrs or default_attrs}
    if samples:
        kwargs["samples"] = samples
    try:
        df = ds.read(**kwargs)
    except Exception:
        # Some datasets may miss one or more requested attrs; fall back to defaults from schema.
        fallback: dict = {"regions": regions}
        if samples:
            fallback["samples"] = samples
        df = ds.read(**fallback)
    if df is None or getattr(df, "empty", False):
        print("(no rows)")
        return
    import pandas as pd

    pd.set_option("display.max_columns", 20)
    pd.set_option("display.width", 200)
    print(df.head(limit).to_string(index=False))


def main() -> None:
    p = argparse.ArgumentParser(description="TileDB-VCF: create, ingest gVCF/VCF, read regions.")
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("create", help="Create an empty TileDB-VCF dataset directory")
    c.add_argument("--uri", required=True, help="Filesystem path for the dataset")

    s = sub.add_parser(
        "store",
        help="Ingest or append indexed .vcf.gz / .bcf (re-run on same URI to add samples)",
    )
    s.add_argument("--uri", required=True)
    s.add_argument(
        "--inputs",
        nargs="+",
        required=True,
        help="Paths or globs (e.g. /data/*.g.vcf.gz)",
    )
    s.add_argument("--threads", type=int, default=4)
    s.add_argument(
        "--resume",
        action="store_true",
        help="Resume a partial ingest / TileDB-VCF resume mode when supported",
    )

    r = sub.add_parser("read", help="Query regions (returns a preview table)")
    r.add_argument("--uri", required=True)
    r.add_argument(
        "--regions",
        nargs="+",
        required=True,
        help='Regions like chr21:5030000-5031000 or chr21:5030000',
    )
    r.add_argument("--samples", nargs="*", help="Optional sample name filter")
    r.add_argument("--limit", type=int, default=50)
    r.add_argument(
        "--attrs",
        nargs="*",
        help=(
            "Optional explicit attrs to read (e.g. sample_name contig pos_start pos_end "
            "fmt_GT fmt_GQ fmt_DP fmt_MIN_DP)."
        ),
    )

    args = p.parse_args()
    if args.cmd == "create":
        cmd_create(args.uri)
    elif args.cmd == "store":
        cmd_store(args.uri, args.inputs, args.threads, args.resume)
    elif args.cmd == "read":
        cmd_read(args.uri, args.regions, args.samples or None, args.limit, args.attrs or None)


if __name__ == "__main__":
    main()
