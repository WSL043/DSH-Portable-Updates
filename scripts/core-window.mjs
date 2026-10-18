// The cores offered to users: the newest five versions, where at least two are release candidates or finals. Alphas
// never push the newest release candidates out: when fewer than two non-alpha versions fall inside the newest five,
// the oldest alpha slots go to the newest non-alpha versions instead. Input must be sorted newest first.
// Keep this identical to coreWindow() in DSH-Portable launcher/update-core.mjs.
export const CORE_WINDOW_SIZE = 5
export const CORE_WINDOW_MIN_RELEASE_CANDIDATES = 2

const isAlpha = version => /-alpha[.]/.test(version)

export function selectCoreWindow(sortedVersions) {
  const window = sortedVersions.slice(0, CORE_WINDOW_SIZE)
  const missing = CORE_WINDOW_MIN_RELEASE_CANDIDATES - window.filter(version => !isAlpha(version)).length
  if (missing <= 0) return window
  const extra = sortedVersions.slice(CORE_WINDOW_SIZE).filter(version => !isAlpha(version)).slice(0, missing)
  for (const version of extra) {
    const alphaAt = window.map(isAlpha).lastIndexOf(true)
    if (alphaAt === -1) break
    window.splice(alphaAt, 1)
    window.push(version)
  }
  return window
}
