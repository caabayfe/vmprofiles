// API client. `shortUrl: true` mounts the SPA at the app root, so the API is
// the sibling `api` path regardless of env / space / current route.
const apiBase = import.meta.env.DEV ? 'http://localhost:8000' : 'api'

export type UUID = string

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

type Params = Record<string, string | number | boolean | null | undefined>

function qs(params?: Params): string {
  if (!params) return ''
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

async function http<R>(method: string, path: string, body?: unknown, params?: Params): Promise<R> {
  const r = await fetch(`${apiBase}${path}${qs(params)}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!r.ok) {
    let detail = r.statusText
    try {
      const j = await r.json()
      detail = formatDetail(j.detail) || detail
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(r.status, detail)
  }
  if (r.status === 204) return undefined as R
  return r.json() as Promise<R>
}

function formatDetail(detail: unknown): string {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    // FastAPI validation errors: [{loc: [...], msg}]
    return detail
      .map((d: { loc?: unknown[]; msg?: string }) => `${(d.loc ?? []).slice(1).join('.')}: ${d.msg ?? ''}`)
      .join('\n')
  }
  return ''
}

export const api = {
  get: <R>(path: string, params?: Params) => http<R>('GET', path, undefined, params),
  post: <R>(path: string, body?: unknown) => http<R>('POST', path, body ?? {}),
  put: <R>(path: string, body: unknown) => http<R>('PUT', path, body),
  del: (path: string) => http<void>('DELETE', path),
}

// Digital Fabric directory — same-origin portal APIs, the session cookie
// rides along (yarp_guide_get("digital-fabric-data")).
export interface DfCompany {
  id: UUID
  name: string
  code?: string
  status?: string
}
export interface DfUser {
  id: UUID
  lifecycleStatus?: string
  serviceAccount?: boolean
  profile?: { name?: string; jobTitle?: string }
  identity?: { email?: string; interactionStatus?: string }
}

async function df<R>(url: string): Promise<R> {
  const r = await fetch(url, { credentials: 'same-origin' })
  if (!r.ok) throw new ApiError(r.status, `directory lookup failed (${r.status})`)
  return r.json() as Promise<R>
}

export async function searchCompanies(term: string): Promise<DfCompany[]> {
  const t = term.trim().toLowerCase().replace(/'/g, "''")
  if (!t) return []
  const filter = `( status eq 'Active' ) and ( contains(tolower(name), '${t}') )`
  const { value } = await df<{ value: DfCompany[] }>(
    `/l/api/operator/dart/companies?$top=20&$filter=${encodeURIComponent(filter)}`,
  )
  return value.filter((c) => c.status === undefined || c.status === 'Active')
}

export async function searchUsers(term: string): Promise<DfUser[]> {
  const t = term.trim()
  if (!t) return []
  const { value } = await df<{ value: DfUser[] }>(`/l/api/client/dart/users?$top=20&$search=${encodeURIComponent(t)}`)
  return value.filter(
    (u) =>
      u.lifecycleStatus === 'Active' &&
      !u.serviceAccount &&
      (u.identity?.interactionStatus === undefined || u.identity.interactionStatus === 'Enabled'),
  )
}
