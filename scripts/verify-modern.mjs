import { cpSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const project = resolve(fileURLToPath(new URL('..', import.meta.url)))
const host = resolve(project, '.compat/dsh-0.2.0-rc.2')
const installed = join(host, 'node_modules/dsh-sjtu-quota')
mkdirSync(installed, { recursive: true })
cpSync(join(project, 'src'), join(installed, 'src'), { recursive: true })
cpSync(join(project, 'package.json'), join(installed, 'package.json'))
const source = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
if (source.name !== 'dsh-sjtu-quota') throw new Error('Unexpected package')
process.argv[2] = host
process.argv[3] = join(installed, 'src/index.js')
await import(pathToFileURL(join(project, 'scripts/verify-host.mjs')))
