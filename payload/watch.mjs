// 考试助手 v4：盯屏 → 认题 → 答题 → 顶部横幅。
// 设计要点：
//   1. 只认「四个选项按顺序出现」的页面，别的界面一律不动；
//   2. 题目指纹 = 题号 + 选项原文，OCR 抖动不会造成重复弹；
//   3. 同一指纹稳定两拍才作答，避免翻页瞬间误判；
//   4. 答案按指纹缓存，同一题永远同一个答案，重进也不重算；
//   5. 单实例锁，杜绝多份进程抢同一块屏幕。
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { connect } from './phone.mjs'
import { parseScreen, signature, looksLikeQuestion } from './lib/parse.mjs'
import { createAnswerer } from './lib/model.mjs'
import { analyze, analyzeFast } from './lib/pipeline.mjs'
import { readAndAnswer } from './lib/vision.mjs'
import { loadBank, norm } from './lib/bank.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const LOCK = DIR + '/watcher.pid'
const LOG = DIR + '/watch.log'
const MIN_STABLE = 2
const bank = loadBank(DIR) // 有 bank.json 就先查表，命中就直接用官方答案

// 题库里的答案字母对应题库自己的选项顺序；App 上的选项顺序可能不同，必须按文字重新对位。
// 对不上就说明这条题库记录和屏幕上的题不是同一版，宁可放弃也不能弹错。
function bankLetter (hit, opts) {
  const target = norm(hit.text)
  if (!target || !opts || !opts.length) return hit.answer
  for (const o of opts) {
    const t = norm(o.text)
    if (t && (t === target || t.includes(target) || target.includes(t))) return o.letter
  }
  return null
}

function tryBank (question, opts) {
  if (!bank || !question) return null
  const hit = bank.lookup(question, opts)
  if (!hit) return null
  const letter = bankLetter(hit, opts)
  if (!letter) return null
  return { ...hit, answer: letter }
}

const LOG_MAX = 2 * 1024 * 1024
let logWrites = 0
let lastErrMsg = ''
let lastErrAt = 0
let errRepeat = 0

// 日志超过 2 MB 就轮转成 watch.log.1（只留一代），长时间监考不会把盘写满。
function rotateIfNeeded () {
  try {
    if (fs.statSync(LOG).size > LOG_MAX) fs.renameSync(LOG, LOG + '.1')
  } catch {}
}

// 长期使用会攒下大量截图（每题一张），旧的对诊断没用了：只留最近的几张。
// 日志本身不用担心：watch.log + watch.log.1 两个文件封顶 4 MB。
const CORPUS_KEEP = 200
const FAIL_KEEP = 60
function pruneOld (dir, keep, filter) {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => filter(f))
      .map((f) => ({ f, t: fs.statSync(dir + '/' + f).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const { f } of files.slice(keep)) {
      try { fs.unlinkSync(dir + '/' + f) } catch {}
    }
  } catch {}
}
pruneOld(DIR + '/corpus/auto', CORPUS_KEEP, () => true)
pruneOld(DIR, FAIL_KEEP * 2, (f) => /^fail-/.test(f))

const log = (...a) => {
  const line = new Date().toISOString().slice(11, 19) + ' ' + a.join(' ')
  try {
    fs.appendFileSync(LOG, line + '\n')
    logWrites += 1
    if (logWrites % 500 === 0) rotateIfNeeded()

  } catch {}
}

// 同类错误 30 秒内只记一条，避免断线时把日志刷爆。
function logErr (msg) {
  const now = Date.now()
  if (msg === lastErrMsg && now - lastErrAt < 30000) { errRepeat += 1; return }
  log('ERR', msg, errRepeat > 0 ? `(同类又 ${errRepeat} 次)` : '')
  lastErrMsg = msg
  lastErrAt = now
  errRepeat = 0
}

rotateIfNeeded()

function takeLock () {
  try {
    const pid = Number(fs.readFileSync(LOCK, 'utf8'))
    if (pid && pid !== process.pid) {
      process.kill(pid, 0)          // 还活着就退出，保证只有一份
      console.error('已有实例在跑：' + pid)
      process.exit(0)
    }
  } catch {}
  fs.writeFileSync(LOCK, String(process.pid))
}

