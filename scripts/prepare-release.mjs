import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const repository = (process.argv[2] ?? '').replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '')
if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i.test(repository)) throw new Error('Supply actual GitHub owner/repository')
const [owner, repo] = repository.split('/')
const file = join(root, 'package.json')
const pkg = JSON.parse(readFileSync(file, 'utf8'))
if (pkg.repository?.url && pkg.repository.url !== `git+https://github.com/${repository}.git`) throw new Error('Repository already belongs to a different identity')
Object.assign(pkg, { author: owner, repository: { type: 'git', url: `git+https://github.com/${repository}.git` },
  homepage: `https://github.com/${repository}#readme`, bugs: { url: `https://github.com/${repository}/issues` } })
writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
for (const name of ['README.md', 'README.en.md']) {
  const path = join(root, name)
  writeFileSync(path, readFileSync(path, 'utf8').replaceAll('__GITHUB_REPOSITORY__', repository))
}
mkdirSync(join(root, 'release'), { recursive: true })
const submission = `url: https://github.com/${repository}\nname: ${repository}\ncategory: usage\ndescription:\n  en: 'Paces SJTU API requests against token and request budgets, records local usage, and resumes agent steps after transient rate limits.'\n  zh: '按上交 API 的 Token 和请求数预算排队，统计本地用量，并在临时限流后恢复模型步骤。'\n`
const filename = `${owner}__${repo}.yml`
const tarball = `https://github.com/${repository}/releases/download/v${pkg.version}/${pkg.name}-${pkg.version}.tgz`
writeFileSync(join(root, 'release', filename), submission + `tarball: ${tarball}\n`)
console.log(JSON.stringify({ repository, submissionFile: `release/${filename}`, published: false }))
