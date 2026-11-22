import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Build-time verification only. The published desktop and its compatibility
// fingerprint remain unchanged; the built core must still pass artifact tests.
export function adaptRuntimeVerifier(source) {
  const nativeImport = "import { verifyPermissionLocalization } from './patch-permission-localization.mjs'"
  const nativeCall = "verifyPermissionLocalization(readFileSync(permissionSettingsClientPath, 'utf8'), readFileSync(conversationClientPath, 'utf8'))"
  if (source.split(nativeImport).length === 2 && source.split(nativeCall).length === 2) return source

  const oldImport = '  hasConversationPermissionLocalization,'
  const newImport = '  patchConversationPermissions,'
  const oldCall = "hasConversationPermissionLocalization(readFileSync(conversationClientPath, 'utf8'))"
  const newCall = "patchConversationPermissions(readFileSync(conversationClientPath, 'utf8'), readFileSync(permissionSettingsClientPath, 'utf8')) === readFileSync(conversationClientPath, 'utf8')"
  if (source.includes(newImport) && source.includes(newCall)) return source
  if (source.split(oldImport).length !== 2 || source.split(oldCall).length !== 2) {
    throw new Error('Unrecognized permission verifier; review the published baseline before adapting it')
  }
  return source.replace(oldImport, newImport).replace(oldCall, newCall)
}


export function adaptCoreUpdateSmoke(source) {
  const oldRequest = "      const response = await fetch(new URL('/dsh-market/installed', status.url), { signal: AbortSignal.timeout(15000) })"
  const newRequest = "      const login = await fetch(status.url, { redirect: 'manual', signal: AbortSignal.timeout(15000) })\n      const setCookie = login.headers.get('set-cookie')\n      const headers = setCookie ? { cookie: setCookie.split(';', 1)[0] } : {}\n      const response = await fetch(new URL('/dsh-market/installed', status.url), { headers, signal: AbortSignal.timeout(15000) })"
  if (source.includes(newRequest)) return source
  if (source.split(oldRequest).length !== 2) throw new Error('Unrecognized core update plugin verification request')
  return source.replace(oldRequest, newRequest)
}


export function adaptStartupThemeSmoke(source) {
  if (source.includes('const captureError = await nativeCapture')) return source
  const start = source.indexOf("    await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',\n      path.join(import.meta.dirname, 'capture-windows-native-window.ps1')")
  const end = source.indexOf('    let loading', start)
  const launch = '  try {\n    let page'
  if (start < 0 || end < 0 || source.split(launch).length !== 2) throw new Error('Unrecognized startup capture verification seam')
  const capture = source.slice(start, end)
    .replace('    await exec(', '    const nativeCapture = exec(')
    .replace('String(child.pid),', "String(child.pid), '-WindowTimeoutSeconds', '180',")
    .replace('timeout: 20000 })', 'timeout: 200000 }).then(() => null, error => error)')
  return (source.slice(0, start) + '    const captureError = await nativeCapture\n    if (captureError) throw captureError\n' + source.slice(end))
    .replace(launch, '  try {\n' + capture + '    let page')
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const startupFile = path.join(path.resolve(process.argv[2]), 'scripts/smoke-windows-startup-theme.mjs')
  const startup = await readFile(startupFile, 'utf8')
  const adaptedStartup = adaptStartupThemeSmoke(startup)
  if (startup !== adaptedStartup) await writeFile(startupFile, adaptedStartup)

  const smokeFile = path.join(path.resolve(process.argv[2]), 'scripts/smoke-update-artifact.mjs')
  const smoke = await readFile(smokeFile, 'utf8')
  const adaptedSmoke = adaptCoreUpdateSmoke(smoke)
  if (smoke !== adaptedSmoke) await writeFile(smokeFile, adaptedSmoke)

  const target = path.join(path.resolve(process.argv[2]), 'scripts/verify-runtime.mjs')
  const input = await readFile(target, 'utf8')
  const output = adaptRuntimeVerifier(input)
  if (output !== input) await writeFile(target, output)
  console.log(JSON.stringify({ verifier: target, adapted: output !== input, desktopModified: false }))
}
