import type { ReactNode } from 'react'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import { Spinner, Title, T } from '@nttdsp/react-components'
import { useMe } from './hooks'
import { useBreadcrumbs, useSideMenuRouting } from './portal'
import { AccessPage, AuditPage } from './pages/AdminPages'
import { CatalogPage } from './pages/CatalogPage'
import { VcenterDetailPage, VcentersPage } from './pages/InfrastructurePages'
import { ProfileEditor } from './pages/ProfileEditor'
import { ProfilesPage } from './pages/ProfilesPage'
import { NewRequestPage, RequestDetailPage, RequestsPage } from './pages/RequestsPages'

function Message({ title, body }: { title: string; body: string }) {
  useBreadcrumbs([{ name: title }])
  return (
    <div className="grid-container--fluid vp-page">
      <h1 className="main-heading no-margin sr-only">{title}</h1>
      <Title title={title} />
      <p>{body}</p>
    </div>
  )
}

/** Hides admin-only pages from requesters (the API enforces it regardless). */
function AdminOnly({ children }: { children: ReactNode }) {
  const { data: me } = useMe()
  return me?.is_admin ? <>{children}</> : <Message title={T.NO_PERMISSION_TITLE} body={T.NO_PERMISSION_BODY} />
}

function CatalogRoute() {
  const { kind } = useParams()
  return <CatalogPage key={kind} kind={kind ?? 'software'} />
}

export function App() {
  useSideMenuRouting()
  const { data: me, isLoading, error } = useMe()

  if (isLoading) return <Spinner />
  if (error || !me?.has_access) {
    return <Message title={T.NO_ACCESS_TITLE} body={T.NO_ACCESS_BODY} />
  }

  return (
    <Routes>
      <Route path="/" element={<Navigate to={me.is_admin ? '/profiles' : '/requests/new'} replace />} />
      <Route path="/profiles" element={<AdminOnly><ProfilesPage /></AdminOnly>} />
      <Route path="/profiles/new" element={<AdminOnly><ProfileEditor /></AdminOnly>} />
      <Route path="/profiles/:profileId" element={<AdminOnly><ProfileEditor /></AdminOnly>} />
      <Route path="/catalog/:kind" element={<AdminOnly><CatalogRoute /></AdminOnly>} />
      <Route path="/infrastructure" element={<AdminOnly><VcentersPage /></AdminOnly>} />
      <Route path="/infrastructure/:vcenterId" element={<AdminOnly><VcenterDetailPage /></AdminOnly>} />
      <Route path="/requests" element={<RequestsPage view="mine" />} />
      <Route path="/requests/pending" element={<AdminOnly><RequestsPage view="pending" /></AdminOnly>} />
      <Route path="/requests/all" element={<RequestsPage view="all" />} />
      <Route path="/requests/new" element={<NewRequestPage />} />
      <Route path="/requests/:requestId" element={<RequestDetailPage />} />
      <Route path="/admin/access" element={<AdminOnly><AccessPage /></AdminOnly>} />
      <Route path="/admin/audit" element={<AdminOnly><AuditPage /></AdminOnly>} />
      <Route path="*" element={<Message title={T.NOT_FOUND} body={T.NOT_FOUND_BODY} />} />
    </Routes>
  )
}
