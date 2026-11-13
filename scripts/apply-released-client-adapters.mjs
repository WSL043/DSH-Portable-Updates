import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { compareVersions, isValidSemVer } from './build-core-index.mjs'

const releasedShell = 'b9939941f7f064d86a47e3989b5716cc558834c7'
const adapterFloor = '0.2.2-rc.2'
const reviewedAdapters = 'fd2b741455fba0f13c2aedd8811b6cfc8bde5164'
const files = [
  'desktop-bridge/lib/client.js',
  'scripts/patch-account-login.mjs',
  'scripts/patch-loopback-connection.mjs',
  'scripts/patch-native-boot-handoff.mjs',
  'scripts/patch-native-settings-command.mjs',
  'scripts/patch-permission-localization.mjs',
  'scripts/patch-portable-hero-context.mjs',
  'scripts/patch-session-export-ui.mjs',
  'scripts/patch-theme-bootstrap.mjs',
  'scripts/verify-runtime.mjs',
]

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim()
const { dsh } = JSON.parse(await readFile(process.argv[2], 'utf8'))
const shell = git('rev-parse', 'HEAD')
if (shell === releasedShell) {
  if (!isValidSemVer(dsh?.version)) throw new Error('Invalid locked core version')
  if (compareVersions(dsh.version, adapterFloor) >= 0) {
    // Discovery binds each official release. The same reviewed adapters go
    // through preflight and platform smoke for each new candidate.
    git('fetch', '--quiet', '--no-tags', '--depth=1', 'https://github.com/WSL043/DSH-Portable.git', reviewedAdapters)
    git('restore', '--source', reviewedAdapters, '--worktree', '--', ...files)
    console.log(JSON.stringify({ shell, core: dsh.version, adapterSource: reviewedAdapters, files }))
  }
}