function releaseLock () {
  try {
    if (Number(fs.readFileSync(LOCK, 'utf8')) === process.pid) fs.unlinkSync(LOCK)
  } catch {}
}

const withTimeout = (p, ms, what) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' 超时')), ms)),
])

const creds = fs.readFileSync('/root/.dsh/.credentials.yaml', 'utf8')
const token = creds.match(/deepseek-account-platform\/default:[\s\S]*?token: (\S+)/)[1]

takeLock()
process.on('exit', releaseLock)
process.on('SIGTERM', () => { releaseLock(); process.exit(0) })
process.on('SIGINT', () => { releaseLock(); process.exit(0) })

const answer = createAnswerer({ token, cacheFile: DIR + '/answers.json', log })

// done: 已答题 → 最后一次弹通知的时间（毫秒）
const state = { examSeen: false, sig: '', stable: 0, screen: null, attempts: new Map(), lastRejected: '', lastApp: '', lastAt: 0, ocrProg: 0, shownSig: '' }

async function shoot (p) {
  const r = await withTimeout(p.callTool('screen', { image: true }), 8000, '截图')
  const img = (r.images || [])[0]
  if (!img || !img.data) return null
  const file = DIR + '/shot.jpg'
  fs.writeFileSync(file, Buffer.from(img.data, 'base64'))
  return file
}

