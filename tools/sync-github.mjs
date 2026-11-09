// 把当前目录同步到 GitHub 仓库（Contents API 逐文件 PUT）。
// 用法：node tools/sync-github.mjs [版本号]
// 依赖：/root/.dsh/secrets/github-token（0600）
import fs from 'node:fs'
import path from 'node:path'

const token = fs.readFileSync('/root/.dsh/secrets/github-token', 'utf8').trim()
const owner = 'aishenkiki'
const repo = 'dsh-go-exam-helper'
const SKIP = new Set(['node_modules', '.git', 'TODO.md', '.npmrc'])
const version = process.argv[2] || JSON.parse(fs.readFileSync('package.json', 'utf8')).version

function walk (dir, base = '') {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const rel = base ? base + '/' + e.name : e.name
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p, rel))
    else out.push(rel)
  }
  return out
}

const api = (method, url, body) => fetch('https://api.github.com' + url, {
  method,
  headers: {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'dsh-release',
  },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }))

const files = walk('.')
let ok = 0
let bad = 0
for (const f of files) {
  const content = fs.readFileSync(f).toString('base64')
  const cur = await api('GET', `/repos/${owner}/${repo}/contents/${encodeURIComponent(f)}`)
  const sha = cur.status === 200 ? cur.json.sha : undefined
  const r = await api('PUT', `/repos/${owner}/${repo}/contents/${encodeURIComponent(f)}`, {
    message: `chore: sync ${f} (${version})`,
    content,
    sha,
    committer: { name: 'aishenkiki', email: 'aishenkiki@users.noreply.github.com' },
  })
  if (r.status === 200 || r.status === 201) ok++
  else { bad++; console.log('失败', f, r.status, (r.json && r.json.message) || '') }
}
console.log(`GitHub 同步：${ok} 个成功，${bad} 个失败（版本 ${version}）`)
if (bad) process.exit(1)
