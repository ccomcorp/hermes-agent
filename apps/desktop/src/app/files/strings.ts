// Local, English-only user-facing strings for the Files view.
//
// Per the parallel-port contract these stay LOCAL to the feature dir — the
// wiring step folds them into the shared locale files. Keep them here so this
// feature never edits `src/i18n/*`.

export const FILES_STRINGS = {
  title: 'Files',
  searchPlaceholder: 'Filter files',
  refresh: 'Refresh',
  refreshing: 'Refreshing',
  loading: 'Loading files',
  upload: 'Upload',
  uploading: 'Uploading',
  newFolder: 'New folder',
  pathLabel: 'Path',
  pathPlaceholder: 'Path',
  go: 'Go',
  dropTitle: 'Drop files here',
  dropRelease: 'Release to upload',
  chooseFiles: 'Choose files',
  parentDir: 'Parent directory',
  colName: 'Name',
  colSize: 'Size',
  colModified: 'Modified',
  colActions: 'Actions',
  emptyTitle: 'No files',
  emptyDesc: 'Upload a file or create a folder to get started.',
  emptySearchTitle: 'No matches',
  emptySearchDesc: 'No files match the current filter.',
  errorTitle: 'Could not load files',
  open: 'Open',
  download: 'Download',
  delete: 'Delete',
  cancel: 'Cancel',
  create: 'Create',
  creating: 'Creating',
  createFolderTitle: 'Create folder',
  createFolderTarget: 'Target',
  folderNamePlaceholder: 'Folder name',
  deleteTitle: 'Delete item?',
  deleteFolderDesc: 'This removes the folder and everything inside it.',
  deleteFileDesc: 'This removes the file.',
  deleting: 'Deleting',
  // Toast titles / messages.
  folderCreated: 'Folder created',
  uploaded: 'Uploaded',
  deleted: 'Deleted',
  failedCreate: 'Create failed',
  failedUpload: 'Upload failed',
  failedDownload: 'Download failed',
  failedDelete: 'Delete failed',
  pathRequired: 'Path required',
  folderNameRequired: 'Folder name required',
  directoryUnavailable: 'Directory unavailable'
} as const

export type FilesStrings = typeof FILES_STRINGS