async function tick (p) {
  const t0 = Date.now()
  const r = await withTimeout(p.callTool('screen', {}), 6000, '读屏')
  const dump = r.text || ''
  if (!dump || /DSH 自己的界面/.test(dump) || /· DSH Go ·/.test(dump)) { state.sig = ''; state.stable = 0; return }

  let screen = parseScreen(dump)

  // 同一 App 刚才还能认出题、这一屏却认不出（无障碍结构变了/被折叠了）：
  // 给它一次纯 OCR 的机会，避免因为界面结构变化就整段失效。
  if (!screen.isQuestion && screen.app && screen.app === state.lastApp && Date.now() - state.lastAt < 5 * 60_000) {
    const shot = await shoot(p)
    const got = shot ? await analyze(shot, []) : null
    if (got && !got.weak && got.question.length >= 8 && got.options.length >= 3) {
      screen = { ...screen, isQuestion: true, question: got.question, opts: got.options }
      log('OCR 兜底', got.how, got.question.slice(0, 24))
    }
  }

  // 是不是「题目页」：认得出题，并且页面像个答题界面。
  // 不限 App——正式考试可能是浏览器网页、微信扫开的 H5、或小程序，所以只认界面特征：
  // 有题号进度 / 有考试导航按钮 / 题干是问句。三样都没有就不动手。
  // 诊断用：题目页但无障碍没给出题干时，把原始屏读存一份，用来确认题干到底在不在无障碍树里
  if (screen.isQuestion && !screen.question) {
    try { fs.writeFileSync(DIR + '/debug-noq.txt', dump) } catch {}
  }
  const NAV = /下一题|上一题|答题卡|单选题|多选题|判断题|提交试卷|交卷/
  const examish = screen.isQuestion &&
    (!!screen.prog || NAV.test(dump) || /[？?]\s*$/.test(screen.question || ''))
  const multi = MULTI.test(dump)   // 多选题：模型要给出多个字母
  state.examSeen = examish
  if (!examish) {
    state.sig = ''
    state.stable = 0
    return
  }

  const sig = screen.isQuestion
    ? signature(screen)
    : 'app:' + screen.app + ':q' + (screen.prog ? screen.prog.current : '?')

  if (sig !== state.sig) {
    state.sig = sig
    state.attempts.delete(sig)   // 每次重新进入这道题都重新给两次机会，否则切几次后就再也不弹了
    state.stable = 1
    state.screen = screen
    return                       // 等下一拍确认稳定
  }
  state.stable++
  // 有题号进度说明是正规答题页，题号+选项一起变就是换题了，等一拍就够（省 0.9 秒）；
  // 没有题号的页面保守一点，等两拍，避免拍到过渡动画。
  if (state.stable < (screen.prog ? 1 : MIN_STABLE)) return

  if (sig === state.shownSig) return      // 还停在同一题上，不重复弹；翻走再翻回来会重新弹
  const tries = state.attempts.get(sig) || 0
  if (tries >= 2) return                    // 最多重试两次，避免失败时狂刷
  state.attempts.set(sig, tries + 1)

  let graphicReason = ''
  let question = screen.question
  let opts = screen.opts
  let letter = null
  let conf = 'high'
  let fromBank = null                     // 命中题库时记下来，标题加 📚、正文标「题库：」

  const cKey = createHash('sha1')
    .update(question + '|' + opts.map((o) => o.letter + o.text).join('|'))
    .digest('hex').slice(0, 12)

  // 第 0 步：题库查表（官方答案，比模型准，也不花钱）
  if (question) {
    fromBank = tryBank(question, opts)
    if (fromBank) {
      letter = fromBank.answer
      conf = 'high'
      log('题库', fromBank.match, letter, question.slice(0, 24))
    }
  }

  // 快路：无障碍里题干和选项都齐全，直接用文字模型（快、准、不花图片钱）
  if (!letter && question && opts.length >= 3 && looksLikeQuestion(question)) {
    // 选项是图片时文字模型没法答，交给下面的视觉路
    if (!blankOpts(opts)) {
      const a = await answer(cKey, question, opts, multi)
      if (a) { letter = a.letter; conf = a.confidence }
    }
  }

  // 慢路：读不全就截图交给多模态模型，一次拿全（题干/选项/答案）
  if (!letter) {
    const shot = await shoot(p)
    if (!shot) { log('截图失败', sig.slice(0, 6)); return }

    // 先本地 OCR 一次（约 0.8 秒）拿题干查题库：命中就不用调视觉模型，省约 1 秒和一次调用费。
    // 查表本身还有相似度阈值和选项对位把关，OCR 认错字最多导致不命中，不会导致弹错。
    state.ocrProg = 0 // 每拍重算，别把上一题的题号带到这一题
    const quick = await analyzeFast(shot, screen.opts)
    if (quick && quick.prog) state.ocrProg = quick.prog.current
    if (quick && quick.ok) {
      const qOpts = screen.opts.length >= 3 ? screen.opts : quick.options
      fromBank = tryBank(quick.question, qOpts)
      // 长题干只取后 3 行，开头常被丢掉：用多收两行的备选再查一次
      if (!fromBank && quick.questionAlt) fromBank = tryBank(quick.questionAlt, qOpts)
      if (fromBank) {
        opts = qOpts
        letter = fromBank.answer
        conf = 'high'
        log('题库-fast', fromBank.match, letter, quick.question.slice(0, 24))
      }
    }
    // 单次 OCR 没命中（认错字/版面抖动）：换多候选 OCR 再试一次，仍不中才走视觉模型
    if (!letter) {
      const multi = await analyze(shot, screen.opts)
      if (multi && !multi.weak && multi.question) {
        const wOpts = screen.opts.length >= 3 ? screen.opts : multi.options
        fromBank = tryBank(multi.question, wOpts)
        if (fromBank) {
          opts = wOpts
          letter = fromBank.answer
          conf = 'high'
          log('题库-多候选', fromBank.match, letter, multi.question.slice(0, 24))
        }
      }
    }

    // 图形题：题干和选项都不是文字（或要描述图形），普通"抄题干"提示词只会返回空，得走专用提示词
    const noText = !question || !looksLikeQuestion(question)
    const isGraphic = GRAPHIC.test(question || '') || (noText && (blankOpts(screen.opts) || screen.opts.length === 0))

    let v = null
    if (!letter) {
      try {
        v = await readAndAnswer(shot, { token, fs, multi, graphic: isGraphic })
      } catch (e) { log('视觉失败', e.message) }
    }

    if (letter) {
      // 题库已答，不再看视觉结果（也根本没调）
    } else if (v) {
      question = v.question
      opts = v.options
      fromBank = tryBank(question, opts)
      if (fromBank) {
        letter = fromBank.answer
        conf = 'high'
        log('题库', fromBank.match, letter, question.slice(0, 24))
      }
      if (!letter) {
        letter = v.answer
        conf = v.confidence || 'high'
        if (v.reason) graphicReason = v.reason
      }
      log('视觉', question.slice(0, 26), letter, conf === 'low' ? '(存疑)' : '')
      try {
        fs.mkdirSync(DIR + '/corpus/auto', { recursive: true })
        const name = String(Date.now()).slice(-7)
        fs.copyFileSync(shot, DIR + '/corpus/auto/' + name + '.jpg')
        fs.writeFileSync(DIR + '/corpus/auto/' + name + '.json',
          JSON.stringify({ question, options: opts, answer: letter, how: 'vision' }))
      } catch {}
    } else {
      // 视觉也不行，退回 OCR 版面分析
      const got = await analyze(shot, screen.opts)
      if (!got || got.weak) {
        const tag = String(Date.now()).slice(-7)
        try { fs.copyFileSync(shot, DIR + '/fail-' + tag + '.jpg') } catch {}
        try { fs.copyFileSync(shot.replace(/\.jpg$/, '-ocr.txt'), DIR + '/fail-' + tag + '.txt') } catch {}
        log('切不出题干', sig.slice(0, 6), got ? '分数' + got.score : '', '→ fail-' + tag)
        return
      }
      question = got.question
      opts = screen.opts.length >= 3 ? screen.opts : got.options
      log('OCR', got.score, got.how, question.slice(0, 24))
      fromBank = tryBank(question, opts)
      if (fromBank) {
        letter = fromBank.answer
        conf = 'high'
        log('题库', fromBank.match, letter, question.slice(0, 24))
      }
      if (!letter) {
        const a2 = await answer(sig, question, opts, multi)
        if (a2) { letter = a2.letter; conf = a2.confidence }
      }
    }
  }

  if (!letter) { log('没拿到答案', sig.slice(0, 6)); return }

  // 同一道题（题干+选项相同）只答一次，且永远用同一个答案
  if (sig === state.shownSig) return

  const picked = opts.filter((o) => String(letter).includes(o.letter))
  const no = (screen.prog && screen.prog.current) || state.ocrProg || '?'
  const doubt = conf === 'low'
  const title = `第 ${no} 题 · ${fromBank ? '📚 ' : ''}${letter}${doubt ? '?' : ''}`
  const body = (picked.map((o) => o.text).join('；') || graphicReason || '').slice(0, 60)
  const text = fromBank ? `题库：${body}` : doubt ? `存疑：${body}` : body
  await p.callTool('notify', { title, text })
  state.shownSig = sig
  state.lastApp = screen.app
  state.lastAt = Date.now()
  log('作答', title, body, '|', question.slice(0, 30), doubt ? '| 存疑' : fromBank ? '| 题库' : '',
    '| ' + (Date.now() - t0) + 'ms')
}

