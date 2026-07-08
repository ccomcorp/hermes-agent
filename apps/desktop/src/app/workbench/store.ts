import type { WorkbenchManifestEntry } from '@hermes/shared'
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
