export type TileDBHealth = {
  configured: boolean
  uri: string | null
  path_exists: boolean
  tiledbvcf_importable: boolean
  ready: boolean
  sample_count?: number
  error?: string
  reference_build?: string
  vcf_caller_info?: string
}

export type TileDBQueryResponse = {
  regions: string[]
  samples_filter: string[] | null
  row_count: number
  complete: boolean
  rows: Record<string, unknown>[]
}

const fetchOpts: RequestInit = { cache: 'no-store' }

export async function fetchTileDBHealth(): Promise<TileDBHealth> {
  const r = await fetch('/api/tiledb-vcf/health', fetchOpts)
  if (!r.ok) throw new Error(await r.text())
  return r.json() as Promise<TileDBHealth>
}

export async function fetchTileDBSamples(): Promise<string[]> {
  const r = await fetch('/api/tiledb-vcf/samples', fetchOpts)
  if (!r.ok) throw new Error(await r.text())
  const j = await r.json()
  return j.samples as string[]
}

export async function fetchTileDBQuery(params: {
  regions: string
  samples?: string
  max_rows?: number
}): Promise<TileDBQueryResponse> {
  const sp = new URLSearchParams()
  sp.set('regions', params.regions)
  if (params.samples) sp.set('samples', params.samples)
  if (params.max_rows != null) sp.set('max_rows', String(params.max_rows))
  const r = await fetch(`/api/tiledb-vcf/query?${sp.toString()}`, fetchOpts)
  if (!r.ok) throw new Error(await r.text())
  return r.json() as Promise<TileDBQueryResponse>
}
