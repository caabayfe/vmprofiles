import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { T } from '@nttdsp/react-components'

// The platform injects <base href="/l/yarp/<env>/<space>/vm-profiles/">;
// everything the portal menu links to must be portal-absolute.
export const BASE = new URL(document.baseURI).pathname.replace(/\/$/, '')

export interface Crumb {
  name: string
  link?: string
}

interface MenuItem {
  name: string
  link?: string
  menu_items?: MenuItem[]
}

declare global {
  interface Window {
    INSIGHT_MENU?: {
      breadcrumbs?: { set?: (crumbs: Crumb[]) => void }
      sidemenu?: {
        set?: (items: MenuItem[], options?: { hashRouting?: boolean; manual?: boolean }) => void
        onClick?: (e: Event, context: MenuItem) => void
      }
    }
  }
}

const abs = (path: string) => `${BASE}${path}`

export function initSideMenu() {
  window.INSIGHT_MENU?.sidemenu?.set?.([
    { name: T.APP_NAME, link: abs('/') },
    {
      name: T.MENU_REQUESTS,
      menu_items: [
        { name: T.MENU_NEW_REQUEST, link: abs('/requests/new') },
        { name: T.MENU_MY_REQUESTS, link: abs('/requests') },
        { name: T.MENU_PENDING, link: abs('/requests/pending') },
      ],
    },
    { name: T.MENU_PROFILES, link: abs('/profiles') },
    {
      name: T.MENU_CATALOG,
      menu_items: [
        { name: T.MENU_OS, link: abs('/catalog/operating-systems') },
        { name: T.MENU_SOFTWARE, link: abs('/catalog/software') },
        { name: T.MENU_ROLES, link: abs('/catalog/roles') },
        { name: T.MENU_SIZES, link: abs('/catalog/sizes') },
      ],
    },
    { name: T.MENU_INFRA, link: abs('/infrastructure') },
    {
      name: T.MENU_ADMIN,
      menu_items: [
        { name: T.MENU_ACCESS, link: abs('/admin/access') },
        { name: T.MENU_AUDIT, link: abs('/admin/audit') },
      ],
    },
  ])
}

/** Route side-menu clicks through react-router (strip the base back off). */
export function useSideMenuRouting() {
  const navigate = useNavigate()
  useEffect(() => {
    const menu = window.INSIGHT_MENU?.sidemenu
    if (!menu) return
    menu.onClick = (e, context) => {
      if (!context.link) return
      e.preventDefault()
      navigate(context.link.startsWith(BASE) ? context.link.slice(BASE.length) || '/' : context.link)
    }
  }, [navigate])
}

/** Breadcrumbs: Function name first; every item but the leaf carries a link. */
export function useBreadcrumbs(crumbs: Crumb[]) {
  const key = JSON.stringify(crumbs)
  useEffect(() => {
    const items: Crumb[] = [{ name: T.APP_NAME, link: abs('/') }, ...crumbs].map((c, i, all) =>
      i === all.length - 1 ? { name: c.name } : { name: c.name, link: c.link ? abs(c.link) : undefined },
    )
    window.INSIGHT_MENU?.breadcrumbs?.set?.(items)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}
