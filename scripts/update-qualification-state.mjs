import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const STATUS = new Set(['success', 'failed', 'blocked'])

export function normalizeQualificationState(value) {
  if (Array.isArray(value)) return value.filter(record => record && typeof record === 'object')
  if (Array.isArray(value?.records)) return value.records.filter(record => record && typeof record === 'object')
  if (value?.sourceSha && value?.version) return [value]
  return []
}

export function mergeQualificationStates(topThree, ...values) {
  const allowed = new Set(topThree)
  const merged = new Map()
  for (const value of values) {
    for (const record of normalizeQualificationState(value)) {
      if (!allowed.has(record.version) || !record.sourceSha || !STATUS.has(record.status)) continue
      const key = `${record.sourceSha}\0${record.version}`
      const previous = merged.get(key)
      if (!previous || String(record.attemptedAt ?? '') > String(previous.attemptedAt ?? '')) merged.set(key, record)
    }
  }
  return [...merged.values()].sort((left, right) => String(right.attemptedAt ?? '').localeCompare(String(left.attemptedAt ?? '')))
}

export function updateQualificationState(value, {
  sourceSha,
  version,
  status,
  attemptedAt,
  retryAfter = null,
  pipelineSha,
  adapter,
  reason,
  defaultPeersInputHash,
  topThree,
}) {
  if (!sourceSha || !version) throw new Error('Qualification state requires sourceSha and version.')
  if (!STATUS.has(status)) throw new Error(`Unsupported qualification status: ${status}`)
  if (!attemptedAt) throw new Error('Qualification state requires attemptedAt.')
  const effectiveRetryAfter = status === 'failed'
    ? retryAfter || new Date(Date.parse(attemptedAt) + 24 * 60 * 60 * 1000).toISOString()
    : null
  const record = { sourceSha, version, status, attemptedAt, retryAfter: effectiveRetryAfter,
    ...(pipelineSha ? { pipelineSha } : {}),
    ...(status === 'blocked' && typeof adapter === 'string' ? { adapter } : {}),
    ...(status === 'blocked' && typeof reason === 'string' ? { reason: reason.slice(0, 2000) } : {}),
    ...(status === 'blocked' && adapter === 'default-plugin-peers' && /^[a-f0-9]{64}$/.test(defaultPeersInputHash || '')
      ? { defaultPeersInputHash } : {}) }
  const records = normalizeQualificationState(value)
    .filter(item => !Array.isArray(topThree) || topThree.includes(item.version))
    .filter(item => !(item.sourceSha === sourceSha && item.version === version))
  records.push(record)
  return records.sort((left, right) => String(right.attemptedAt).localeCompare(String(left.attemptedAt)))
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [filename, sourceSha, version, status, attemptedAt, retryAfter, pipelineSha] = process.argv.slice(2)
  const selectionFlag = process.argv.indexOf('--selection-file')
  const selection = selectionFlag < 0 ? {} : JSON.parse(await readFile(process.argv[selectionFlag + 1], 'utf8'))
  const current = await readFile(filename, 'utf8').then(JSON.parse, error => error?.code === 'ENOENT' ? [] : Promise.reject(error))
  const next = updateQualificationState(current, { sourceSha, version, status, attemptedAt, retryAfter: retryAfter || null, pipelineSha,
    adapter: selection.adapter, reason: selection.reason, defaultPeersInputHash: selection.defaultPeersInputHash,
    topThree: selection.topThree })
  await writeFile(filename, JSON.stringify(next, null, 2) + '\n', 'utf8')
}
