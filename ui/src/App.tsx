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
  records,
  onClose,
}: {
  coordKey: string | null
  records: Record<string, unknown>[]
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
          <h2 id="tiledb-detail-title">TileDB rows by coordinate</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          <p className="modal-node-id-line">
            <strong>coordinate:</strong> <code className="modal-node-id-code">{coordKey}</code>
          </p>
          <p className="modal-doc-hint">
            Full TileDB row objects for this coordinate ({records.length} record(s)).
          </p>
          <pre className="modal-pre modal-pre--full-doc">{JSON.stringify(records, null, 2)}</pre>
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

function resolveTileSamples(allSamples: string[], sampleFilterText: string, observedSamples: Set<string>): string[] {
  const explicit = parseSampleList(sampleFilterText)
  if (explicit.length > 0) return explicit
  if (allSamples.length > 0) return [...allSamples].sort((a, b) => a.localeCompare(b))
  return [...observedSamples].sort((a, b) => a.localeCompare(b))
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

function buildTileCoordExpanded(
  coordKey: string,
  rows: Record<string, unknown>[],
  allSamples: string[],
  sampleFilterText: string,
): Record<string, unknown>[] {
  const { normalized, observed } = normalizeTileRows(rows)
  const samples = resolveTileSamples(allSamples, sampleFilterText, observed)
  const [chr, posS] = coordKey.split(':')
  const pos = Number(posS)
  if (!chr || !Number.isFinite(pos)) return []

  const out: Record<string, unknown>[] = []
  for (const sid of samples) {
    const cands = normalized.filter((r) => r.sid === sid && r.chr === chr && r.start <= pos && pos <= r.end)
    if (cands.length === 0) {
      out.push({
        sample_name: sid,
        contig: chr,
        pos_start: pos,
        fmt_GT: ['./.'],
        genotype_display: './.',
        genotype_quality: '',
        coverage: 0,
        coverage_field: '',
        non_carrier_fill: 'NO_EXPLICIT_ROW',
      })
      continue
    }
    cands.sort((a, b) => {
      const scoreA = (a.hasAlt ? 4 : 0) + (a.start === pos ? 2 : 0) - (a.end - a.start) / 1_000_000
      const scoreB = (b.hasAlt ? 4 : 0) + (b.start === pos ? 2 : 0) - (b.end - b.start) / 1_000_000
      return scoreB - scoreA
    })
    const best = cands[0]
    const gqRaw = pickFirst(best.raw, ['fmt_GQ', 'GQ'])
    const dpRaw = pickFirst(best.raw, ['fmt_DP', 'DP'])
    const minDpRaw = pickFirst(best.raw, ['fmt_MIN_DP', 'MIN_DP'])
    const covRaw = dpRaw ?? minDpRaw
    const covN = Number(covRaw)
    out.push({
      sample_name: sid,
      contig: chr,
      pos_start: pos,
      fmt_GT: pickFirst(best.raw, ['fmt_GT', 'GT']) ?? [],
      genotype_display: best.text || '.',
      genotype_quality: gqRaw == null ? '' : String(gqRaw),
      coverage: Number.isFinite(covN) ? covN : 0,
      coverage_field: dpRaw != null ? 'fmt_DP' : minDpRaw != null ? 'fmt_MIN_DP' : '',
      non_carrier_fill: best.hasAlt ? 'explicit_variant_row' : 'filled_from_reference_block',
      source_record_start: best.start,
      source_record_end: best.end,
      source_record: best.raw,
    })
  }
  return out
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

  const tileDetailRecords = useMemo(
    () =>
      tileDetailCoord
        ? buildTileCoordExpanded(
            tileDetailCoord,
            tiledbQuery.data?.rows ?? [],
            tiledbSamplesQuery.data ?? [],
            active.sampleFilter,
          )
        : [],
    [tileDetailCoord, tiledbQuery.data?.rows, tiledbSamplesQuery.data, active.sampleFilter],
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
        records={tileDetailRecords}
        onClose={() => setTileDetailCoord(null)}
      />
    </div>
  )
}

export default App
