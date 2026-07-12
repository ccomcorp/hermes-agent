/**
 * Workbench — Requirement Units and Workbench Plans backed by the
 * `.hermes/workbench` artifact store (Slices B+C of the go-forward plan —
 * ChangeSets, Design Studio, Write Workspace, and Workflow Designer are later
 * slices). Thin route root: layout lives in shell.tsx, state in store.ts.
 */
import type * as React from 'react'

import type { SetStatusbarItemGroup } from '../shell/statusbar-controls'

import { WorkbenchShell } from './shell'

interface WorkbenchViewProps extends React.ComponentProps<'section'> {
  setStatusbarItemGroup?: SetStatusbarItemGroup
}

export function WorkbenchView({ setStatusbarItemGroup, ...props }: WorkbenchViewProps) {
  return <WorkbenchShell setStatusbarItemGroup={setStatusbarItemGroup} {...props} />
}
