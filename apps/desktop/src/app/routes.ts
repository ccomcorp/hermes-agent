import { atom } from 'nanostores'
import type { ReactNode } from 'react'

import { registry } from '@/contrib/registry'

export const SESSION_ROUTE_PREFIX = '/'
export const NEW_CHAT_ROUTE = '/'
export const SETTINGS_ROUTE = '/settings'
export const COMMAND_CENTER_ROUTE = '/command-center'
export const SKILLS_ROUTE = '/skills'
export const MESSAGING_ROUTE = '/messaging'
export const ARTIFACTS_ROUTE = '/artifacts'
export const CRON_ROUTE = '/cron'
export const PROFILES_ROUTE = '/profiles'
export const AGENTS_ROUTE = '/agents'
export const KANBAN_ROUTE = '/kanban'
export const CANVAS_ROUTE = '/canvas' // AIOS: hermes-canvas plugin tab
export const PAIRING_ROUTE = '/pairing'
export const WEBHOOKS_ROUTE = '/webhooks'
export const PLUGINS_ROUTE = '/plugins'
export const FILES_ROUTE = '/files'
export const CHANNELS_ROUTE = '/channels'
export const WORKBENCH_ROUTE = '/workbench'
export const SYSTEM_ROUTE = '/system'
// AIOS Track-B panels (Wave 2b)
export const CONFIG_ROUTE = '/config'
export const LOGS_ROUTE = '/logs'
export const MODELS_ROUTE = '/models'
export const STARMAP_ROUTE = '/starmap'
export const DOCOPS_ROUTE = '/docops'

export type AppView =
  | 'agents'
  | 'artifacts'
  | 'canvas'
  | 'channels'
  | 'chat'
  | 'command-center'
  | 'config'
  | 'cron'
  | 'docops'
  // A contributed (plugin) full page at its own route — NOT chat.
  | 'extension'
  | 'files'
  | 'kanban'
  | 'logs'
  | 'messaging'
  | 'models'
  | 'pairing'
  | 'plugins'
  | 'profiles'
  | 'settings'
  | 'skills'
  | 'system'
  | 'webhooks'
  | 'starmap'
  | 'workbench'

export type AppRouteId =
  | 'agents'
  | 'artifacts'
  | 'canvas'
  | 'channels'
  | 'command-center'
  | 'config'
  | 'cron'
  | 'docops'
  | 'files'
  | 'kanban'
  | 'logs'
  | 'messaging'
  | 'models'
  | 'new'
  | 'pairing'
  | 'plugins'
  | 'profiles'
  | 'settings'
  | 'skills'
  | 'system'
  | 'webhooks'
  | 'starmap'
  | 'workbench'

export interface AppRoute {
  id: AppRouteId
  path: string
  view: AppView
}

export const APP_ROUTES = [
  { id: 'new', path: NEW_CHAT_ROUTE, view: 'chat' },
  { id: 'settings', path: SETTINGS_ROUTE, view: 'settings' },
  { id: 'command-center', path: COMMAND_CENTER_ROUTE, view: 'command-center' },
  { id: 'skills', path: SKILLS_ROUTE, view: 'skills' },
  { id: 'messaging', path: MESSAGING_ROUTE, view: 'messaging' },
  { id: 'artifacts', path: ARTIFACTS_ROUTE, view: 'artifacts' },
  { id: 'cron', path: CRON_ROUTE, view: 'cron' },
  { id: 'kanban', path: KANBAN_ROUTE, view: 'kanban' },
  { id: 'canvas', path: CANVAS_ROUTE, view: 'canvas' }, // AIOS: hermes-canvas
  { id: 'profiles', path: PROFILES_ROUTE, view: 'profiles' },
  { id: 'agents', path: AGENTS_ROUTE, view: 'agents' },
  { id: 'pairing', path: PAIRING_ROUTE, view: 'pairing' },
  { id: 'webhooks', path: WEBHOOKS_ROUTE, view: 'webhooks' },
  { id: 'plugins', path: PLUGINS_ROUTE, view: 'plugins' },
  { id: 'files', path: FILES_ROUTE, view: 'files' },
  { id: 'channels', path: CHANNELS_ROUTE, view: 'channels' },
  { id: 'workbench', path: WORKBENCH_ROUTE, view: 'workbench' },
  { id: 'system', path: SYSTEM_ROUTE, view: 'system' },
  { id: 'config', path: CONFIG_ROUTE, view: 'config' },
  { id: 'logs', path: LOGS_ROUTE, view: 'logs' },
  { id: 'models', path: MODELS_ROUTE, view: 'models' },
  { id: 'starmap', path: STARMAP_ROUTE, view: 'starmap' },
  { id: 'docops', path: DOCOPS_ROUTE, view: 'docops' }
] as const satisfies readonly AppRoute[]

