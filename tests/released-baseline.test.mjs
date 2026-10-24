import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp,writeFile,rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { releasedBaselineArchive,verifyReleasedBaseline } from '../scripts/released-baseline.mjs'
test('published baseline archive selection is limited to supported native packages',()=>{
  for(const platform of ['windows-x64','macos-arm64','macos-x64','linux-x64','linux-arm64']) assert.match(releasedBaselineArchive(platform),/^DSH-Portable-/)
  for(const platform of ['../outside','toString','windows-arm64']) assert.throws(()=>releasedBaselineArchive(platform))
})
test('published baseline requires one matching checksum and exact archive bytes',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'released-baseline-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const name=releasedBaselineArchive('windows-x64'),bytes='qualified archive bytes',hash=createHash('sha256').update(bytes).digest('hex'),line=hash+'  '+name+'\n'
  await writeFile(path.join(root,name),bytes);await writeFile(path.join(root,'checksums.txt'),line)
  assert.equal(await verifyReleasedBaseline(root,'windows-x64'),name)
  await writeFile(path.join(root,name),'changed');await assert.rejects(verifyReleasedBaseline(root,'windows-x64'),/differs/)
  await writeFile(path.join(root,'checksums.txt'),line+line);await assert.rejects(verifyReleasedBaseline(root,'windows-x64'),/Exactly one/)
})
