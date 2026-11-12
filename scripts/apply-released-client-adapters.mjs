import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'

const releasedShell = 'b9939941f7f064d86a47e3989b5716cc558834c7'
const officialCore = 'ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c'
const reviewedAdapters = '2b2b427dd7a98087641183da55c59dcfb9ee8a7b'
const files = [
  'desktop-bridge/lib/client.js',
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
const lock = JSON.parse(await readFile(process.argv[2], 'utf8'))
const shell = git('rev-parse', 'HEAD')
if (shell === releasedShell && lock.dsh?.version === '0.2.2-rc.2') {
  if (lock.dsh.reviewedCommit !== officialCore) throw new Error('Unexpected official rc.2 source')
  // Qualify against the published native binaries. Only the staged core's
  // adapters change, leaving the shell identity and update contract intact.
  git('fetch', '--quiet', '--no-tags', '--depth=1', 'https://github.com/WSL043/DSH-Portable.git', reviewedAdapters)
  git('restore', '--source', reviewedAdapters, '--worktree', '--', ...files)
  console.log(JSON.stringify({ shell, core: lock.dsh.version, adapterSource: reviewedAdapters, files }))
}
