import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import './App.css'
import {
  fetchTileDBHealth,
  fetchTileDBQuery,
  fetchTileDBSamples,
} from './api'

function TileCoordDetailModal({
  coordKey,
  detail,
  onClose,
}: {
  coordKey: string | null
  detail: Record<string, unknown> | null
  onClose: () => void
}) {
  useEffect(() => {
    if (!coordKey) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [coordKey, onClose])

  if (!coordKey) return null

  const nSamples = Array.isArray(detail?.samples) ? (detail!.samples as unknown[]).length : 0

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal-panel modal-panel--wide"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tiledb-detail-title"
      >
        <div className="modal-head">
          <h2 id="tiledb-detail-title">Coordinate detail</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          <p className="modal-node-id-line">
            <strong>coordinate:</strong> <code className="modal-node-id-code">{coordKey}</code>
          </p>
          <p className="modal-doc-hint">
            Site summary and per-sample fields ({nSamples} sample row(s)). REF/ALT/GT/PL/GQ/DP come from the TileDB
            source row when present.
          </p>
          <pre className="modal-pre modal-pre--full-doc" key={coordKey}>
            {detail ? JSON.stringify(detail, null, 2) : '…'}
          </pre>
        </div>
        <div className="modal-actions">
          <button type="button" className="modal-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

type TileMatrixRow = {
  key: string
  chr: string
  pos: number
  bySample: Record<string, string>
}

type TileNormRow = {
  sid: string
  chr: string
  start: number
  end: number
  text: string
  hasAlt: boolean
  raw: Record<string, unknown>
}

type TileFilters = {
  chr: string
  start: number | ''
  end: number | ''
  sampleFilter: string
}

function tileFiltersEqual(a: TileFilters, b: TileFilters) {
  return a.chr === b.chr && a.start === b.start && a.end === b.end && a.sampleFilter === b.sampleFilter
}

function pickFirst(rec: Record<string, unknown>, names: string[]): unknown {
  for (const n of names) {
    if (n in rec) return rec[n]
  }
  return undefined
}

function gtToDisplay(gt: unknown): { text: string; hasAlt: boolean } {
  if (Array.isArray(gt)) {
    const vals = gt.map((x) => (x == null ? '.' : String(x)))
    const hasAlt = gt.some((x) => typeof x === 'number' && x > 0)
    return { text: vals.join('/'), hasAlt }
  }
  if (typeof gt === 'string') {
    const t = gt.trim()
    if (!t) return { text: '', hasAlt: false }
    const parts = t.split(/[\/|]/)
    const hasAlt = parts.some((p) => /^\d+$/.test(p) && Number(p) > 0)
    return { text: t, hasAlt }
  }
  return { text: '', hasAlt: false }
}

function formatCellValue(rec: Record<string, unknown>): { text: string; hasAlt: boolean } {
  const gt = pickFirst(rec, ['fmt_GT', 'GT', 'genotype', 'fmt_gt'])
  const parsed = gtToDisplay(gt)
  if (parsed.text) return parsed
  const alleles = pickFirst(rec, ['alleles', 'ALT', 'alt'])
  if (Array.isArray(alleles)) return { text: alleles.map((x) => String(x)).join('/'), hasAlt: false }
  return { text: '.', hasAlt: false }
}

function parseSampleList(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Stable cohort order; trim + dedupe so matrix headers match TileDB row `sample_name` keys. */
function normalizeCohortSampleIds(samples: Iterable<string>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of samples) {
    const id = String(s).trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  out.sort((a, b) => a.localeCompare(b))
  return out
}

function resolveTileSamples(allSamples: string[], sampleFilterText: string, observedSamples: Set<string>): string[] {
  const explicit = parseSampleList(sampleFilterText)
  if (explicit.length > 0) return normalizeCohortSampleIds(explicit)
  if (allSamples.length > 0) return normalizeCohortSampleIds(allSamples)
  return normalizeCohortSampleIds(observedSamples)
}

function normalizeTileRows(rows: Record<string, unknown>[]): { normalized: TileNormRow[]; observed: Set<string> } {
  const normalized: TileNormRow[] = []
  const observed = new Set<string>()
  for (const raw of rows) {
    const rec = raw as Record<string, unknown>
    const sidVal = pickFirst(rec, ['sample_name', 'sample', 'sample_id', 'sampleName'])
    const sid = sidVal == null ? '' : String(sidVal).trim()
    if (!sid) continue
    observed.add(sid)
    const chrVal = pickFirst(rec, ['contig', 'chrom', 'chr', 'CHROM'])
    const posVal = pickFirst(rec, ['pos_start', 'pos', 'POS', 'start', 'position', 'posStart'])
    const endVal = pickFirst(rec, ['pos_end', 'END', 'end', 'stop', 'posEnd'])
    const chr = chrVal == null ? '?' : String(chrVal)
    const start = Number(posVal)
    if (!Number.isFinite(start)) continue
    const endRaw = Number(endVal)
    const end = Number.isFinite(endRaw) ? endRaw : start
    const cell = formatCellValue(rec)
    normalized.push({ sid, chr, start, end, text: cell.text, hasAlt: cell.hasAlt, raw: rec })
  }
  return { normalized, observed }
}

function buildTileMatrix(
  rows: Record<string, unknown>[],
  allSamples: string[],
  sampleFilterText: string,
): { samples: string[]; rows: TileMatrixRow[] } {
  const { normalized, observed } = normalizeTileRows(rows)
  const carrierCoords = new Map<string, { chr: string; pos: number }>()
  for (const r of normalized) {
    if (r.hasAlt) {
      carrierCoords.set(`${r.chr}:${r.start}`, { chr: r.chr, pos: r.start })
    }
  }
  const samples = resolveTileSamples(allSamples, sampleFilterText, observed)
  const coords = carrierCoords.size
    ? [...carrierCoords.values()]
    : normalized.map((r) => ({ chr: r.chr, pos: r.start }))
  const coordMap = new Map<string, TileMatrixRow>()
  for (const c of coords) {
    const key = `${c.chr}:${c.pos}`
    if (!coordMap.has(key)) coordMap.set(key, { key, chr: c.chr, pos: c.pos, bySample: {} })
  }
  for (const r of normalized) {
    for (const row of coordMap.values()) {
      if (row.chr === r.chr && r.start <= row.pos && row.pos <= r.end) {
        row.bySample[r.sid] = r.text
      }
    }
  }
  const rowList = [...coordMap.values()].sort((a, b) => {
    const c = a.chr.localeCompare(b.chr)
    if (c !== 0) return c
    return a.pos - b.pos
  })
  return { samples, rows: rowList }
}

function symbolicAllele(a: unknown): boolean {
  const s = String(a)
  return s === '<*>' || (s.startsWith('<') && s.endsWith('>'))
}

function allelesToRefAlt(alleles: unknown): { REF: string | null; ALT: unknown[] } {
  if (!Array.isArray(alleles) || alleles.length === 0) return { REF: null, ALT: [] }
  const REF = alleles[0] == null ? null : String(alleles[0])
  const ALT = alleles.slice(1).filter((a) => !symbolicAllele(a))
  return { REF, ALT }
}

function pickSiteAlleles(normalized: TileNormRow[], chr: string, pos: number): { REF: string | null; ALT: unknown[] } {
  const variantAtPos = normalized.filter((r) => r.chr === chr && r.start === pos && r.hasAlt)
  const pool =
    variantAtPos.length > 0
      ? variantAtPos
      : normalized.filter((r) => r.chr === chr && r.start <= pos && pos <= r.end && r.hasAlt)
  if (pool.length === 0) {
    const refRows = normalized.filter((r) => r.chr === chr && r.start <= pos && pos <= r.end)
    if (refRows.length === 0) return { REF: null, ALT: [] }
    refRows.sort((a, b) => a.end - a.start - (b.end - b.start))
    const alleles = pickFirst(refRows[0].raw, ['alleles'])
    return allelesToRefAlt(alleles)
  }
  pool.sort((a, b) => {
    const d = b.end - b.start - (a.end - a.start)
    return d !== 0 ? d : b.start - a.start
  })
  const alleles = pickFirst(pool[0].raw, ['alleles'])
  return allelesToRefAlt(alleles)
}

function parseGtIndices(gt: unknown): number[] | null {
  if (gt == null) return null
  if (Array.isArray(gt)) {
    const out: number[] = []
    for (const x of gt) {
      if (x === '.' || x === null || x === undefined) return null
      const n = Number(x)
      if (!Number.isFinite(n) || n < 0) return null
      out.push(n)
    }
    return out
  }
  if (typeof gt === 'string') {
    const t = gt.trim()
    if (!t || t === './.' || /^\.\/\.$/.test(t)) return null
    const parts = t.split(/[\/|]/)
    const out: number[] = []
    for (const p of parts) {
      const n = Number(p)
      if (!Number.isFinite(n) || n < 0) return null
      out.push(n)
    }
    return out
  }
  return null
}

function genotypeClass(gt: number[] | null): 'missing' | 'hom_ref' | 'het' | 'hom_alt' {
  if (!gt || gt.length === 0) return 'missing'
  const hasRef = gt.some((i) => i === 0)
  const hasAlt = gt.some((i) => i > 0)
  if (!hasAlt && hasRef) return 'hom_ref'
  if (hasAlt && !hasRef) return 'hom_alt'
  if (hasAlt && hasRef) return 'het'
  return 'missing'
}

function altAlleleCopies(gt: number[] | null): number {
  if (!gt) return 0
  let c = 0
  for (const idx of gt) {
    if (typeof idx === 'number' && idx > 0) c++
  }
  return c
}

function calledPloidy(gt: number[] | null): number {
  if (!gt || gt.some((i) => !Number.isFinite(i) || i < 0)) return 0
  return gt.length
}

type CoordDetailMeta = {
  reference_build: string | null
  vcf_caller_info: string | null
}

type FilterFlag =
  | 'PASS'
  | 'NO_ALT'
  | 'LOW_CALL_RATE'
  | 'LOW_GQ'
  | 'LOW_DP'
  | 'LOW_ALT_SUPPORT'
  | 'VAF_OUTLIER'
  | 'LOW_QUAL'
  | 'COMPLEX_SITE'

type FilterSummary = {
  AC: number
  call_rate: number | null
  mean_gq: number | null
  mean_dp: number | null
  n_alt_supporting_samples: number
  n_vaf_outlier_samples: number
  site_qual: number | null
  is_complex_site: boolean
}

function assignFilterFlags(summary: FilterSummary): FilterFlag[] {
  const filters: FilterFlag[] = []
  if (summary.AC === 0) filters.push('NO_ALT')
  if (summary.call_rate != null && summary.call_rate < 0.8) filters.push('LOW_CALL_RATE')
  if (summary.mean_gq != null && summary.mean_gq < 20) filters.push('LOW_GQ')
  if (summary.mean_dp != null && summary.mean_dp < 10) filters.push('LOW_DP')
  if (summary.n_alt_supporting_samples < 1) filters.push('LOW_ALT_SUPPORT')
  if (summary.n_vaf_outlier_samples > 0) filters.push('VAF_OUTLIER')
  if (summary.site_qual != null && summary.site_qual < 20) filters.push('LOW_QUAL')
  if (summary.is_complex_site) filters.push('COMPLEX_SITE')
  if (filters.length === 0) filters.push('PASS')
  return filters
}

function buildCoordinateDetailPayload(
  coordKey: string,
  rows: Record<string, unknown>[],
  allSamples: string[],
  sampleFilterText: string,
  meta: CoordDetailMeta,
): Record<string, unknown> | null {
  const { normalized, observed } = normalizeTileRows(rows)
  const samples = resolveTileSamples(allSamples, sampleFilterText, observed)
  const [chr, posS] = coordKey.split(':')
  const pos = Number(posS)
  if (!chr || !Number.isFinite(pos)) return null

  const site = pickSiteAlleles(normalized, chr, pos)
  const altStr =
    site.ALT.length === 0 ? null : site.ALT.length === 1 ? String(site.ALT[0]) : site.ALT.map((a) => String(a)).join(',')

  const sampleRows: Record<string, unknown>[] = []
  let nMissing = 0
  let nHomRef = 0
  let nHet = 0
  let nHomAlt = 0
  let ac = 0
  let an = 0
  let sumDp = 0
  let sumGq = 0
  let nDp = 0
  let nGq = 0
  let nAltSupportingSamples = 0
  let nVafOutlierSamples = 0
  let sumSiteQual = 0
  let nSiteQual = 0

  for (const sid of samples) {
    const cands = normalized.filter((r) => r.sid === sid && r.chr === chr && r.start <= pos && pos <= r.end)
    if (cands.length === 0) {
      nMissing++
      sampleRows.push({
        sample_name: sid,
        contig: chr,
        pos_start: pos,
        pos_end: pos,
        REF: site.REF,
        ALT: site.ALT,
        GT: ['./.'],
        GQ: null,
        DP: null,
        MIN_DP: null,
        AD: null,
        VAF: null,
        PL: null,
        GL: null,
        FILTER: null,
        QUAL: null,
        source_type: 'no_call',
        source_record_start: null,
        source_record_end: null,
        caller_version_config: meta.vcf_caller_info,
        reference_build: meta.reference_build,
      })
      continue
    }
    cands.sort((a, b) => {
      const scoreA = (a.hasAlt ? 4 : 0) + (a.start === pos ? 2 : 0) - (a.end - a.start) / 1_000_000
      const scoreB = (b.hasAlt ? 4 : 0) + (b.start === pos ? 2 : 0) - (b.end - b.start) / 1_000_000
      return scoreB - scoreA
    })
    const best = cands[0]
    const src = best.raw
    const srcPosRaw = pickFirst(src, ['pos_start', 'pos', 'POS', 'start'])
    const srcEndRaw = pickFirst(src, ['pos_end', 'END', 'end', 'stop', 'posEnd'])
    const ps = Number(srcPosRaw)
    const pe = Number(srcEndRaw)
    const alleles = pickFirst(src, ['alleles'])
    const ra = allelesToRefAlt(alleles)
    const gtRaw = pickFirst(src, ['fmt_GT', 'GT'])
    const pl = pickFirst(src, ['fmt_PL', 'PL'])
    const gl = pickFirst(src, ['fmt_GL', 'GL'])
    const st: 'explicit_variant_row' | 'reference_block' = best.hasAlt ? 'explicit_variant_row' : 'reference_block'

    const gtIdx = parseGtIndices(gtRaw)
    const cls = genotypeClass(gtIdx)
    if (cls === 'missing') nMissing++
    else if (cls === 'hom_ref') nHomRef++
    else if (cls === 'het') nHet++
    else nHomAlt++

    ac += altAlleleCopies(gtIdx)
    an += calledPloidy(gtIdx)

    const gqRaw = pickFirst(src, ['fmt_GQ', 'GQ'])
    const dpRaw = pickFirst(src, ['fmt_DP', 'DP'])
    const minDpRaw = pickFirst(src, ['fmt_MIN_DP', 'MIN_DP'])
    const qualRaw = pickFirst(src, ['qual', 'QUAL'])
    if (qualRaw != null && Number.isFinite(Number(qualRaw))) {
      sumSiteQual += Number(qualRaw)
      nSiteQual++
    }
    if (gqRaw != null && Number.isFinite(Number(gqRaw))) {
      sumGq += Number(gqRaw)
      nGq++
    }
    const covRaw = dpRaw ?? minDpRaw
    if (covRaw != null && Number.isFinite(Number(covRaw))) {
      sumDp += Number(covRaw)
      nDp++
    }
    if (cls === 'het' || cls === 'hom_alt') nAltSupportingSamples++

    const vafRaw = pickFirst(src, ['fmt_VAF', 'VAF'])
    const vafFirst = Array.isArray(vafRaw) && vafRaw.length > 0 ? Number(vafRaw[0]) : Number(vafRaw)
    if (Number.isFinite(vafFirst)) {
      if ((cls === 'hom_ref' && vafFirst > 0.2) || (cls === 'het' && (vafFirst < 0.2 || vafFirst > 0.8)) || (cls === 'hom_alt' && vafFirst < 0.8)) {
        nVafOutlierSamples++
      }
    }

    sampleRows.push({
      sample_name: pickFirst(src, ['sample_name', 'sample', 'sample_id', 'sampleName']) ?? sid,
      contig: pickFirst(src, ['contig', 'chrom', 'chr', 'CHROM']) ?? chr,
      pos_start: Number.isFinite(ps) ? ps : pos,
      pos_end: Number.isFinite(pe) ? pe : pos,
      REF: ra.REF,
      ALT: ra.ALT,
      GT: gtRaw ?? null,
      GQ: gqRaw ?? null,
      DP: dpRaw ?? null,
      MIN_DP: minDpRaw ?? null,
      AD: pickFirst(src, ['fmt_AD', 'AD']) ?? null,
      VAF: pickFirst(src, ['fmt_VAF', 'VAF']) ?? null,
      PL: pl ?? null,
      GL: gl ?? null,
      FILTER: pickFirst(src, ['filters', 'FILTER', 'filter_ids']) ?? null,
      QUAL: pickFirst(src, ['qual', 'QUAL']) ?? null,
      source_type: st,
      source_record_start: best.start,
      source_record_end: best.end,
      caller_version_config: meta.vcf_caller_info,
      reference_build: meta.reference_build,
    })
  }

  const af = an > 0 ? ac / an : null
  const meanDp = nDp > 0 ? sumDp / nDp : null
  const meanGq = nGq > 0 ? sumGq / nGq : null
  const meanSiteQual = nSiteQual > 0 ? sumSiteQual / nSiteQual : null
  const denom = samples.length
  const callRate = denom > 0 ? (denom - nMissing) / denom : null
  const filterFlags = assignFilterFlags({
    AC: ac,
    call_rate: callRate,
    mean_gq: meanGq,
    mean_dp: meanDp,
    n_alt_supporting_samples: nAltSupportingSamples,
    n_vaf_outlier_samples: nVafOutlierSamples,
    site_qual: meanSiteQual,
    is_complex_site: site.ALT.length > 1,
  })

  return {
    contig: chr,
    pos,
    ref: site.REF,
    alt: altStr,
    alt_alleles: site.ALT,
    AC: ac,
    AN: an,
    AF: af,
    n_het: nHet,
    n_hom_alt: nHomAlt,
    n_hom_ref: nHomRef,
    n_missing: nMissing,
    call_rate: callRate,
    mean_dp: meanDp,
    mean_gq: meanGq,
    n_alt_supporting_samples: nAltSupportingSamples,
    mean_site_qual: meanSiteQual,
    n_vaf_outlier_samples: nVafOutlierSamples,
    filter_flags: filterFlags,
    samples: sampleRows,
    reference_build: meta.reference_build,
    caller_version_config: meta.vcf_caller_info,
  }
}

function App() {
  const [draft, setDraft] = useState<TileFilters>({
    chr: 'chr21',
    start: 33000000,
    end: 33000500,
    sampleFilter: '',
  })
  const [active, setActive] = useState<TileFilters>(() => ({ ...draft }))
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(500)
  const [pageJump, setPageJump] = useState('1')
  const [tiledbQueryNonce, setTiledbQueryNonce] = useState(0)
  const [tileDetailCoord, setTileDetailCoord] = useState<string | null>(null)

  const tiledbHealthQuery = useQuery({
    queryKey: ['tiledb-health'],
    queryFn: fetchTileDBHealth,
  })

  const tiledbSamplesQuery = useQuery({
    queryKey: ['tiledb-samples'],
    queryFn: fetchTileDBSamples,
    enabled: Boolean(tiledbHealthQuery.data?.ready),
  })

  const tiledbQuery = useQuery({
    queryKey: [
      'tiledb-query',
      active.chr,
      active.start,
      active.end,
      active.sampleFilter,
      tiledbQueryNonce,
    ],
    queryFn: () =>
      fetchTileDBQuery({
        regions:
          active.start === '' && active.end === ''
            ? active.chr
            : `${active.chr}:${active.start === '' ? 1 : Number(active.start)}-${active.end === '' ? '' : Number(active.end)}`,
        samples: active.sampleFilter.trim() || undefined,
      }),
    enabled: tiledbQueryNonce > 0,
  })

  const tileMatrix = useMemo(
    () => buildTileMatrix(tiledbQuery.data?.rows ?? [], tiledbSamplesQuery.data ?? [], active.sampleFilter),
    [tiledbQuery.data?.rows, tiledbSamplesQuery.data, active.sampleFilter],
  )
  const totalPages = tileMatrix.rows.length > 0 ? Math.ceil(tileMatrix.rows.length / pageSize) : 1
  const pageClamped = Math.min(totalPages, Math.max(1, page))
  const pagedRows = useMemo(() => {
    const startIdx = (pageClamped - 1) * pageSize
    return tileMatrix.rows.slice(startIdx, startIdx + pageSize)
  }, [tileMatrix.rows, pageClamped, pageSize])
  useEffect(() => {
    setPage(1)
  }, [pageSize, active.chr, active.start, active.end, active.sampleFilter, tiledbQuery.dataUpdatedAt])
  useEffect(() => {
    setPageJump(String(pageClamped))
  }, [pageClamped])
  const filtersDirty = !tileFiltersEqual(draft, active)
  const applyFilters = () => {
    setActive({ ...draft })
    setPage(1)
    setTiledbQueryNonce((n) => n + 1)
  }
  const applyPageJump = () => {
    const n = parseInt(pageJump, 10)
    if (Number.isNaN(n)) return
    setPage(Math.min(totalPages, Math.max(1, n)))
  }

  const tileDetailPayload = useMemo(
    () =>
      tileDetailCoord
        ? buildCoordinateDetailPayload(
            tileDetailCoord,
            tiledbQuery.data?.rows ?? [],
            tiledbSamplesQuery.data ?? [],
            active.sampleFilter,
            {
              reference_build: tiledbHealthQuery.data?.reference_build ?? null,
              vcf_caller_info: tiledbHealthQuery.data?.vcf_caller_info ?? null,
            },
          )
        : null,
    [
      tileDetailCoord,
      tiledbQuery.data?.rows,
      tiledbSamplesQuery.data,
      active.sampleFilter,
      tiledbHealthQuery.data?.reference_build,
      tiledbHealthQuery.data?.vcf_caller_info,
    ],
  )

  return (
    <div className="app">
      <header className="top">
        <div className="crumb">Home &gt; Genotype Explorer</div>
        <h1>Genotype Explorer</h1>
        <p className="sub">Query and browse cohort variants directly from TileDB-VCF.</p>
      </header>

      <div className="layout">
        <aside className="panel">
          <h2>TileDB VCF</h2>
          <label>
            Chromosome
            <input
              value={draft.chr}
              onChange={(e) => setDraft((d) => ({ ...d, chr: e.target.value }))}
              placeholder="chr21"
            />
          </label>
          <label>
            Start (1-based)
            <input
              type="number"
              value={draft.start}
              onChange={(e) =>
                setDraft((d) => ({ ...d, start: e.target.value === '' ? '' : Number(e.target.value) }))
              }
            />
          </label>
          <label>
            Stop (1-based)
            <input
              type="number"
              value={draft.end}
              onChange={(e) =>
                setDraft((d) => ({ ...d, end: e.target.value === '' ? '' : Number(e.target.value) }))
              }
            />
          </label>
          <label>
            Samples (comma-separated, optional)
            <input
              value={draft.sampleFilter}
              onChange={(e) => setDraft((d) => ({ ...d, sampleFilter: e.target.value }))}
              placeholder="NWD210828,NWD286130"
            />
          </label>
          <label>
            Rows per page
            <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
              {[100, 200, 500, 1000, 2000].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          {filtersDirty && (
            <p className="warn">Filters changed - click <strong>Apply</strong> to refresh TileDB results.</p>
          )}
          <div className="actions">
            <button type="button" onClick={applyFilters}>
              Apply
            </button>
            <button type="button" onClick={() => void tiledbHealthQuery.refetch()}>
              Refresh TileDB Status
            </button>
          </div>
          <div className="pager">
            <button type="button" disabled={pageClamped <= 1} onClick={() => setPage(1)}>
              First
            </button>
            <button type="button" disabled={pageClamped <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              Prev
            </button>
            <button
              type="button"
              disabled={pageClamped >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </button>
            <button type="button" disabled={pageClamped >= totalPages} onClick={() => setPage(totalPages)}>
              Last
            </button>
            <label>
              Page
              <input
                className="page-jump-input"
                type="number"
                min={1}
                max={totalPages}
                value={pageJump}
                onChange={(e) => setPageJump(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applyPageJump()
                }}
              />
            </label>
            <button type="button" className="pager-go" onClick={applyPageJump}>
              Go
            </button>
            <span className="pager-summary">
              Page {pageClamped} of {totalPages}
              {tileMatrix.rows.length > 0 ? ` · ${tileMatrix.rows.length.toLocaleString()} coordinates` : ''}
            </span>
          </div>
          {tiledbHealthQuery.error && <p className="error">{(tiledbHealthQuery.error as Error).message}</p>}
        </aside>

        <main className="main main--grid">
          <section className="tiledb-card">
            <h3>TileDB Browser</h3>
            {tiledbHealthQuery.isLoading && <p className="muted">Checking TileDB status…</p>}
            {tiledbHealthQuery.data && (
              <p className="muted">
                {tiledbHealthQuery.data.ready ? 'Ready' : 'Not ready'} · URI:{' '}
                <code>{tiledbHealthQuery.data.uri ?? '(not set)'}</code>
                {typeof tiledbHealthQuery.data.sample_count === 'number'
                  ? ` · samples ${tiledbHealthQuery.data.sample_count}`
                  : ''}
              </p>
            )}
            {tiledbSamplesQuery.data && tiledbSamplesQuery.data.length > 0 && (
              <p className="muted">
                Sample preview: {tiledbSamplesQuery.data.slice(0, 8).join(', ')}
                {tiledbSamplesQuery.data.length > 8 ? ' …' : ''}
              </p>
            )}
            {tiledbQuery.isFetching && <p className="muted">Running TileDB query…</p>}
            {tiledbQuery.error && <p className="error">{(tiledbQuery.error as Error).message}</p>}
            {tiledbQuery.data && (
              <>
                <p className="muted">
                  Returned {tiledbQuery.data.row_count.toLocaleString()} row(s)
                  {tiledbQuery.data.complete ? '' : ' (truncated by max_rows)'}.
                  {!tiledbQuery.data.complete &&
                    ' Some cohort samples may have no rows in this batch — empty cells show as ".".'}
                </p>
                {pagedRows.length > 0 && tileMatrix.samples.length > 0 && (
                  <div className="tiledb-matrix-wrap">
                    <table className="tiledb-matrix">
                      <thead>
                        <tr>
                          <th>Coordinate</th>
                          {tileMatrix.samples.map((sid) => (
                            <th key={sid}>{sid}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {pagedRows.map((r) => (
                          <tr key={r.key}>
                            <td>
                              <button
                                type="button"
                                className="coord-link"
                                onClick={() => setTileDetailCoord(r.key)}
                              >
                                {r.key}
                              </button>
                            </td>
                            {tileMatrix.samples.map((sid) => (
                              <td key={`${r.key}:${sid}`}>{r.bySample[sid] ?? '.'}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {tileMatrix.rows.length === 0 && <p className="empty">No rows returned for this region.</p>}
              </>
            )}
          </section>
        </main>
      </div>

      <TileCoordDetailModal
        coordKey={tileDetailCoord}
        detail={tileDetailPayload}
        onClose={() => setTileDetailCoord(null)}
      />
    </div>
  )
}

export default App
