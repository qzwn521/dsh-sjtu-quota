import { lstatSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const files = ['package.json']
function include(path) {
  const full = resolve(root, path)
  if (!full.startsWith(root + sep)) throw new Error('Archive path escaped project')
  const stat = lstatSync(full)
  if (stat.isSymbolicLink()) throw new Error(`Refusing published symlink: ${path}`)
  if (stat.isDirectory()) for (const name of readdirSync(full).sort()) include(join(path, name))
  else if (stat.isFile()) files.push(relative(root, full).split(sep).join('/'))
}
for (const path of pkg.files) include(path)
const parts = []
for (const path of [...new Set(files)].sort()) {
  const bytes = readFileSync(join(root, path))
  const name = `package/${path}`
  if (!/^[\x20-\x7e]+$/.test(name) || Buffer.byteLength(name) > 100) throw new Error(`Unsupported tar filename: ${name}`)
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'ascii')
  const octal = (number, at, length) => header.write(number.toString(8).padStart(length - 1, '0') + '\0', at, length, 'ascii')
  octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8)
  octal(bytes.length, 124, 12); octal(0, 136, 12)
  header.fill(32, 148, 156); header.write('0', 156)
  header.write('ustar\0', 257, 6); header.write('00', 263, 2)
  header.write([...header].reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8)
  parts.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512))
}
parts.push(Buffer.alloc(1024))
const archive = gzipSync(Buffer.concat(parts), { level: 9 })
const directory = join(root, 'dist')
mkdirSync(directory, { recursive: true })
const filename = `${pkg.name}-${pkg.version}.tgz`
writeFileSync(join(directory, filename), archive)
const sha256 = createHash('sha256').update(archive).digest('hex')
writeFileSync(join(directory, 'SHA256SUMS.txt'), `${sha256}  ${filename}\n`)
console.log(JSON.stringify({ filename, bytes: archive.length, files: files.sort(), sha256 }))
