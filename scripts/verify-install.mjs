import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const host = resolve(process.argv[2] || '')
const cli = join(host, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const pnpm = join(host, 'node_modules/pnpm/bin/pnpm.cjs')
assert.ok(existsSync(cli) && existsSync(pnpm), 'Supply a DSH Desktop resources/app directory')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const archive = join(root, 'dist', `${pkg.name}-${pkg.version}.tgz`)
assert.ok(existsSync(archive), 'Run scripts/pack.mjs first')
mkdirSync(join(root, '.test-state'), { recursive: true })
const test = mkdtempSync(join(root, '.test-state/install-'))
const home = join(test, 'home')
const profile = join(home, 'profiles/quota-test')
const bin = join(test, 'bin')
mkdirSync(profile, { recursive: true })
mkdirSync(bin, { recursive: true })
// A file:basename spec avoids an upstream Windows shell quoting problem with spaces.
copyFileSync(archive, join(profile, 'plugin.tgz'))
writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'autoInstallPeers: false\n')
if (process.platform === 'win32') {
  writeFileSync(join(bin, 'pnpm.cmd'), `@echo off\r\n"${process.execPath}" "${pnpm}" %*\r\n`)
} else {
  throw new Error('This acceptance helper targets the installed Windows Desktop; unit CI is cross-platform')
}
const env = { ...process.env, DSH_HOME: home, PATH: `${bin};${dirname(process.execPath)};${process.env.PATH}`,
  npm_config_store_dir: join(root, '.compat/dsh-0.2.0-rc.2/.pnpm-store') }
function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { env, cwd: root, encoding: 'utf8', timeout: 120000, windowsHide: true })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}
run(['plugin', '--profile', 'quota-test', 'add', 'file:plugin.tgz', ...(process.argv.includes('--online') ? [] : ['--offline']), '--ignore-scripts'])
const manifest = () => JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
assert.ok(manifest().dsh.profile.bundles.includes(pkg.name), 'Plugin was not enabled by CLI reconciliation')
const installed = JSON.parse(readFileSync(join(profile, 'node_modules', pkg.name, 'package.json'), 'utf8'))
assert.equal(installed.version, pkg.version)
const composed = run(['--profile', 'quota-test', '--dump-config'])
assert.ok(composed.includes(pkg.name) && composed.includes('sjtu-quota'), 'Bundle patch missing from composed config')
const lifecycle = spawnSync(process.execPath, [join(root, 'scripts/verify-host.mjs'), host,
  join(profile, 'node_modules', pkg.name, 'src/index.js')], { env, cwd: root, encoding: 'utf8', timeout: 30000, windowsHide: true })
if (lifecycle.error) throw lifecycle.error
assert.equal(lifecycle.status, 0, `Installed package could not load against host:\n${lifecycle.stdout}\n${lifecycle.stderr}`)
assert.equal(JSON.parse(lifecycle.stdout).nativePluginLifecycle, 'passed')
run(['plugin', '--profile', 'quota-test', 'remove', pkg.name])
assert.ok(!manifest().dependencies?.[pkg.name], 'Dependency remained after uninstall')
assert.ok(!manifest().dsh.profile.bundles.includes(pkg.name), 'Bundle remained after uninstall')
assert.deepEqual(manifest().dsh.profile.bundles, ['@deepseek-ai/dsh-base'])
console.log(JSON.stringify({ installedVersion: installed.version, cliInstall: 'passed', composedPatch: 'passed', installedPackageLifecycle: 'passed', cliUninstall: 'passed', isolatedHome: home }))
