// 读 watcher 的运行状态与最近几条作答，供面板显示。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function isAlive (pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM' // 进程在，但没权限发信号
  }
}

// ctl.sh 和 watch.mjs 把 pid 写在部署目录外（升级改名不丢），这里必须读同一把锁。
export function lockPath () {
  return process.env.DSH_EXAM_LOCK || path.join(os.homedir(), '.dsh', 'exam-helper-watch.pid')
}

export function readPid (dir) {
  for (const file of [lockPath(), path.join(dir, 'watcher.pid')]) {
    try {
      const n = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10)
      if (Number.isInteger(n) && n > 0) return n
    } catch {}
  }
  return null
}

// 日志行形如：`12:41:36 作答 第 5 题 · A push() | 以下哪个方法…`
export function recentAnswers (dir, limit = 5) {
  let text = ''
  try {
    text = fs.readFileSync(path.join(dir, 'watch.log'), 'utf8')
  } catch {
    return []
  }
  const out = []
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    // 标题现在可能带「📚 」（题库命中）和「?」（低置信）
    const m = lines[i].match(/^\S+ 作答 (第\s*\d+\s*题\s*·\s*(?:📚\s*)?[A-F]\??)\s*(.*?)\s*\|\s*(.*)$/)
    if (!m) continue
    const opt = m[2].replace(/\s+/g, ' ').trim()
    out.push({ title: m[1].replace(/\s+/g, ' '), subtitle: opt === '' ? m[3] : opt.slice(0, 40) })
  }
  return out
}

// 最近一次异常：断线、截图失败、拿不到答案之类，用来判断它还在不在正常工作。
export function lastError (dir) {
  let text = ''
  try {
    text = fs.readFileSync(path.join(dir, 'watch.log'), 'utf8')
  } catch {
    return null
  }
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = lines[i].match(/^(\S+) (ERR|视觉失败|截图失败|没拿到答案)\s*(.*)$/)
    if (m) return { at: m[1], text: (m[2] + ' ' + m[3]).trim().slice(0, 80) }
  }
  return null
}

export function readStatus (dir, limit = 5) {
  const pid = readPid(dir)
  const running = isAlive(pid)
  return { running, pid: running ? pid : null, recent: recentAnswers(dir, limit), error: lastError(dir) }
}