const MULTI = /多选题/
const GRAPHIC = /图形|九宫格|问号处|折叠|展开图|截面|拼图|数图形/
const blankOpts = (opts) => opts.length >= 3 && opts.every((o) => !(o.text || '').trim())

log('watcher 启动 v4 · pid ' + process.pid)
log('题库', bank ? bank.size + ' 题' : '未加载（放 bank.json 到目录里即可）')

// 桥接的 socket 名每次引擎启动都会变；连接断了要重读配置重连，否则会变成只刷 ERR 的僵尸进程。
const isConnError = (msg) => /closed|ECONNREFUSED|EPIPE|ECONNRESET|ENOENT/i.test(String(msg))

let p = null
let restarts = 0
let backoff = 1000

for (;;) {
  try {
    if (!p) {
      p = await connect()
      await p.init()
      log(restarts === 0 ? '已连接桥接' : `已重连桥接 #${restarts}`)
      backoff = 1000
    }
    await tick(p)
  } catch (e) {
    const msg = (e && e.message) || String(e)
    logErr(msg)
    if (!p || isConnError(msg)) {
      try { if (p && p.socket) p.socket.destroy() } catch {}
      p = null
      restarts += 1
      await new Promise((res) => setTimeout(res, backoff))
      backoff = Math.min(backoff * 2, 5000)
      continue
    }
  }
  // 在答题页上把轮询压到 350ms（切题能更快被发现）；其他时候保持 900ms 省电
  await new Promise((res) => setTimeout(res, state.examSeen ? 350 : 900))
}
