// Managed-files API surface for the Files view.
//
// Mirrors the desktop's `hermes.ts` request pattern: every call routes through
// `window.hermesDesktop.api<T>(...)` (the Electron main → backend bridge), NOT
// the dashboard's web `fetchJSON`. Endpoints match the backend's `/api/files`
// family used by the web FilesPage (list / read / upload / mkdir / delete).

export interface ManagedFileEntry {
  name: string
  path: string
  is_directory: boolean
  size: number | null
  mtime: number
  mime_type: string | null
}

export interface ManagedFilesResponse {
  root: string | null
  path: string
  parent: string | null
  locked_root: string | null
  can_change_path: boolean
  entries: ManagedFileEntry[]
}

export interface ManagedFileReadResponse {
  name: string
  path: string
  size: number
  mime_type: string
  data_url: string
  root: string | null
  locked_root: string | null
  can_change_path: boolean
}

export interface ManagedFileWriteResponse {
  ok: boolean
  path: string
  entry: ManagedFileEntry
  root: string | null
  locked_root: string | null
  can_change_path: boolean
}

export function listFiles(path?: string): Promise<ManagedFilesResponse> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''

  return window.hermesDesktop.api<ManagedFilesResponse>({
    path: `/api/files${query}`
  })
}

export function readFile(path: string): Promise<ManagedFileReadResponse> {
  return window.hermesDesktop.api<ManagedFileReadResponse>({
    path: `/api/files/read?path=${encodeURIComponent(path)}`
  })
}

export function uploadFile(path: string, dataUrl: string, overwrite = true): Promise<ManagedFileWriteResponse> {
  return window.hermesDesktop.api<ManagedFileWriteResponse>({
    path: '/api/files/upload',
    method: 'POST',
    body: { path, data_url: dataUrl, overwrite }
  })
}

export function createDirectory(path: string): Promise<ManagedFileWriteResponse> {
  return window.hermesDesktop.api<ManagedFileWriteResponse>({
    path: '/api/files/mkdir',
    method: 'POST',
    body: { path }
  })
}

export function deleteFile(path: string, recursive = false): Promise<{ ok: boolean; path: string }> {
  return window.hermesDesktop.api<{ ok: boolean; path: string }>({
    path: '/api/files',
    method: 'DELETE',
    body: { path, recursive }
  })
}
