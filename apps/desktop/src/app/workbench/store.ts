import type {
  WorkbenchDesignSettings,
  WorkbenchManifestEntry,
  WorkbenchRequirementTrace
} from '@hermes/shared'
// Hermes Workbench feature state.
//
// Plain nanostores, mirroring the pattern in `../skills/store.ts` (persisted
// atoms for durable prefs, plain atoms for session-scoped view state) rather
// than pulling in a heavier state library for a single-slice feature.
//
// Workbench's backend is local-filesystem-only for this slice (locked decision
// §3.3 in the go-forward plan) — a remote session must never silently write
// local artifacts, so the workspace root is the ONLY thing that gates writes,
// and `workbenchBackendMode()` always reports 'remote-unsupported' when the
// active connection is remote.
import { atom, computed } from 'nanostores'

import { Codecs, persistentAtom } from '@/lib/persisted'
import { $connection } from '@/store/session'

// The workspace root Workbench artifacts are read/written under. Persisted so
// reopening Workbench (or restarting the app) remembers the last choice —
// Workbench never guesses or defaults one; see the empty state in shell.tsx.
export const $workbenchWorkspaceRoot = persistentAtom<null | string>(
  'hermes.desktop.workbench.workspaceRoot',
  null,
  Codecs.nullableText
)

// Manifest-shaped rows (id/title/relativePath/updatedAt) — this is genuinely
// all `requirements:list` returns (see workbench-artifacts.cjs `listRequirements`,
// which reads `manifest.requirements`); the full `WorkbenchRequirement`
// (status, contentHash, …) only comes back from `read`/`create`. Modeling the
// list as the manifest-entry shape (not a partial WorkbenchRequirement) keeps
// this store honest about what's actually loaded without a fetch per row.
export const $workbenchRequirements = atom<WorkbenchManifestEntry[]>([])
export const $workbenchActiveRequirementId = atom<null | string>(null)
export const $workbenchListLoading = atom(false)
export const $workbenchListError = atom<null | string>(null)

export const $workbenchActiveManifestEntry = computed(
  [$workbenchRequirements, $workbenchActiveRequirementId],
  (requirements, activeId) => requirements.find(entry => entry.id === activeId) ?? null
)

export type WorkbenchBackendMode = 'local' | 'remote-unsupported'

// Remote sessions surface Workbench as not-yet-supported rather than silently
// writing local artifacts through desktop IPC against a remote backend
// (security rule 03 §9 / locked decision §3.3).
export const $workbenchBackendMode = computed($connection, (connection): WorkbenchBackendMode =>
  connection?.mode === 'remote' ? 'remote-unsupported' : 'local'
)

export function setWorkbenchWorkspaceRoot(root: null | string) {
  $workbenchWorkspaceRoot.set(root)
  // Switching (or clearing) the workspace invalidates whatever was loaded for
  // the previous one — fail closed rather than showing stale rows against a
  // root that's no longer selected.
  $workbenchRequirements.set([])
  $workbenchActiveRequirementId.set(null)
  $workbenchListError.set(null)
  $workbenchPlans.set([])
  $workbenchActivePlanId.set(null)
  $workbenchPlansError.set(null)
  $workbenchActiveRequirementTrace.set(null)
  $workbenchChangeSets.set([])
  $workbenchActiveChangeSetId.set(null)
  $workbenchChangeSetsError.set(null)
  $workbenchDesignSettings.set(null)
  $workbenchDesignSettingsError.set(null)
  $workbenchWriteProjects.set([])
  $workbenchActiveWriteProjectId.set(null)
  $workbenchWriteProjectsError.set(null)
}

export function setWorkbenchRequirements(entries: WorkbenchManifestEntry[]) {
  $workbenchRequirements.set(entries)
}

export function setWorkbenchListLoading(loading: boolean) {
  $workbenchListLoading.set(loading)
}

export function setWorkbenchListError(message: null | string) {
  $workbenchListError.set(message)
}

export function setWorkbenchActiveRequirementId(id: null | string) {
  $workbenchActiveRequirementId.set(id)
  // Switching (or closing) the open requirement invalidates whatever plan was
  // open for the previous one, plus the trace mirror plan-panel.tsx derives
  // linked plans from — fail closed rather than showing a plan/trace that
  // belongs to a requirement that's no longer open.
  $workbenchActiveRequirementTrace.set(null)
  $workbenchActivePlanId.set(null)
}

