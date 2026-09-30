import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Electron previews share the release repository but cannot be a Native core
// baseline. Identify the product by its published assets, not its major version.
export function selectNativeRelease(releases) {
  if (!Array.isArray(releases)) throw new Error('Expected a GitHub release list.')
  const version = /^v\d+\.\d+\.\d+$/
  const required = ['portable-manifest.json', 'DSH-Portable-windows-x64-offline.zip', 'checksums.txt']
  const matches = releases.filter(release => release?.draft === false
    && release.prerelease === false
    && version.test(release.tag_name || '')
    && Number.isFinite(Date.parse(release.published_at))
    && required.every(name => release.assets?.some(asset => asset.name === name)))
  matches.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
  if (!matches.length) throw new Error('No published Native Portable stable release with complete baseline assets was found.')
  return matches[0]
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , filename] = process.argv
  process.stdout.write(`${JSON.stringify(selectNativeRelease(JSON.parse(readFileSync(filename, 'utf8'))))}\n`)
}
