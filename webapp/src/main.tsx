import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ServicesPortalProvider } from '@nttdsp/react-components'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './translations'
import './styles.css'
import { BASE, initSideMenu } from './portal'
import { App } from './App'

// Side menu as early as possible (before React mounts) to minimise the
// sidebar force-open flash — see yarp_guide_get("frontend") §8.
initSideMenu()

// ServicesPortalProvider remounts the tree on every pathname change, so all
// server data goes through react-query to render instantly from cache.
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ServicesPortalProvider team="vm-profiles" routerProps={{ basename: BASE }}>
        <App />
      </ServicesPortalProvider>
    </QueryClientProvider>
  </StrictMode>,
)
