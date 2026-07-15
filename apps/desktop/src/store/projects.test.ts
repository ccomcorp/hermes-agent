import { beforeEach, describe, expect, it, vi } from 'vitest'

import { $sidebarAgentsGrouped } from '@/store/layout'

import {
  $activeProjectId,
  $projectScope,
  $projectTree,
  $projects,
  $projectsRpcAvailable,
  $worktreeRefreshToken,
  ALL_PROJECTS,
  createProject,
  enterProject,
  exitProjectScope,
  openProjectCreate,
  pickCwdUnderProjectScope,
  pickProjectFolder,
  rehomeBlankChatDraftToEnteredProject,
  refreshProjects,
  refreshWorktrees,
  resolveNewSessionCwd
} from './projects'

vi.mock('@/i18n', () => ({
  translateNow: (key: string) => key
}))

vi.mock('@/store/notifications', () => ({
  notify: vi.fn()
}))

vi.mock('@/lib/desktop-fs', () => ({
  desktopDefaultCwd: vi.fn(),
  isDesktopFsRemoteMode: vi.fn(),
  selectDesktopPaths: vi.fn(),
  writeDesktopFileText: vi.fn()
}))

vi.mock('@/store/gateway', () => ({
  activeGateway: vi.fn(),
  ensureActiveGatewayOpen: vi.fn()
}))

const fs = await import('@/lib/desktop-fs')
const desktopDefaultCwd = vi.mocked(fs.desktopDefaultCwd)
const isDesktopFsRemoteMode = vi.mocked(fs.isDesktopFsRemoteMode)
const selectDesktopPaths = vi.mocked(fs.selectDesktopPaths)

const gw = await import('@/store/gateway')
const activeGateway = vi.mocked(gw.activeGateway)
const notifications = await import('@/store/notifications')
const notify = vi.mocked(notifications.notify)

describe('project scope', () => {
  beforeEach(() => {
    window.localStorage.clear()
    $projectScope.set(ALL_PROJECTS)
  })

  it('defaults to ALL_PROJECTS', () => {
    expect($projectScope.get()).toBe(ALL_PROJECTS)
  })

  it('enterProject scopes the sidebar to the project id', () => {
    // setActiveProject fires best-effort (no gateway in test → it rejects and is
    // swallowed); the synchronous scope change is what matters here.
    enterProject('p_123')
    expect($projectScope.get()).toBe('p_123')
  })

  it('exitProjectScope returns to the overview', () => {
    enterProject('p_123')
    exitProjectScope()
    expect($projectScope.get()).toBe(ALL_PROJECTS)
  })

  it('entering the synthetic No-project bucket still scopes (no active pin)', () => {
    enterProject('__no_project__')
    expect($projectScope.get()).toBe('__no_project__')
  })

  it('persists the scope to localStorage', () => {
    enterProject('p_abc')
    expect(window.localStorage.getItem('hermes.desktop.projectScope')).toBe('p_abc')
  })
})

describe('worktree refresh', () => {
  it('refreshWorktrees bumps the probe token so useRepoWorktreeMap refetches', () => {
    const before = $worktreeRefreshToken.get()
    refreshWorktrees()
    expect($worktreeRefreshToken.get()).toBe(before + 1)
  })
})

describe('pickProjectFolder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses the remote-aware directory picker locally', async () => {
    isDesktopFsRemoteMode.mockReturnValue(false)
    selectDesktopPaths.mockResolvedValue(['/local/repo'])

    await expect(pickProjectFolder()).resolves.toBe('/local/repo')
    expect(selectDesktopPaths).toHaveBeenCalledWith({ defaultPath: undefined, directories: true, multiple: false })
  })

  it('seeds the picker with the backend cwd on a remote gateway', async () => {
    isDesktopFsRemoteMode.mockReturnValue(true)
    desktopDefaultCwd.mockResolvedValue({ branch: 'main', cwd: '/backend/work' })
    selectDesktopPaths.mockResolvedValue(['/backend/work/repo'])

    await expect(pickProjectFolder()).resolves.toBe('/backend/work/repo')
    expect(selectDesktopPaths).toHaveBeenCalledWith({
      defaultPath: '/backend/work',
      directories: true,
      multiple: false
    })
  })

  it('returns null when the picker is cancelled (empty selection)', async () => {
    isDesktopFsRemoteMode.mockReturnValue(false)
    selectDesktopPaths.mockResolvedValue([])

    await expect(pickProjectFolder()).resolves.toBeNull()
  })
})