// Upserts a manifest-row after create/update so the list reflects the write
// immediately, ahead of (or even if) a follow-up `list` refresh lands.
export function upsertWorkbenchManifestEntry(entry: WorkbenchManifestEntry) {
  const current = $workbenchRequirements.get()
  const next = [entry, ...current.filter(existing => existing.id !== entry.id)]
  $workbenchRequirements.set(next)
}

export function patchWorkbenchManifestEntry(id: string, patch: Partial<WorkbenchManifestEntry>) {
  $workbenchRequirements.set(
    $workbenchRequirements.get().map(entry => (entry.id === id ? { ...entry, ...patch } : entry))
  )
}

// Loaded requirement detail (markdown + trace) is view-local state in
// requirement-panel.tsx, not global store state — it's an editable draft tied
// to one open panel instance, not shared/derived data other components read.
//
// The trace itself is the ONE exception: plan-panel.tsx (a sibling of
// requirement-panel.tsx, not a child) needs `trace.linkedPlanIds` to know
// which plans belong to the open requirement, so requirement-panel.tsx mirrors
// its loaded trace into `$workbenchActiveRequirementTrace` below whenever it
// changes. requirement-panel.tsx is the only writer of that atom.

// ---------------------------------------------------------------------------
// Plans (Slice C)
//
// Plans are workspace-scoped on disk (`.hermes/workbench/plans`), not
// requirement-scoped — `plans:list` returns every plan in the workspace and
// does not filter server-side even when passed a requirementId (see api.ts
// and workbench-artifacts.cjs `listPlans`). "Plans linked to the open
// requirement" is therefore a client-side derivation: cross-reference the
// open requirement's `trace.linkedPlanIds` against this full list, rather
// than trusting a requirementId param the backend doesn't actually honor yet
// (go-forward plan §3.6).
// ---------------------------------------------------------------------------

export const $workbenchPlans = atom<WorkbenchManifestEntry[]>([])
export const $workbenchPlansLoading = atom(false)
export const $workbenchPlansError = atom<null | string>(null)
export const $workbenchActivePlanId = atom<null | string>(null)

// Mirror of the open requirement's trace — see the comment above. Null when no
// requirement is open or its detail hasn't loaded yet.
export const $workbenchActiveRequirementTrace = atom<WorkbenchRequirementTrace | null>(null)

export const $workbenchLinkedPlans = computed(
  [$workbenchPlans, $workbenchActiveRequirementTrace],
  (plans, trace) => {
    if (!trace || trace.linkedPlanIds.length === 0) {
      return []
    }

    const linked = new Set(trace.linkedPlanIds)

    return plans.filter(plan => linked.has(plan.id))
  }
)

export function setWorkbenchPlans(entries: WorkbenchManifestEntry[]) {
  $workbenchPlans.set(entries)
}

export function setWorkbenchPlansLoading(loading: boolean) {
  $workbenchPlansLoading.set(loading)
}

export function setWorkbenchPlansError(message: null | string) {
  $workbenchPlansError.set(message)
}

export function setWorkbenchActivePlanId(id: null | string) {
  $workbenchActivePlanId.set(id)
}

export function setWorkbenchActiveRequirementTrace(trace: WorkbenchRequirementTrace | null) {
  $workbenchActiveRequirementTrace.set(trace)
}

// Upserts a plan manifest row after create/refine, mirroring
// `upsertWorkbenchManifestEntry` above.
export function upsertWorkbenchPlanManifestEntry(entry: WorkbenchManifestEntry) {
  const current = $workbenchPlans.get()
  const next = [entry, ...current.filter(existing => existing.id !== entry.id)]
  $workbenchPlans.set(next)
}

// Optimistically mirrors what `linkPlanToRequirement` just did on disk (the
// backend already pushed this id into trace.json's linkedPlanIds during
// create/refine) so `$workbenchLinkedPlans` reflects the new plan immediately,
// without waiting on a requirement re-read.
export function addLinkedPlanId(planId: string) {
  const trace = $workbenchActiveRequirementTrace.get()

  if (!trace || trace.linkedPlanIds.includes(planId)) {
    return
  }

  $workbenchActiveRequirementTrace.set({ ...trace, linkedPlanIds: [...trace.linkedPlanIds, planId] })
}

