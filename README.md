# geno_explorer

Small web app to query a **TileDB-VCF** cohort from the browser: region filters, a genotype matrix by coordinate and sample, and a coordinate popup with per-sample FORMAT fields plus **cohort-level allele counts**.

---

## Architecture

```text
┌─────────────────────┐     HTTP /api/*      ┌──────────────────────────┐
│  React UI (Vite)    │ ───────────────────► │  FastAPI (`api/app`)      │
│  `ui/`              │   (dev proxy :5173)  │  TileDB-VCF router        │
└─────────────────────┘                      └─────────────┬────────────┘
                                                           │
                                                           ▼
                                              ┌──────────────────────────┐
                                              │  TileDB-VCF dataset       │
                                              │  `TILEDB_VCF_URI`         │
                                              │  (Python `tiledbvcf`)     │
                                              └──────────────────────────┘
```

- **`ui/`** — React + TypeScript + TanStack Query. In development, Vite proxies `/api` to the API (see `ui/vite.config.ts`, default `http://127.0.0.1:8000`).
- **`api/`** — FastAPI service (`app/main.py`). Exposes `/api/tiledb-vcf/health`, `/samples`, and `/query`. Reads variants via `app/tiledb_vcf_reader.py` using the installed `tiledbvcf` package and the dataset URI from configuration.
- **Configuration** — API settings live in `api/app/config.py` (environment variables / `.env`). Notable options:
  - `TILEDB_VCF_URI` — path or URI to the TileDB-VCF dataset (required for queries).
  - `GENO_REFERENCE_BUILD`, `GENO_VCF_CALLER_INFO` — optional strings surfaced in the coordinate-detail JSON and health payload for provenance.

The browser does not talk to TileDB directly; all dataset access goes through the API.

---

## Cohort-level allele statistics (coordinate popup)

Statistics are computed in the UI for the **same sample list** as the matrix (whole cohort or the comma-separated filter). They summarize **biallelic** sites using VCF-style integer `GT` indices into the `alleles` array (`0` = REF, `1` = first ALT, …).

### Definitions (biallelic: REF = `T`, ALT = `C`)

| Field | Rule |
|--------|------|
| **n_hom_ref** | Count of samples with `GT == [0, 0]` |
| **n_het** | Count of samples with `GT == [0, 1]` or `[1, 0]` |
| **n_hom_alt** | Count of samples with `GT == [1, 1]` |
| **n_missing** | Count of samples with missing genotype (`./.`, unset GT, or no overlapping TileDB row for that coordinate) |
| **AC** (allele count) | Sum over samples of **alternate alleles**: each allele index `> 0` contributes **1** to AC |
| **AN** (allele number) | Sum over **called** diploid samples of **2** per sample (two alleles); missing samples contribute **0** |
| **AF** (allele frequency) | `AF = AC / AN` when `AN > 0` |

So **homozygous alternate** `1/1` contributes **2** to AC (and **2** to AN), **heterozygous** `0/1` contributes **1** to AC (and **2** to AN), and **homozygous reference** `0/0` contributes **0** to AC (**2** to AN).

### Worked example

Five diploid samples at a SNV (`REF = T`, `ALT = C`):

| Sample | GT | Contribution |
|--------|-----|----------------|
| NWD210828 | `0/0` | AC += 0, AN += 2; **n_hom_ref** += 1 |
| NWD237135 | `1/1` | AC += 2, AN += 2; **n_hom_alt** += 1 |
| NWD286130 | `0/1` | AC += 1, AN += 2; **n_het** += 1 |
| NWD348503 | `1/1` | AC += 2, AN += 2; **n_hom_alt** += 1 |
| SJALL003819… | `1/1` | AC += 2, AN += 2; **n_hom_alt** += 1 |

Totals:

```json
{
  "AC": 7,
  "AN": 10,
  "AF": 0.7,
  "n_het": 1,
  "n_hom_alt": 3,
  "n_hom_ref": 1,
  "n_missing": 0
}
```

### GLnexus VCF output comparison

Reference GLnexus row for the same site:

```text
#CHROM  POS       ID  REF ALT QUAL FILTER INFO                          FORMAT      NWD210828 NWD237135 NWD286130 NWD348503 SJALL003819
chr21   33000166  .   T   C   .    PASS   AC=7;AN=10;AF=0.7;NS=5        GT:GQ:DP    0/0:50:29  1/1:50:48  0/1:32:41  1/1:52:32  1/1:41:55
```

How this maps to the coordinate popup payload:

- `REF`, `ALT`, per-sample `GT`, `GQ`, `DP` should match directly.
- `INFO/AC`, `INFO/AN`, `INFO/AF` correspond to popup `AC`, `AN`, `AF`.
- `NS=5` corresponds to called samples (here `n_missing=0`, so all 5 are called).
- `FILTER=PASS` and `QUAL` are surfaced in sample/source fields when the TileDB schema exposes them.

### Common mistake

Do **not** treat each heterozygote as one “ALT allele” toward AC **and** each homozygous ALT as a single count. Wrong reasoning yields totals like **AC = 5**, **AF = 0.5** (e.g. counting three `1/1` samples as **3** alternate alleles instead of **6**). Each `1/1` sample carries **two** ALT alleles; each `0/1` carries **one**.

---

## Implementation note

For **multiallelic** sites, the UI counts **every** non-reference allele index (`> 0`) toward AC; genotype class buckets (**hom_ref** / **het** / **hom_alt**) follow the same “has ref / has alt” split used for biallelic SNVs but do not distinguish multiple alternate alleles in the summary counts.

---

## Popup `filter_flags`

The coordinate popup also emits `filter_flags` to quickly label sites/summaries for downstream review.

Possible values:

- `PASS` - passed all current rules
- `NO_ALT` - `AC == 0` (no alternate allele observed)
- `LOW_CALL_RATE` - `call_rate < 0.8`
- `LOW_GQ` - `mean_gq < 20`
- `LOW_DP` - `mean_dp < 10`
- `LOW_ALT_SUPPORT` - `n_alt_supporting_samples < 1`
- `VAF_OUTLIER` - at least one sample has VAF inconsistent with GT (basic heuristic thresholds)
- `LOW_QUAL` - site QUAL is available and mean QUAL `< 20`
- `COMPLEX_SITE` - multi-ALT site (`ALT.length > 1`)

Rule behavior:

- Multiple flags can be present simultaneously.
- `PASS` is emitted only when no other flag is triggered.

Current rule sketch (matches UI implementation):

```python
def assign_filter(summary):
    filters = []

    if summary["AC"] == 0:
        filters.append("NO_ALT")

    if summary["call_rate"] < 0.8:
        filters.append("LOW_CALL_RATE")

    if summary["mean_gq"] < 20:
        filters.append("LOW_GQ")

    if summary["mean_dp"] < 10:
        filters.append("LOW_DP")

    if summary.get("n_alt_supporting_samples", 0) < 1:
        filters.append("LOW_ALT_SUPPORT")
```
