// 网页界面里的答题助手：常驻只有一个小胶囊（● 答题），点开才展开导入 / 开始 / 停止。
// 数据来自 /plugin-exam/ctl；只依赖 react，样式全内联，不引任何 Host 组件（官方规范要求）。
window.__ModuleLoader__.load({
  id: 'dsh-go-exam-helper',
  factory (require) {
    const React = require('react')
    const h = React.createElement
    const API = '/plugin-exam/ctl'
    const API_IMPORT = '/plugin-exam/import'
    const zh = String((typeof navigator !== 'undefined' && navigator.language) || '').toLowerCase().startsWith('zh')
    const t = (a, b) => (zh ? a : b)

    const pill = {
      border: '1px solid rgba(127,127,127,.35)',
      background: 'transparent',
      color: 'inherit',
      borderRadius: '999px',
      padding: '2px 10px',
      fontSize: '12px',
      lineHeight: '18px',
      cursor: 'pointer',
    }

    function useExam () {
      const [state, setState] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          const r = await fetch(API + '?action=status', { cache: 'no-store' })
          if (r.ok) setState(await r.json())
        } catch {}
      }, [])

      React.useEffect(() => {
        let alive = true
        const tick = async () => { if (alive) await load() }
        tick()
        const timer = setInterval(tick, 3000)
        return () => { alive = false; clearInterval(timer) }
      }, [load])

      const upload = React.useCallback(async (file) => {
        if (!file) return
        setBusy(true)
        try {
          const r = await fetch(API_IMPORT + '?name=' + encodeURIComponent(file.name), {
            method: 'POST', body: file, cache: 'no-store',
            headers: { 'content-type': 'application/octet-stream' },
          })
          const j = await r.json().catch(() => null)
          if (j) setNotice(j.ok ? t(`已导入 ${j.imported} 题`, `Imported ${j.imported}`) : t(`导入失败：${j.message || ''}`, `Import failed: ${j.message || ''}`))
        } catch (e) {
          setNotice(t('上传失败：' + (e && e.message), 'Upload failed'))
        }
        setBusy(false)
        await load()
      }, [load])

      const run = React.useCallback(async (action) => {
        setBusy(true)
        try {
          const r = await fetch(API + '?action=' + action, { cache: 'no-store' })
          if (r.ok) setState(await r.json())
        } catch {}
        setBusy(false)
      }, [])

      return { state, busy, notice, setNotice, run, upload }
    }

    function Dock () {
      const { state, busy, notice, setNotice, run, upload } = useExam()
      const fileRef = React.useRef(null)
      const [open, setOpen] = React.useState(false)
      const running = !!(state && state.running)
      const bank = state && state.bank ? t(`题库 ${state.bank} 题`, `${state.bank} questions`) : ''

      // 展开后 12 秒没动作就收回去，免得一直占着地方。
      React.useEffect(() => {
        if (!open) return undefined
        const timer = setTimeout(() => setOpen(false), 12000)
        return () => clearTimeout(timer)
      }, [open, busy, notice])

      const chip = {
        display: 'inline-flex', alignItems: 'center', gap: '5px',
        border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit',
        borderRadius: '999px', padding: '0 9px', height: '18px', boxSizing: 'border-box',
        fontSize: '11px', lineHeight: '16px', cursor: 'pointer', whiteSpace: 'nowrap',
      }
      const dot = h('span', {
        style: {
          width: '6px', height: '6px', borderRadius: '50%', flex: 'none',
          background: running ? '#1a9c58' : 'rgba(127,127,127,.6)',
        },
      })
      const tip = running
        ? t('答题助手监考中，点开操作', 'Exam helper is watching - tap for controls')
        : t('答题助手没在跑，点开操作', 'Exam helper is idle - tap for controls')

      return h('div', {
        style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'nowrap', minHeight: '18px', padding: '0 2px', fontSize: '11px', lineHeight: '18px' },
      },
      h('button', {
        type: 'button', style: chip, title: tip, onClick: () => setOpen(!open),
        'aria-expanded': open ? 'true' : 'false',
      },
      dot,
      running ? t('答题 · 监考中', 'Exam · watching') : t('答题', 'Exam'),
      h('span', { style: { opacity: .45, fontSize: '9px' } }, open ? '▲' : '▼')),
      open ? h('input', {
        ref: fileRef, type: 'file', accept: '.csv,.tsv,.txt,.json,.xlsx,.xlsm',
        style: { display: 'none' },
        onChange: (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) upload(f) },
      }) : null,
      open && bank ? h('span', { style: { opacity: .55, whiteSpace: 'nowrap' } }, bank) : null,
      open ? h('button', {
        type: 'button', style: { ...chip, opacity: busy ? .45 : 1 }, disabled: busy,
        onClick: () => { setNotice(''); if (fileRef.current) fileRef.current.click() },
      }, t('导入', 'Import')) : null,
      open && !running ? h('button', {
        type: 'button', style: { ...chip, opacity: busy ? .45 : 1 }, disabled: busy,
        onClick: () => run('start'),
      }, t('开始', 'Start')) : null,
      open && running ? h('button', {
        type: 'button', style: { ...chip, opacity: busy ? .45 : 1 }, disabled: busy,
        onClick: () => run('stop'),
      }, t('停止', 'Stop')) : null,
      open && notice ? h('span', { style: { opacity: .6, maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, notice) : null)
    }

    return {
      inject: ['slots'],
      apply (ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'exam-helper-dock', order: 4,
        }, Dock))
      },
    }
  },
})
