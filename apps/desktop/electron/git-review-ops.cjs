'use strict'

// Compatibility facade: upstream renamed git-review-ops.cjs → git-review-ops.ts
// (main.cjs → main.ts migration). Workbench modules and node:test still load
// via CJS require(); esbuild also resolves this file when bundling main.ts.
// Only gitFor is needed by workbench-changeset-apply (Slice E). Keep the
// packaged-build simple-git vendored fallback so apply/commit works in
// release/win-unpacked the same way the TS module does in-bundle.
//
// AIOS-LOOP-SEAM:git-review-ops-cjs-facade

const path = require('node:path')

let simpleGit
try {
  simpleGit = require('simple-git')
} catch {
  const resourcesPath = process.resourcesPath
  if (!resourcesPath) {
    throw new Error("git-review-ops.cjs: 'simple-git' not found and no resourcesPath to fall back to")
  }
  simpleGit = require(path.join(resourcesPath, 'native-deps', 'vendor', 'node_modules', 'simple-git'))
}

function gitFor(cwd, gitBin) {
  return simpleGit({ baseDir: cwd, binary: gitBin || 'git', maxConcurrentProcesses: 4, trimmed: false })
}

module.exports = { gitFor }
