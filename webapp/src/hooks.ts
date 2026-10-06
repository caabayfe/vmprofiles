import { useQuery } from '@tanstack/react-query'
import { api, type UUID } from './api'
import type { CompanyType, LookupsType, MeType } from './types'

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api.get<MeType>('/me') })

export const useCompanies = (enabled = true) =>
  useQuery({ queryKey: ['companies'], queryFn: () => api.get<CompanyType[]>('/companies'), enabled })

export const useLookups = (companyId: UUID | null, enabled = true) =>
  useQuery({
    queryKey: ['lookups', companyId ?? 'global'],
    queryFn: () => api.get<LookupsType>('/lookups', { company_id: companyId }),
    enabled,
  })

/** Companies the caller can create/manage items for (null = global). */
export function manageableScopes(me: MeType | undefined, companies: CompanyType[] | undefined) {
  if (!me) return { allowGlobal: false, companies: [] as { id: UUID; name: string }[] }
  if (me.is_global_admin) return { allowGlobal: true, companies: companies ?? [] }
  return { allowGlobal: false, companies: me.companies.filter((c) => c.role === 'company_admin') }
}

export function canManage(me: MeType | undefined, companyId: UUID | null | undefined): boolean {
  if (!me) return false
  if (me.is_global_admin) return true
  return !!companyId && me.companies.some((c) => c.id === companyId && c.role === 'company_admin')
}