describe('createProject', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    $sidebarAgentsGrouped.set(false)
    $activeProjectId.set(null)
    $projectScope.set(ALL_PROJECTS)
    $projectTree.set([])
    $projects.set([])
    $projectsRpcAvailable.set(null)
  })

  it('creates the project and flips into the grouped view so a blank slate shows it', async () => {
    const created = { folders: [{ path: '/srv/demo', is_primary: true }], id: 'p_new', name: 'Demo', primary_path: '/srv/demo' }

    const request = vi.fn(async (method: string) => {
      if (method === 'projects.create') {
        return { project: created }
      }

      // Reconcile (fire-and-forget) re-reads list + tree; echo the project back
      // so the optimistic state survives instead of being wiped to empty.
      return { active_id: 'p_new', projects: [created], scoped_session_ids: [] }
    })

    activeGateway.mockReturnValue({ connectionState: 'open', request } as never)

    const result = await createProject({ folders: ['/srv/demo'], name: 'Demo', use: true })

    expect(result).toEqual(created)
    expect(request).toHaveBeenCalledWith('projects.create', expect.objectContaining({ name: 'Demo' }))
    expect($sidebarAgentsGrouped.get()).toBe(true)
    expect($activeProjectId.get()).toBe('p_new')
    // Regression: new sessions must land in the NEW project folder — scope must
    // enter the project, not leave the previous project (or ALL) active.
    expect($projectScope.get()).toBe('p_new')
    expect(resolveNewSessionCwd()).toBe('/srv/demo')
  })

  it('enterProject on create/use overrides a previous project scope for new-session cwd', async () => {
    const previous = {
      folders: [{ path: '/old/hermes-agent', is_primary: true }],
      id: 'p_old',
      name: 'Hermes Agent',
      primary_path: '/old/hermes-agent'
    }
    const created = {
      folders: [{ path: '/ws/Tech-Stack', is_primary: true }],
      id: 'p_tech',
      name: 'Tech Stack',
      primary_path: '/ws/Tech-Stack'
    }

    $projects.set([previous as never])
    $projectTree.set([
      {
        id: 'p_old',
        label: 'Hermes Agent',
        path: '/old/hermes-agent',
        color: null,
        icon: null,
        isAuto: false,
        repos: [],
        sessionCount: 0,
        previewSessions: []
      }
    ] as never)
    enterProject('p_old')
    expect(resolveNewSessionCwd()).toBe('/old/hermes-agent')

    const request = vi.fn(async (method: string) => {
      if (method === 'projects.create') {
        return { project: created }
      }

      return { active_id: 'p_tech', projects: [previous, created], scoped_session_ids: [] }
    })
    activeGateway.mockReturnValue({ connectionState: 'open', request } as never)

    await createProject({ folders: ['/ws/Tech-Stack'], name: 'Tech Stack', primaryPath: '/ws/Tech-Stack', use: true })

    expect($projectScope.get()).toBe('p_tech')
    expect(resolveNewSessionCwd()).toBe('/ws/Tech-Stack')
  })

  it('create/use rehomes blank-chat draft cwd away from the previous project', async () => {
    const { $activeSessionId, $currentCwd, $newChatWorkspaceTarget } = await import('@/store/session')

    $activeSessionId.set(null)
    $currentCwd.set('/old/hermes-agent')

    const created = {
      folders: [{ path: 'H:/WSpace-Hermes/hermes-projects/Security', is_primary: true }],
      id: 'p_security',
      name: 'Security',
      primary_path: 'H:/WSpace-Hermes/hermes-projects/Security'
    }

    const request = vi.fn(async (method: string) => {
      if (method === 'projects.create') {
        return { project: created }
      }

      return { active_id: 'p_security', projects: [created], scoped_session_ids: [] }
    })
    activeGateway.mockReturnValue({ connectionState: 'open', request } as never)

    await createProject({
      folders: ['H:/WSpace-Hermes/hermes-projects/Security'],
      name: 'Security',
      primaryPath: 'H:/WSpace-Hermes/hermes-projects/Security',
      use: true
    })

    expect($projectScope.get()).toBe('p_security')
    expect($currentCwd.get()).toBe('H:/WSpace-Hermes/hermes-projects/Security')
    expect($newChatWorkspaceTarget.get()).toBe('H:/WSpace-Hermes/hermes-projects/Security')
    expect(resolveNewSessionCwd()).toBe('H:/WSpace-Hermes/hermes-projects/Security')
  })
})

describe('pickCwdUnderProjectScope', () => {
  it('drops a live cwd that belongs to a different project', () => {
    expect(pickCwdUnderProjectScope('/old/hermes-agent', '/ws/Security')).toBe('/ws/Security')
    expect(pickCwdUnderProjectScope('I:\\PROJECTS\\AIOS\\hermes-agent', 'H:\\WSpace\\Security')).toBe(
      'H:\\WSpace\\Security'
    )
  })

  it('keeps a live cwd under the same project (worktree)', () => {
    expect(pickCwdUnderProjectScope('/ws/Security/subdir', '/ws/Security')).toBe('/ws/Security/subdir')
    expect(pickCwdUnderProjectScope('/ws/Security', '/ws/Security')).toBe('/ws/Security')
  })

  it('falls back when live is empty', () => {
    expect(pickCwdUnderProjectScope('', '/ws/Security')).toBe('/ws/Security')
    expect(pickCwdUnderProjectScope('/only-live', '')).toBe('/only-live')
  })
})

describe('createProject stale backend', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    $projectsRpcAvailable.set(null)
  })

  it('marks the backend stale and surfaces a friendly error when projects.create is missing', async () => {
    activeGateway.mockReturnValue({
      connectionState: 'open',
      request: vi.fn().mockRejectedValue(new Error('unknown method: projects.create'))
    } as never)

    await expect(createProject({ folders: ['/srv/demo'], name: 'Demo' })).rejects.toThrow(
      'sidebar.projects.staleBackend'
    )
    expect($projectsRpcAvailable.get()).toBe(false)
  })
})

describe('projects RPC capability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    $projectsRpcAvailable.set(null)
  })

  it('marks the backend stale when projects.list is missing', async () => {
    activeGateway.mockReturnValue({
      connectionState: 'open',
      request: vi.fn().mockRejectedValue(new Error('unknown method: projects.list'))
    } as never)

    await refreshProjects()

    expect($projectsRpcAvailable.get()).toBe(false)
  })

  it('blocks opening the create dialog once the backend is known stale', () => {
    $projectsRpcAvailable.set(false)

    openProjectCreate()

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'warning', message: 'sidebar.projects.staleBackend' })
    )
  })
})
