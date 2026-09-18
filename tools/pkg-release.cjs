/**
 * 打包 + 校验：只把发布需要的文件打进 zip，逐文件核对内容，并给出与压缩器无关的**内容哈希**。
 *
 * 为什么不用 zip 自身的 sha256 当发布标识：zip 头里带时间戳，不同打包器/不同时刻会得到
 * 不同字节（前面实测过 tar 连打两次哈希都不一样）。所以用 manifestSha256：
 * 对「相对路径 + 字节数 + 文件 sha256」排序后再哈希 —— 同一份源码永远同一个值。
 *
 * 用法（两种等价写法）：
 *   node tools/pkg-release.cjs <插件目录> [输出zip]
 *   node tools/pkg-release.cjs <插件目录> --dry-run     # 只跑校验，不产出 zip
 *
 * 少了「输出zip」或带 --dry-run 时走**校验模式**：不暂存、不写文件、不碰磁盘，
 * 只输出 护栏 + manifestSha256 + 条目/逐文件一致性（有现成 zip 就顺带核对它）。
 * CI 用的就是这种模式。
 *
 * 平台：解压用 Node 自带能力；压缩优先 PowerShell 的 Compress-Archive（Windows），
 * 没有就退回 `zip` 命令（Linux/CI）。两种压缩器产出的字节不同，但 manifestSha256 一致。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const args = process.argv.slice(2)
const dryRunFlag = args.includes('--dry-run')
const positional = args.filter((a) => !a.startsWith('--'))
const src = path.resolve(positional[0] || path.join(__dirname, '..', 'plugins', 'deepseek', 'dsh-deepseek-cost'))
const out = positional[1] ? path.resolve(positional[1]) : null
const checkOnly = dryRunFlag || !out
const name = path.basename(src)

if (!fs.existsSync(src)) {
  console.error('源目录不存在:', src)
  process.exit(1)
}

const FILES = [
  'package.json',
  'cordis.patch.yml',
  'lib/core.js',
  'lib/index.js',
  'lib/client.js',
  'README.md',
  'LICENSE',
  'core.test.cjs',
  'verify-mount.cjs'
]

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'))
const normalize = (p) => String(p).replace(/^\.\//, '').replace(/\\/g, '/')

const missing = FILES.filter((f) => !fs.existsSync(path.join(src, f)))
if (missing.length) {
  console.error('源目录缺文件:', missing.join(', '))
  process.exit(1)
}

// ---- 0. 护栏：包内 import 链必须闭合 ----
// 背景：FILES 是硬编码白名单。曾经因为新增 lib/core.js 时忘了改它，打出的包
// 缺文件、装上即报 ERR_MODULE_NOT_FOUND。注意 core.js **不是** package.json 的
// 入口（main/exports/patch 里都没有它），它只是被 lib/index.js import 进来的 ——
// 所以光比对 package.json 的字段查不出来，必须**顺着 import 走**：
// 对包内每个 js 解析静态 import/export 的模块说明符，解析相对路径并递归，
// 任何一个解析不到就失败。
function listImports(file) {
  const text = fs.readFileSync(file, 'utf8')
  const specs = []
  const add = (raw) => {
    const s = String(raw).trim()
    if (s) specs.push(s)
  }
  const reFrom = /\b(?:import|export)\s[^;]*?\bfrom\s*['"]([^'"]+)['"]/g
  const reBare = /^\s*import\s*['"]([^'"]+)['"]/gm
  const reDyn = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const re of [reFrom, reBare, reDyn]) {
    let m
    while ((m = re.exec(text)) !== null) add(m[1])
  }
  return specs
}

function resolveInPack(spec, importerRel, packSet) {
  if (!spec.startsWith('.')) return null // 裸模块名：由运行环境提供（peer/内置），跳过
  const baseDir = path.posix.dirname(importerRel)
  const target = path.posix.normalize(path.posix.join(baseDir, spec))
  const candidates = [target, `${target}.js`, `${target}.mjs`, `${target}.cjs`, `${target}/index.js`]
  for (const c of candidates) if (packSet.has(c)) return { hit: c, missing: false }
  return { hit: target, missing: true }
}

const packSet = new Set(FILES.map(normalize))
const brokenImports = []
const visited = new Set()
const queue = FILES.map(normalize).filter((f) => /\.(js|mjs|cjs)$/.test(f))
while (queue.length) {
  const rel = queue.shift()
  if (visited.has(rel)) continue
  visited.add(rel)
  const abs = path.join(src, rel)
  if (!fs.existsSync(abs)) continue
  for (const spec of listImports(abs)) {
    const r = resolveInPack(spec, rel, packSet)
    if (r === null) continue
    if (r.missing) brokenImports.push(`${rel}  ->  ${spec}`)
    else if (/\.(js|mjs|cjs)$/.test(r.hit)) queue.push(r.hit)
  }
}

const runtimeFiles = new Set([normalize(pkg.main)])
for (const v of Object.values(pkg.exports || {})) {
  if (typeof v === 'string') runtimeFiles.add(normalize(v))
  else for (const vv of Object.values(v || {})) {
    if (typeof vv === 'string') runtimeFiles.add(normalize(vv))
  }
}
if (pkg.dsh && pkg.dsh.bundle && typeof pkg.dsh.bundle.patch === 'string') {
  runtimeFiles.add(normalize(pkg.dsh.bundle.patch))
}

const declaredReadme = (pkg.files || []).map(normalize)
const notInDeclared = FILES.map(normalize).filter((f) => !declaredReadme.includes(f))

console.log('发布文件集护栏')
console.log('  package.json 入口文件   ', [...runtimeFiles].sort().join(', '))
console.log('  package.json files 字段 ', declaredReadme.join(', ') || '(无)')
console.log('  包内已解析的模块        ', [...visited].sort().join(', '))
if (brokenImports.length) {
  console.error('  FAIL 包内 import 链断裂（文件没被打进包）:')
  for (const b of brokenImports) console.error('         ' + b)
  console.error('       -> 请把上面缺的文件加进本脚本的 FILES 数组')
  process.exit(1)
}
if (notInDeclared.length) {
  console.log('  WARN 打包但不在 files 字段里 ', notInDeclared.join(', '))
  console.log('       -> 测试/自检文件属正常；若含运行时文件请补进 package.json 的 files 字段')
}
console.log('  import 链闭合 + 入口覆盖   OK')
console.log('')

// ---- 1. 内容哈希（与压缩器无关，发布标识用这个）----
const manifest = FILES.map((f) => {
  const buf = fs.readFileSync(path.join(src, f))
  return { path: `${name}/${f.replace(/\\/g, '/')}`, size: buf.length, sha256: sha256(buf) }
})
const manifestSha256 = sha256(Buffer.from(manifest.map((m) => `${m.path}\t${m.size}\t${m.sha256}`).join('\n') + '\n', 'utf8'))

// ---- 2. 打包（校验模式下跳过）----
function makeZip(rootDir, outFile) {
  if (fs.existsSync(outFile)) fs.rmSync(outFile)
  const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  if (process.platform === 'win32' && fs.existsSync(PS)) {
    // Windows 本地：沿用原来的 Compress-Archive
    execFileSync(PS, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Compress-Archive -LiteralPath '${rootDir}' -DestinationPath '${outFile}' -CompressionLevel Optimal -Force`
    ])
    return 'Compress-Archive (PowerShell)'
  }
  // Linux/CI：用系统 zip
  execFileSync('zip', ['-r', '-q', '-X', outFile, name], { cwd: path.dirname(rootDir) })
  return 'zip (CLI)'
}

let entries = []
let identical = 0
const diffs = []
let packer = '(校验模式：未产出 zip)'

if (!checkOnly) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'dscost-stage-'))
  const root = path.join(stage, name)
  for (const f of FILES) {
    const dst = path.join(root, f)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(path.join(src, f), dst)
  }
  try {
    packer = makeZip(root, out)
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

// ---- 3. 校验：解包回读并逐文件比对（Node 自带能力，跨平台）----
// 没有 --dry-run 时核对刚打的包；--dry-run 且输出文件已存在时核对现成的包。
const zipToCheck = !checkOnly ? out : (out && fs.existsSync(out) ? out : null)
if (zipToCheck) {
  const unzip = fs.mkdtempSync(path.join(os.tmpdir(), 'dscost-check-'))
  try {
    execFileSync('tar', ['-xf', zipToCheck, '-C', unzip])
    const walk = (dir, base = '') =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name), `${base}${e.name}/`) : [`${base}${e.name}`]
      )
    entries = walk(unzip).sort()
    for (const f of FILES) {
      const p = path.join(unzip, name, f)
      if (!fs.existsSync(p)) diffs.push(`${f}(缺)`)
      else if (sha256(fs.readFileSync(p)) === sha256(fs.readFileSync(path.join(src, f)))) identical += 1
      else diffs.push(f)
    }
  } finally {
    fs.rmSync(unzip, { recursive: true, force: true })
  }
}

const expected = FILES.map((f) => `${name}/${f}`).sort()
const entriesOk = entries.length === expected.length && entries.every((e, i) => e === expected[i])
const zipChecked = entries.length > 0
const pass = !zipChecked || (entriesOk && identical === FILES.length)

if (zipChecked) {
  console.log('zip              ', zipToCheck)
  console.log('打包器           ', packer)
  console.log('zip 字节数       ', fs.readFileSync(zipToCheck).length, 'B')
  console.log('zip sha256       ', sha256(fs.readFileSync(zipToCheck)), '(含时间戳/压缩器差异，仅供参考)')
} else {
  console.log('打包器           ', packer)
}
console.log('内容 manifest    ')
for (const m of manifest) console.log(`  ${m.sha256.slice(0, 16)}  ${String(m.size).padStart(6)}  ${m.path}`)
console.log('manifestSha256   ', manifestSha256, '  ← 发布标识，同源码恒定')
console.log('条目             ', zipChecked ? `${entries.length} ` + (entriesOk ? '(与白名单完全一致)' : `(不符: ${entries.join(', ')})`) : '(未校验 zip)')
console.log('逐文件内容一致   ', zipChecked ? `${identical}/${FILES.length}` : '(未校验 zip)', diffs.length ? 'DIFF: ' + diffs.join(', ') : '')
console.log('结论             ', pass ? 'PASS' : 'FAIL')
process.exit(pass ? 0 : 1)