const APP_VIEW_BY_PATH = new Map<string, AppView>(APP_ROUTES.map(route => [route.path, route.view]))
const RESERVED_PATHS: ReadonlySet<string> = new Set(APP_ROUTES.map(route => route.path))

// ── Contributed routes — the `routes` registry area ─────────────────────────
export const ROUTES_AREA = 'routes'

export interface RouteContribution {
  path: string
}

export function contributedRoutes(): Array<{ key: string; path: string; title?: string; render: () => ReactNode }> {
  return registry
    .getArea(ROUTES_AREA)
    .map(c => ({
      key: `${c.source ?? 'core'}:${c.id}`,
      path: (c.data as RouteContribution | undefined)?.path ?? '',
      title: c.title,
      render: c.render!
    }))
    .filter(route => Boolean(route.path.startsWith('/') && route.render) && !RESERVED_PATHS.has(route.path))
}

function isContributedPath(pathname: string): boolean {
  return contributedRoutes().some(route => route.path === pathname)
}

// ── Contributed sidebar nav — the `sidebar.nav` registry area ────────────────
export const SIDEBAR_NAV_AREA = 'sidebar.nav'

export interface SidebarNavContribution {
  codicon: string
  label: string
  path: string
}

// Views that render as a full-screen modal card (OverlayView) over the shell.
export const OVERLAY_VIEWS: ReadonlySet<AppView> = new Set([
  'agents',
  'command-center',
  'cron',
  'docops',
  'profiles',
  'settings',
  'starmap'
])

export function isOverlayView(view: AppView): boolean {
  return OVERLAY_VIEWS.has(view)
}

export function isNewChatRoute(pathname: string): boolean {
  return pathname === NEW_CHAT_ROUTE
}

export function routeSessionId(pathname: string): string | null {
  if (!pathname.startsWith(SESSION_ROUTE_PREFIX) || RESERVED_PATHS.has(pathname) || isContributedPath(pathname)) {
    return null
  }

  const id = pathname.slice(SESSION_ROUTE_PREFIX.length)

  return id && !id.includes('/') ? decodeURIComponent(id) : null
}

export function sessionRoute(sessionId: string): string {
  return `${SESSION_ROUTE_PREFIX}${encodeURIComponent(sessionId)}`
}

export function appViewForPath(pathname: string): AppView {
  if (isNewChatRoute(pathname) || routeSessionId(pathname)) {
    return 'chat'
  }

  if (isContributedPath(pathname)) {
    return 'extension'
  }

  return APP_VIEW_BY_PATH.get(pathname) ?? 'chat'
}

/** True while the workspace pane shows a FULL PAGE instead of chat. */
export const $workspaceIsPage = atom(false)

export function syncWorkspaceIsPage(pathname: string): void {
  const view = appViewForPath(pathname)
  const isPage = view !== 'chat' && !isOverlayView(view)

  if (isPage !== $workspaceIsPage.get()) {
    $workspaceIsPage.set(isPage)
  }
}
