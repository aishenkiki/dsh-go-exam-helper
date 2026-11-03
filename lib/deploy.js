// 把 payload 里的运行时文件部署到工作目录。只在引擎启动、插件加载时跑一次。
// 裁决依据只有一个：目标目录 VERSION 与 payload VERSION 的比较。
import fs from 'node:fs'
import path from 'node:path'

// payload 里哪些顶层条目属于"运行时"；其余（bench/、shots/、answers.json 等）不碰。
export const RUNTIME = ['watch.mjs', 'phone.mjs', 'ctl.sh', 'VERSION', 'lib', 'bank.json.example']

export function readVersion (dir) {
  try {
    const v = fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim()
    return v === '' ? null : v
  } catch {
    return null
  }
}

export function compareVersion (a, b) {
  const pa = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

function stamp () {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// 只拷 RUNTIME 里的顶层条目到临时目录，成功后 rename 到位，避免半成品目录。
function copyRuntime (payloadDir, tmpDir) {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.mkdirSync(tmpDir, { recursive: true })
  for (const name of RUNTIME) {
    const src = path.join(payloadDir, name)
    if (!fs.existsSync(src)) continue
    fs.cpSync(src, path.join(tmpDir, name), { recursive: true })
  }
}

export function ensureDeployed ({ payloadDir, targetDir, warn = () => {} }) {
  const payloadVersion = readVersion(payloadDir)
  if (payloadVersion === null) {
    warn('[exam-helper] payload 缺少 VERSION，跳过部署')
    return { action: 'no-payload' }
  }

  const targetVersion = readVersion(targetDir)
  if (targetVersion === payloadVersion) {
    return { action: 'current', version: payloadVersion }
  }
  if (targetVersion !== null && compareVersion(payloadVersion, targetVersion) <= 0) {
    warn(`[exam-helper] 目标版本 ${targetVersion} 不低于 payload ${payloadVersion}，不覆盖`)
    return { action: 'keep-target', version: targetVersion }
  }

  const tmpDir = `${targetDir}.tmp`
  copyRuntime(payloadDir, tmpDir)

  const existed = fs.existsSync(targetDir)
  if (existed) {
    const bak = `${targetDir}.bak-${stamp()}`
    fs.renameSync(targetDir, bak)
    warn(`[exam-helper] 旧版本（${targetVersion ?? '无 VERSION'}）已备份到 ${bak}`)
  }
  fs.mkdirSync(path.dirname(targetDir), { recursive: true })
  fs.renameSync(tmpDir, targetDir)
  return { action: existed ? 'upgrade' : 'deploy', version: payloadVersion }
}
