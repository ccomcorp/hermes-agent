/**
 * Wiring surfaces — each pane is its own memoized component. Every surface
 * reads the reactive state it renders from at the leaf (its own atom
 * subscriptions) and reaches the controller's callbacks through the stable
 * `actions` bag, so a state change scoped to one surface (or a bare
 * wiring-controller tick) never re-renders another. This is what keeps the
 * layout tree's zones independently rendered — the whole point of the shell.
 */

import { useStore } from '@nanostores/react'
import { type ComponentProps, lazy, memo, type ReactNode, Suspense, useMemo } from 'react'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'

import { ContribBoundary } from '@/contrib/react/boundary'
import { useContributions } from '@/contrib/react/use-contributions'
import { $activeGatewayProfile } from '@/store/profile'
import { $freshDraftReady, $gatewayState } from '@/store/session'

import { ChatView } from '../chat'
import { ChatSidebar } from '../chat/sidebar'
import { TerminalPaneChrome } from '../right-sidebar/terminal/chrome'
import { contributedRoutes, NEW_CHAT_ROUTE, ROUTES_AREA, sessionRoute } from '../routes'
import { useStatusSnapshot } from '../shell/hooks/use-status-snapshot'
import { useStatusbarItems } from '../shell/hooks/use-statusbar-items'
import { ModelMenuPanel } from '../shell/model-menu-panel'
import { StatusbarControls } from '../shell/statusbar-controls'

import { latestChatActions, latestSidebarActions } from './latest-actions'
import { setStatusbarItemGroup, useStatusbarContributions } from './panes'
import type { SidebarActions, WiringActions } from './types'

// Same lazy-view split as DesktopController — pages load on demand. The
// full-page views the workspace route table mounts live here; overlay views
// (agents/settings/…) are the controller's and stay in wiring.tsx.
const ArtifactsView = lazy(async () => ({ default: (await import('../artifacts')).ArtifactsView }))
const CanvasView = lazy(async () => ({ default: (await import('../canvas')).CanvasView }))
const ChannelsView = lazy(async () => ({ default: (await import('../channels')).ChannelsView }))
const ConfigView = lazy(async () => ({ default: (await import('../config')).ConfigView }))
const FilesView = lazy(async () => ({ default: (await import('../files')).FilesView }))
const KanbanView = lazy(async () => ({ default: (await import('../kanban')).KanbanView }))
const LogsView = lazy(async () => ({ default: (await import('../logs')).LogsView }))
const MessagingView = lazy(async () => ({ default: (await import('../messaging')).MessagingView }))
const ModelsView = lazy(async () => ({ default: (await import('../models')).ModelsView }))
const PairingView = lazy(async () => ({ default: (await import('../pairing')).PairingView }))
const PluginsView = lazy(async () => ({ default: (await import('../plugins')).PluginsView }))
const SkillsView = lazy(async () => ({ default: (await import('../skills')).SkillsView }))
const SystemView = lazy(async () => ({ default: (await import('../system')).SystemView }))
const WebhooksView = lazy(async () => ({ default: (await import('../webhooks')).WebhooksView }))
const WorkbenchView = lazy(async () => ({ default: (await import('../workbench')).WorkbenchView }))

export function LegacySessionRedirect() {
  const { sessionId } = useParams()

  return <Navigate replace to={sessionId ? sessionRoute(sessionId) : NEW_CHAT_ROUTE} />
}

export const SidebarSurface = memo(function SidebarSurface({
  actions,
  currentView
}: {
  actions: SidebarActions
  currentView: ComponentProps<typeof ChatSidebar>['currentView']
}) {
  const latestActions = useMemo(() => latestSidebarActions(actions), [actions])

  return <ChatSidebar currentView={currentView} {...latestActions} />
})

export const TerminalSurface = memo(function TerminalSurface() {
  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-(--ui-editor-surface-background)">
      <TerminalPaneChrome />
    </div>
  )
})

/** Owns the statusbar's own data hooks (status snapshot poll, contributed
 *  items) so its 15s refresh — and any statusbar-only churn — re-renders the
 *  bar alone, never the chat/sidebar/terminal. */
export const StatusbarSurface = memo(function StatusbarSurface({
  actions,
  agentsOpen,
  chatOpen,
  commandCenterOpen
}: {
  actions: WiringActions
  agentsOpen: boolean
  chatOpen: boolean
  commandCenterOpen: boolean
}) {
  const gatewayState = useStore($gatewayState)
  const freshDraftReady = useStore($freshDraftReady)
  const { inferenceStatus, statusSnapshot } = useStatusSnapshot(gatewayState, actions.requestGateway)
  const extraLeftItems = useStatusbarContributions('left')
  const extraRightItems = useStatusbarContributions('right')

  const { leftStatusbarItems, statusbarItems } = useStatusbarItems({
    agentsOpen,
    chatOpen,
    commandCenterOpen,
    extraLeftItems,
    extraRightItems,
    freshDraftReady,
    gatewayState,
    inferenceStatus,
    openAgents: actions.openAgents,
    openCommandCenterSection: actions.openCommandCenterSection,
    requestGateway: actions.requestGateway,
    statusSnapshot,
    toggleCommandCenter: actions.toggleCommandCenter
  })

  return <StatusbarControls items={statusbarItems} leftItems={leftStatusbarItems} />
})

