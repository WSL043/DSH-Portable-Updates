import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Build-time verification only. The published desktop and its compatibility
// fingerprint remain unchanged; the built core must still pass artifact tests.
export function adaptRuntimeVerifier(source) {
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

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const target = path.join(path.resolve(process.argv[2]), 'scripts/verify-runtime.mjs')
  const input = await readFile(target, 'utf8')
  const output = adaptRuntimeVerifier(input)
  if (output !== input) await writeFile(target, output)
  console.log(JSON.stringify({ verifier: target, adapted: output !== input, desktopModified: false }))
}
