import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const STATUS = new Set(['success', 'failed'])

export function normalizeQualificationState(value) {
  if (Array.isArray(value)) return value.filter(record => record && typeof record === 'object')
  if (Array.isArray(value?.records)) return value.records.filter(record => record && typeof record === 'object')
  if (value?.sourceSha && value?.version) return [value]
  return []
}

export function updateQualificationState(value, {
  sourceSha,
  version,
  status,
  attemptedAt,
  retryAfter = null,
}) {
  if (!sourceSha || !version) throw new Error('Qualification state requires sourceSha and version.')
  if (!STATUS.has(status)) throw new Error(`Unsupported qualification status: ${status}`)
  if (!attemptedAt) throw new Error('Qualification state requires attemptedAt.')
  const effectiveRetryAfter = status === 'failed'
    ? retryAfter || new Date(Date.parse(attemptedAt) + 24 * 60 * 60 * 1000).toISOString()
    : null
  const record = { sourceSha, version, status, attemptedAt, retryAfter: effectiveRetryAfter }
  const records = normalizeQualificationState(value)
    .filter(item => !(item.sourceSha === sourceSha && item.version === version))
  records.push(record)
  return records.sort((left, right) => String(right.attemptedAt).localeCompare(String(left.attemptedAt)))
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [filename, sourceSha, version, status, attemptedAt, retryAfter] = process.argv.slice(2)
  const current = await readFile(filename, 'utf8').then(JSON.parse, error => error?.code === 'ENOENT' ? [] : Promise.reject(error))
  const next = updateQualificationState(current, { sourceSha, version, status, attemptedAt, retryAfter: retryAfter || null })
  await writeFile(filename, JSON.stringify(next, null, 2) + '\n', 'utf8')
}