/** The workspace pane: the real route table (chat + full-page views + plugin
 *  routes). Subscribes to `$gatewayState` and ROUTES_AREA itself; the gateway
 *  instance + voice cap arrive as props so a reconnect/config load re-renders
 *  only this surface. ChatView subscribes to its own session atoms, so
 *  streaming never round-trips through the controller. */
export const ChatRoutesSurface = memo(function ChatRoutesSurface({
  actions,
  maxVoiceRecordingSeconds
}: {
  actions: WiringActions
  maxVoiceRecordingSeconds?: number
}) {
  const activeGatewayProfile = useStore($activeGatewayProfile)
  const gatewayState = useStore($gatewayState)
  useContributions(ROUTES_AREA)
  const routeContributions = contributedRoutes()

  // Recapture the live gateway instance whenever the connection state flips.
  // getGateway reads a controller ref, so gatewayState is the intentional
  // re-eval trigger (not a value the computation itself reads).
  const gateway = useMemo(
    () => actions.getGateway(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [actions, gatewayState]
  )

  const modelMenuContent = useMemo(
    () =>
      gatewayState === 'open' ? (
        <ModelMenuPanel
          gateway={gateway || undefined}
          onSelectModel={actions.selectModel}
          profile={activeGatewayProfile}
          requestGateway={actions.requestGateway}
        />
      ) : null,
    [actions, activeGatewayProfile, gateway, gatewayState]
  )

  const chatActions = useMemo(() => latestChatActions(actions), [actions])

  const chatView = (
    <ChatView
      gateway={gateway}
      maxVoiceRecordingSeconds={maxVoiceRecordingSeconds}
      modelMenuContent={modelMenuContent}
      {...chatActions}
    />
  )

  // FULL-PAGE views (not chat) mark the zone body `data-zone-no-header`: a
  // page is not a tab-able surface, so the zone's double-click header toggle
  // stands down while one is showing (see onZoneDoubleClick).
  const page = (view: ReactNode) => (
    <div className="contents" data-zone-no-header>
      <Suspense fallback={null}>{view}</Suspense>
    </div>
  )

  return (
    <Routes>
      <Route element={chatView} index />
      <Route element={chatView} path=":sessionId" />
      <Route element={page(<SkillsView setStatusbarItemGroup={setStatusbarItemGroup} />)} path="skills" />
      <Route element={page(<MessagingView setStatusbarItemGroup={setStatusbarItemGroup} />)} path="messaging" />
      <Route element={page(<ArtifactsView setStatusbarItemGroup={setStatusbarItemGroup} />)} path="artifacts" />
      <Route element={page(<KanbanView setStatusbarItemGroup={setStatusbarItemGroup} />)} path="kanban" />
      <Route element={page(<CanvasView setStatusbarItemGroup={setStatusbarItemGroup} />)} path="canvas" />
      <Route element={page(<ChannelsView setStatusbarItemGroup={setStatusbarItemGroup} />)} path="channels" />
      <Route element={page(<PairingView setStatusbarItemGroup={setStatusbarItemGroup} />)} path="pairing" />
      <Route element={page(<WebhooksView setStatusbarItemGroup={setStatusbarItemGroup} />)} path="webhooks" />
      <Route element={page(<PluginsView setStatusbarItemGroup={setStatusbarItemGroup} />)} path="plugins" />
      <Route element={page(<FilesView setStatusbarItemGroup={setStatusbarItemGroup} />)} path="files" />
      <Route element={page(<WorkbenchView setStatusbarItemGroup={setStatusbarItemGroup} />)} path="workbench" />
      <Route element={page(<SystemView setStatusbarItemGroup={setStatusbarItemGroup} />)} path="system" />
      <Route element={page(<ConfigView setStatusbarItemGroup={setStatusbarItemGroup} />)} path="config" />
      <Route element={page(<LogsView setStatusbarItemGroup={setStatusbarItemGroup} />)} path="logs" />
      <Route element={page(<ModelsView setStatusbarItemGroup={setStatusbarItemGroup} />)} path="models" />
      <Route element={null} path="agents" />
      <Route element={null} path="command-center" />
      <Route element={null} path="cron" />
      <Route element={null} path="docops" />
      <Route element={null} path="profiles" />
      <Route element={null} path="settings" />
      <Route element={null} path="starmap" />
      <Route element={null} path="webhooks" />
      {/* Registry-contributed pages (core features + plugins) render in the
          workspace pane like any built-in view — behind the same blast wall
          as every other contribution mount. */}
      {routeContributions.map(route => (
        <Route
          element={page(<ContribBoundary id={route.key}>{route.render()}</ContribBoundary>)}
          key={route.key}
          path={route.path.slice(1)}
        />
      ))}
      <Route element={<Navigate replace to={NEW_CHAT_ROUTE} />} path="new" />
      <Route element={<LegacySessionRedirect />} path="sessions/:sessionId" />
      <Route element={<Navigate replace to={NEW_CHAT_ROUTE} />} path="*" />
    </Routes>
  )
})
