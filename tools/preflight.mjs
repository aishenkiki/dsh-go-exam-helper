// 发布前自检：把「清单声明的」和「代码里注册的」对一遍，防 1.2.3 之前那种漂移。
// 用法：node tools/preflight.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const src = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')

const problems = []
const notes = []
const ok = (msg) => notes.push(`  ✓ ${msg}`)
const bad = (msg) => problems.push(`  ✗ ${msg}`)

const man = pkg.dshGo?.contributes ?? {}
const one = (arr) => (Array.isArray(arr) ? arr : []).map((x) => (typeof x === 'string' ? x : x.id))
const pick = (re, text) => [...text.matchAll(re)].map((m) => m[1])

// 1. 模块名：package.json / cordis.patch.yml / lib/index.js 三处必须一致
const pkgName = pkg.name
const patchNames = pick(/^\s*-?\s*name:\s*(\S+)\s*$/gm, patch)
const codeName = pick(/export const name\s*=\s*['"]([^'"]+)/g, src)[0]
if (patchNames.length === 0) bad('cordis.patch.yml 里没有 name')
else if (patchNames.some((n) => n !== pkgName)) bad(`cordis.patch.yml 的 name (${patchNames.join(',')}) ≠ package.json (${pkgName})`)
else ok(`模块名一致：${pkgName}`)
if (codeName && codeName !== pkgName) bad(`lib/index.js 的 name (${codeName}) ≠ package.json (${pkgName})`)
else if (codeName) ok(`代码 name 一致：${codeName}`)

// 2. 面板 id
const manPanels = one(man.panels)
const codePanels = pick(/\.panel\(\s*['"]([^'"]+)/g, src)
for (const id of manPanels) codePanels.includes(id) ? ok(`面板 ${id} 已注册`) : bad(`清单声明了面板 ${id}，代码里没注册`)
for (const id of codePanels) manPanels.includes(id) ? null : bad(`代码注册了面板 ${id}，清单里没声明`)

// 3. 状态条 id
const manStrips = one(man['composer.strip'])
const codeStrips = pick(/\.strip\(\s*['"]([^'"]+)/g, src)
for (const id of manStrips) codeStrips.includes(id) ? ok(`状态条 ${id} 已注册`) : bad(`清单声明了状态条 ${id}，代码里没注册`)
for (const id of codeStrips) manStrips.includes(id) ? null : bad(`代码注册了状态条 ${id}，清单里没声明`)

// 4. 状态条 / 胶囊引用的 panel 必须存在
for (const item of [...(man['composer.strip'] ?? []), ...(man['composer.actions'] ?? [])]) {
  if (item.panel && !manPanels.includes(item.panel)) bad(`${item.id} 指向不存在的面板 ${item.panel}`)
}

// 5. 视图里引用的 action / submit，代码里必须有同名处理函数
const refs = new Set([...pick(/action:\s*['"]([^'"]+)/g, src), ...pick(/submit:\s*['"]([^'"]+)/g, src)])
const actionsBlock = src.slice(src.indexOf('actions: {'))
const impl = new Set([...actionsBlock.matchAll(/^\s{6,8}(\w+)\s*[:(]/gm)].map((m) => m[1]))
for (const r of refs) impl.has(r) ? ok(`动作 ${r} 已实现`) : bad(`视图引用了动作 ${r}，actions 里没有实现`)

// 6. payload 必须覆盖 deploy 的 RUNTIME
const deploySrc = fs.readFileSync(path.join(ROOT, 'lib', 'deploy.js'), 'utf8')
const runtime = pick(/RUNTIME\s*=\s*\[([^\]]*)\]/g, deploySrc)[0]
const wanted = runtime ? runtime.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : []
for (const f of wanted) {
  fs.existsSync(path.join(ROOT, 'payload', f)) ? ok(`payload 有 ${f}`) : bad(`payload 缺少 RUNTIME 里的 ${f}`)
}
const version = fs.readFileSync(path.join(ROOT, 'payload', 'VERSION'), 'utf8').trim()
version === pkg.version ? ok(`VERSION 与 package.json 一致：${version}`) : bad(`payload/VERSION (${version}) ≠ package.json (${pkg.version})`)

// 7. 旧名字残留
const stale = ['local-exam-helper', 'exam-status'].filter((s) => src.includes(s) || patch.includes(s) || JSON.stringify(pkg.dshGo).includes(s))
stale.length ? bad(`还有旧名字残留：${stale.join(', ')}`) : ok('没有旧名字残留')

console.log(notes.join('\n'))
if (problems.length) {
  console.log('\n' + problems.join('\n'))
  console.log(`\n预检失败：${problems.length} 个问题`)
  process.exit(1)
}
console.log('\n预检通过')
