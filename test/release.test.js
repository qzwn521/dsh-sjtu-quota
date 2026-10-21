import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-quota-release-'))
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  for (const name of ['package.json', 'scripts', ...pkg.files]) cpSync(join(root, name), join(dir, name), { recursive: true })
  return dir
}
function run(dir, script, args = []) {
  const result = spawnSync(process.execPath, [join(dir, 'scripts', script), ...args], { cwd: dir, encoding: 'utf8', windowsHide: true })
  if (result.error) throw result.error
  return result
}
function entries(bytes) {
  const tar = gunzipSync(bytes), result = new Map()
  for (let at = 0; tar[at];) {
    const name = tar.subarray(at, at + 100).toString().replace(/\0.*$/s, '')
    const size = parseInt(tar.subarray(at + 124, at + 136).toString().replace(/\0.*$/s, '').trim(), 8)
    result.set(name, tar.subarray(at + 512, at + 512 + size))
    at += 512 + Math.ceil(size / 512) * 512
  }
  return result
}

test('release archive is reproducible and excludes credentials, state, tests and dependencies', () => {
  const dir = fixture()
  writeFileSync(join(dir, '.env'), 'SJTU_API_KEY=fixture-never-publish')
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'private.json'), 'fixture-never-publish')
  mkdirSync(join(dir, '.test-state'), { recursive: true })
  writeFileSync(join(dir, '.test-state', 'ledger.json'), 'fixture-never-publish')
  const first = run(dir, 'pack.mjs')
  assert.equal(first.status, 0, first.stderr)
  const metadata = JSON.parse(first.stdout)
  const packed = readFileSync(join(dir, 'dist', metadata.filename))
  const second = run(dir, 'pack.mjs')
  assert.equal(second.status, 0, second.stderr)
  assert.deepEqual(readFileSync(join(dir, 'dist', metadata.filename)), packed)
  const files = entries(packed)
  assert.equal(files.size, 11)
  assert.ok(files.has('package/cordis.patch.yml') && files.has('package/src/index.js'))
  assert.ok(!gunzipSync(packed).includes(Buffer.from('fixture-never-publish')))
  assert.ok([...files.keys()].every(name => !/\.env|node_modules|\.test-state|scripts\/|test\//.test(name)))
})

test('release validation blocks missing publication identity but allows explicit draft checks', () => {
  const dir = fixture()
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  delete pkg.repository
  delete pkg.author
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
  const blocked = run(dir, 'check-release.mjs')
  assert.equal(blocked.status, 1)
  assert.ok(JSON.parse(blocked.stdout).pending.length >= 2)
  assert.equal(run(dir, 'check-release.mjs', ['--draft']).status, 0)
})

test('release preparation produces matching install metadata and marketplace YAML', () => {
  const dir = fixture()
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  delete pkg.repository
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
  const prepared = run(dir, 'prepare-release.mjs', ['example-owner/quota-fixture'])
  assert.equal(prepared.status, 0, prepared.stderr)
  assert.equal(run(dir, 'check-release.mjs').status, 0)
  const updated = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.equal(updated.repository.url, 'git+https://github.com/example-owner/quota-fixture.git')
  const yaml = readFileSync(join(dir, 'release/example-owner__quota-fixture.yml'), 'utf8')
  assert.ok(yaml.startsWith('url: https://github.com/example-owner/quota-fixture\nname: example-owner/quota-fixture\ncategory: usage\n'))
  assert.equal(run(dir, 'prepare-release.mjs', ['different-owner/other-repo']).status, 1)
})
