import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const archives = Object.freeze({
  'windows-x64':'DSH-Portable-windows-x64-offline.zip',
  'macos-arm64':'DSH-Portable-macos-arm64.zip',
  'macos-x64':'DSH-Portable-macos-x64.zip',
  'linux-x64':'DSH-Portable-linux-x64.tar.gz',
  'linux-arm64':'DSH-Portable-linux-arm64.tar.gz',
})
export function releasedBaselineArchive(platform) {
  const name=Object.hasOwn(archives,platform)?archives[platform]:null
  assert.ok(name,'Unsupported baseline platform')
  return name
}
export async function verifyReleasedBaseline(directory,platform) {
  const name=releasedBaselineArchive(platform)
  const matches=(await readFile(path.join(directory,'checksums.txt'),'utf8')).split(/\r?\n/)
    .map(line=>/^([a-f0-9]{64})  (.+)$/.exec(line)).filter(match=>match?.[2]===name)
  assert.equal(matches.length,1,'Exactly one published checksum is required')
  const hash=createHash('sha256')
  for await(const bytes of createReadStream(path.join(directory,name))) hash.update(bytes)
  assert.equal(hash.digest('hex'),matches[0][1],'Published baseline checksum differs')
  return name
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const [mode,...args]=process.argv.slice(2)
  if(mode==='archive')console.log(releasedBaselineArchive(args[0]))
  else if(mode==='verify')console.log(await verifyReleasedBaseline(args[0],args[1]))
  else throw Error('Expected archive or verify')
}