// ---------------------------------------------------------------------------
// ChangeSets (Slice D — review/status only)
//
// ChangeSets are workspace-wide, not requirement-scoped — same shape of
// reasoning as Plans (see the comment above `$workbenchPlans`), except there
// isn't even a `trace.linkedChangeSetIds` population to derive from yet (see
// api.ts): `createChangeSet` never links back into the source requirement's
// trace.json the way `createPlan`/`refinePlan` do. So this is not scoped to
// the active requirement at all; it lists every changeset in the workspace.
// ---------------------------------------------------------------------------

export const $workbenchChangeSets = atom<WorkbenchManifestEntry[]>([])
export const $workbenchChangeSetsLoading = atom(false)
export const $workbenchChangeSetsError = atom<null | string>(null)
export const $workbenchActiveChangeSetId = atom<null | string>(null)

export function setWorkbenchChangeSets(entries: WorkbenchManifestEntry[]) {
  $workbenchChangeSets.set(entries)
}

export function setWorkbenchChangeSetsLoading(loading: boolean) {
  $workbenchChangeSetsLoading.set(loading)
}

export function setWorkbenchChangeSetsError(message: null | string) {
  $workbenchChangeSetsError.set(message)
}

export function setWorkbenchActiveChangeSetId(id: null | string) {
  $workbenchActiveChangeSetId.set(id)
}

// ---------------------------------------------------------------------------
// Design Studio settings (Slice F — settings only)
//
// Exactly one WorkbenchDesignSettings document per workspace (unlike
// requirements/plans/changesets, this is not a list) — so there is a single
// value atom, not a manifest-entry list + active-id pair.
// ---------------------------------------------------------------------------

export const $workbenchDesignSettings = atom<WorkbenchDesignSettings | null>(null)
export const $workbenchDesignSettingsLoading = atom(false)
export const $workbenchDesignSettingsError = atom<null | string>(null)

export function setWorkbenchDesignSettings(settings: WorkbenchDesignSettings | null) {
  $workbenchDesignSettings.set(settings)
}

export function setWorkbenchDesignSettingsLoading(loading: boolean) {
  $workbenchDesignSettingsLoading.set(loading)
}

export function setWorkbenchDesignSettingsError(message: null | string) {
  $workbenchDesignSettingsError.set(message)
}

// ---------------------------------------------------------------------------
// Write Workspace (Slice J — backend CRUD + editor)
//
// Write projects are a list, one per workspace, exactly like Requirements —
// not a singleton like Design Studio settings. Loaded detail (markdown +
// recent edits) is view-local state in write-panel.tsx, matching how
// requirement-panel.tsx keeps its loaded detail local rather than global.
// ---------------------------------------------------------------------------

export const $workbenchWriteProjects = atom<WorkbenchManifestEntry[]>([])
export const $workbenchWriteProjectsLoading = atom(false)
export const $workbenchWriteProjectsError = atom<null | string>(null)
export const $workbenchActiveWriteProjectId = atom<null | string>(null)

export function setWorkbenchWriteProjects(entries: WorkbenchManifestEntry[]) {
  $workbenchWriteProjects.set(entries)
}

export function setWorkbenchWriteProjectsLoading(loading: boolean) {
  $workbenchWriteProjectsLoading.set(loading)
}

export function setWorkbenchWriteProjectsError(message: null | string) {
  $workbenchWriteProjectsError.set(message)
}

export function setWorkbenchActiveWriteProjectId(id: null | string) {
  $workbenchActiveWriteProjectId.set(id)
}

export function upsertWorkbenchWriteProjectManifestEntry(entry: WorkbenchManifestEntry) {
  const current = $workbenchWriteProjects.get()
  const next = [entry, ...current.filter(existing => existing.id !== entry.id)]
  $workbenchWriteProjects.set(next)
}

export function patchWorkbenchWriteProjectManifestEntry(id: string, patch: Partial<WorkbenchManifestEntry>) {
  $workbenchWriteProjects.set(
    $workbenchWriteProjects.get().map(entry => (entry.id === id ? { ...entry, ...patch } : entry))
  )
}
