import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const draft = process.argv.includes('--draft')
const errors = [], pending = []
const check = (condition, message) => { if (!condition) errors.push(message) }
check(pkg.name === 'dsh-sjtu-quota', 'Package identity changed unexpectedly')
check(/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(pkg.version), 'Invalid release version')
check(existsSync(join(root, pkg.main)), 'Main entry missing')
check(existsSync(join(root, pkg.dsh?.bundle?.patch ?? '_missing')), 'DSH bundle patch missing')
check(pkg.engines?.dsh && pkg.engines?.node, 'Compatibility declaration missing')
check(pkg.license === 'MIT', 'License missing')
check(pkg.keywords?.includes('dsh-plugin'), 'Discovery keyword missing')
check(!Object.keys(pkg.dependencies ?? {}).some(key => /^@deepseek-ai\/(?:dsh-|cordis$)/.test(key)), 'Host API cannot be an ordinary dependency')
check(!Object.keys(pkg.scripts ?? {}).some(key => ['preinstall', 'install', 'postinstall', 'prepare'].includes(key)), 'Unexpected install-time script')
check(pkg.disclosure?.cloud === false && pkg.disclosure.network.length === 0 && pkg.disclosure.apiKeys.length === 0, 'Data disclosure is inconsistent')
for (const file of pkg.files) check(existsSync(join(root, file)), `Missing published file: ${file}`)
const readme = readFileSync(join(root, 'README.md'), 'utf8')
check(!/[A-Z]:[\\/]|C:\\Users|Administrator|api_key:\s*[a-z0-9]{30}/i.test(readme), 'Personal path or credential-shaped data in README')
check(readme.includes('429') && readme.includes('providers'), 'Configuration documentation missing')
if (!/^git\+https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/.test(pkg.repository?.url ?? '')) pending.push('Public GitHub repository metadata not set')
if (!pkg.author) pending.push('Author identity not set')
if (readme.includes('__GITHUB_REPOSITORY__')) pending.push('Install command awaits actual repository')
console.log(JSON.stringify({ status: errors.length || (!draft && pending.length) ? 'not-ready' : draft && pending.length ? 'draft-checked' : 'ready', errors, pending }, null, 2))
if (errors.length || (!draft && pending.length)) process.exitCode = 1
