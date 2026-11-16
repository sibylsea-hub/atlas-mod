// atlas: the page in the browser window. It talks only to the helper that
// served it (bin/atlas_window.py): trades the ticket in its address for a
// token, long-polls GET /state for the pane's drawing (a tree of elements as
// JSON, made by hooks/window.ts), draws it as the desktop app does, near
// enough, and posts what the person does to POST /act. The DOM is patched in
// place by key, so typing, focus, selection and scroll survive a redraw.
// Every text goes in as text: nothing from a drawing is ever parsed as HTML.

;(() => {
  'use strict'

  // ---------- talking to the helper ----------

  const root = document.getElementById('root')
  const lostBox = document.getElementById('lost')
  const toastBox = document.getElementById('toasts')

  let token = ''
  let version = 0
  let treeVersion = -1
  let lastToast = 0
  let lastFocus = 0
  let failures = 0
  let sending = Promise.resolve()

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

  function lost(isLost) {
    if (lostBox.hidden !== !isLost) lostBox.hidden = !isLost
  }

  function failed() {
    failures++
    if (failures >= 2) lost(true)
  }

  function worked() {
    failures = 0
    lost(false)
  }

  /** What the person did, in the order they did it. */
  function send(doc) {
    sending = sending.then(async () => {
      try {
        const res = await fetch('/act', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Atlas-Token': token },
          body: JSON.stringify(doc),
          cache: 'no-store',
        })
        // refused for the token is the helper gone or replaced; too long is said, and is not a lost window
        if (res.status === 403) failed()
        else if (res.status === 413) toast('这段文字太长，没有送到 Atlas。')
      } catch {
        failed()
      }
    })
  }

  async function enter() {
    // the ticket leaves the address at once; a reload then lands on the bare page, which says how to come back
    const ticket = new URLSearchParams(location.search).get('t') || ''
    try {
      history.replaceState(null, '', '/window.html')
    } catch {
      // the address keeps a ticket that is spent in a moment
    }
    if (!ticket) return false
    try {
      const res = await fetch('/enter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket }),
        cache: 'no-store',
      })
      if (!res.ok) return false
      const doc = await res.json()
      token = typeof doc.token === 'string' ? doc.token : ''
      return token !== ''
    } catch {
      return false
    }
  }

  async function poll() {
    for (;;) {
      let res
      try {
        res = await fetch(`/state?v=${version}&tv=${treeVersion}`, { headers: { 'X-Atlas-Token': token }, cache: 'no-store' })
      } catch {
        failed()
        await wait(1500)
        continue
      }
      if (res.status === 204) {
        worked()
        continue
      }
      if (!res.ok) {
        failed()
        await wait(3000)
        continue
      }
      let state
      try {
        state = await res.json()
      } catch {
        failed()
        await wait(1500)
        continue
      }
      worked()
      try {
        take(state)
      } catch (err) {
        console.error('atlas window: could not draw', err)
      }
    }
  }

  function take(state) {
    if (typeof state.v === 'number') version = state.v
    if (typeof state.title === 'string' && state.title && document.title !== state.title) document.title = state.title
    if (state.tree && typeof state.tree === 'object') {
      treeVersion = typeof state.tv === 'number' ? state.tv : treeVersion
      draw(state.tree)
    }
    for (const t of Array.isArray(state.toasts) ? state.toasts : []) {
      if (typeof t.id !== 'number' || t.id <= lastToast) continue
      lastToast = t.id
      toast(String(t.text))
    }
    const focus = state.focus
    if (focus && typeof focus.n === 'number' && focus.n > lastFocus) {
      lastFocus = focus.n
      focusKey(String(focus.key))
    }
  }

  function toast(text) {
    const el = document.createElement('div')
    el.className = 'toast'
    el.textContent = text
    toastBox.append(el)
    while (toastBox.childElementCount > 4) toastBox.firstElementChild.remove()
    setTimeout(() => el.remove(), 4200)
  }

  function focusKey(key) {
    const el = root.querySelector(`[data-key="${CSS.escape(key)}"]`)
    if (!el) return
    el.focus()
    el.scrollIntoView({ block: 'nearest' })
  }

  // ---------- the size of the drawing ----------

  function pageSize() {
    const cs = getComputedStyle(root)
    const width = root.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    return { width: Math.max(1, Math.floor(width)), height: Math.max(1, window.innerHeight) }
  }

  let saidSize = { width: 0, height: 0 }
  let sizeTimer = 0

  function watchSize() {
    const check = () => {
      const now = pageSize()
      // a column of the drawing is about 9px: less than that changes nothing
      if (Math.abs(now.width - saidSize.width) < 9 && Math.abs(now.height - saidSize.height) < 40) return
      saidSize = now
      send({ kind: 'resize', width: now.width, height: now.height })
    }
    const later = () => {
      clearTimeout(sizeTimer)
      sizeTimer = setTimeout(check, 180)
    }
    if (typeof ResizeObserver === 'function') new ResizeObserver(later).observe(root)
    window.addEventListener('resize', later)
  }

  // ---------- styles ----------

  const STEP = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 }
  const CELL = 8
  const COLUMN = 9
  const SIZE = { caption: '11px', footnote: '12px', body: '14px', heading: '17px', title: '21px' }
  const WEIGHT = { regular: '400', medium: '500', semibold: '600', bold: '700' }
  const THEME = {
    text: 'var(--text)',
    inverseText: 'var(--bg)',
    inactive: 'var(--dim)',
    subtle: 'var(--subtle)',
    suggestion: 'var(--suggestion)',
    remember: 'var(--suggestion)',
    success: 'var(--success)',
    error: 'var(--error)',
    warning: 'var(--warning)',
    merged: 'var(--suggestion)',
    claude: 'var(--claude)',
    permission: 'var(--suggestion)',
    planMode: 'var(--success)',
    autoAccept: 'var(--suggestion)',
    promptBorder: 'var(--subtle)',
    bashBorder: 'var(--claude)',
    ide: 'var(--suggestion)',
    diffAdded: 'var(--added)',
    diffRemoved: 'var(--removed)',
    diffAddedDimmed: 'var(--added)',
    diffRemovedDimmed: 'var(--removed)',
    diffAddedWord: 'var(--success)',
    diffRemovedWord: 'var(--error)',
  }
  const BORDERS = { round: 'b-round', single: 'b-single', double: 'b-double', dashed: 'b-dashed', bold: 'b-bold' }

  /** A Space: a step name, or a number of cells. */
  function space(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return `${Math.max(0, v) * CELL}px`
    return Object.hasOwn(STEP, v) ? `${STEP[v]}px` : null
  }

  /** A colour a drawing names: a theme key as the page's own variable, else a colour the browser knows. */
  function colour(v) {
    if (typeof v !== 'string' || !v) return null
    if (Object.hasOwn(THEME, v)) return THEME[v]
    if (v === 'transparent') return v
    return CSS.supports('color', v) ? v : null
  }

  function length(v, unit) {
    if (typeof v === 'number' && Number.isFinite(v)) return `${Math.max(0, v) * unit}px`
    return typeof v === 'string' && /^\d+(\.\d+)?%$/.test(v) ? v : null
  }

  /** Sets exactly these properties on the element, through the CSSOM. */
  function style(el, next) {
    const prev = el.__style || {}
    for (const name in prev) if (!(name in next)) el.style.removeProperty(name)
    for (const name in next) if (prev[name] !== next[name]) el.style.setProperty(name, next[name])
    el.__style = next
  }

  function classes(el, name) {
    if (el.className !== name) el.className = name
  }

  function put(out, name, value) {
    if (value !== null && value !== undefined) out[name] = value
  }

  // ---------- drawing ----------

  /** Who a node is among its siblings: its kind and key, or its place among the keyless of its kind. */
  function idsOf(nodes) {
    const counts = new Map()
    const seen = new Map()
    return nodes.map(node => {
      const kind = typeof node === 'string' ? '#text' : String(node.type)
      let id
      if (typeof node !== 'string' && typeof node.key === 'string') id = `${kind}\u0000${node.key}`
      else {
        const n = (counts.get(kind) || 0) + 1
        counts.set(kind, n)
        id = `${kind}\u0001${n}`
      }
      const again = seen.get(id) || 0
      seen.set(id, again + 1)
      return again ? `${id}\u0002${again}` : id
    })
  }

  /** Makes `parent`'s children these nodes: the ones already there are updated in place and never rebuilt. */
  function reconcile(parent, nodes) {
    const old = new Map()
    for (const child of Array.from(parent.childNodes)) {
      if (child.__id === undefined) child.remove()
      else old.set(child.__id, child)
    }
    const ids = idsOf(nodes)
    const next = nodes.map((node, i) => {
      const id = ids[i]
      let el = old.get(id)
      if (el) old.delete(id)
      else {
        el = create(node)
        el.__id = id
      }
      update(el, node)
      return el
    })
    // what is taken away says nothing more: a field that loses the focus by leaving the page reports no typing
    leaving++
    for (const el of old.values()) el.remove()
    leaving--
    let cursor = parent.firstChild
    for (const el of next) {
      if (el === cursor) cursor = cursor.nextSibling
      else parent.insertBefore(el, cursor)
    }
  }

  const KINDS = {}
  let leaving = 0

  /** How an element of this name is drawn; one this page does not know is drawn as a Box around its children. */
  const kindOf = node => (Object.hasOwn(KINDS, node.type) ? KINDS[node.type] : KINDS.Box)

  function create(node) {
    return typeof node === 'string' ? document.createTextNode(node) : kindOf(node).create(node)
  }

  function update(el, node) {
    if (typeof node === 'string') {
      if (el.data !== node) el.data = node
      return
    }
    kindOf(node).update(el, node)
    el.__node = node
  }

  function draw(tree) {
    reconcile(root, [tree])
  }

  const says = (node, what) => Array.isArray(node.on) && node.on.includes(what)
  const kids = node => (Array.isArray(node.children) ? node.children : [])
  const propsOf = node => (node.props && typeof node.props === 'object' ? node.props : {})

  // ---- Box ----

  const SIDES = [
    ['margin', ['margin']],
    ['marginX', ['margin-left', 'margin-right']],
    ['marginY', ['margin-top', 'margin-bottom']],
    ['marginTop', ['margin-top']],
    ['marginBottom', ['margin-bottom']],
    ['marginLeft', ['margin-left']],
    ['marginRight', ['margin-right']],
    ['padding', ['padding']],
    ['paddingX', ['padding-left', 'padding-right']],
    ['paddingY', ['padding-top', 'padding-bottom']],
    ['paddingTop', ['padding-top']],
    ['paddingBottom', ['padding-bottom']],
    ['paddingLeft', ['padding-left']],
    ['paddingRight', ['padding-right']],
  ]
  const FLEX = {
    flexDirection: ['row', 'column', 'row-reverse', 'column-reverse'],
    flexWrap: ['nowrap', 'wrap', 'wrap-reverse'],
    alignItems: ['flex-start', 'center', 'flex-end', 'stretch'],
    alignSelf: ['flex-start', 'center', 'flex-end', 'auto'],
    justifyContent: ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'],
  }
  const CSS_NAME = { flexDirection: 'flex-direction', flexWrap: 'flex-wrap', alignItems: 'align-items', alignSelf: 'align-self', justifyContent: 'justify-content' }

  const isPlainButton = node => typeof node === 'object' && node !== null && node.type === 'Button' && propsOf(node).plain === true

  KINDS.Box = {
    create() {
      return document.createElement('div')
    },
    update(el, node) {
      const p = propsOf(node)
      const children = kids(node)
      const bordered = typeof p.borderStyle === 'string' && p.borderStyle !== ''
      // a small bordered box around one plain button is the skin's own make of button
      const pill = bordered && children.length === 1 && isPlainButton(children[0])
      const column = p.flexDirection === 'column' || p.flexDirection === 'column-reverse'
      const aligned = FLEX.alignItems.includes(p.alignItems)
      classes(el, `box${column ? ' column' : ''}${aligned ? ' aligned' : ''}${bordered ? ` bordered ${BORDERS[p.borderStyle] || 'b-single'}` : ''}${pill ? ' pill' : ''}`)
      const s = {}
      for (const name in FLEX) if (FLEX[name].includes(p[name])) s[CSS_NAME[name]] = p[name]
      if (typeof p.flexGrow === 'number') s['flex-grow'] = String(p.flexGrow)
      if (typeof p.flexShrink === 'number') s['flex-shrink'] = String(p.flexShrink)
      put(s, 'gap', space(p.gap))
      put(s, 'column-gap', space(p.columnGap))
      put(s, 'row-gap', space(p.rowGap))
      for (const [prop, names] of SIDES) {
        if (pill && prop.startsWith('padding')) continue
        const v = space(p[prop])
        if (v !== null) for (const name of names) s[name] = v
      }
      put(s, 'width', length(p.width, COLUMN))
      put(s, 'min-width', length(p.minWidth, COLUMN))
      put(s, 'height', length(p.height, 20))
      put(s, 'min-height', length(p.minHeight, 20))
      put(s, 'background-color', colour(p.backgroundColor))
      if (bordered) put(s, 'border-color', colour(p.borderColor))
      if (p.overflow === 'hidden') s.overflow = 'hidden'
      if (p.display === 'none') s.display = 'none'
      style(el, s)
      reconcile(el, children)
    },
  }

  // ---- Text ----

  function textStyle(p) {
    const s = {}
    put(s, 'font-size', SIZE[p.size])
    put(s, 'font-weight', WEIGHT[p.weight] || (p.bold === true ? '600' : null))
    if (p.inverse === true) {
      s.color = 'var(--bg)'
      s['background-color'] = 'var(--text)'
    } else {
      put(s, 'color', colour(p.color))
      put(s, 'background-color', colour(p.backgroundColor))
    }
    if (p.italic === true) s['font-style'] = 'italic'
    const lines = [p.underline === true ? 'underline' : '', p.strikethrough === true ? 'line-through' : ''].filter(Boolean).join(' ')
    if (lines) s['text-decoration'] = lines
    if (p.tabular === true) s['font-variant-numeric'] = 'tabular-nums'
    if (p.dir === 'rtl' || p.dir === 'ltr') s.direction = p.dir
    return s
  }

  KINDS.Text = {
    create() {
      return document.createElement('span')
    },
    update(el, node) {
      const p = propsOf(node)
      const cut = typeof p.wrap === 'string' && p.wrap !== 'wrap'
      const filled = p.inverse === true || colour(p.backgroundColor) !== null
      classes(el, `text${p.dimColor === true && !p.color ? ' dim' : ''}${cut ? ' cut' : ''}${filled ? ' filled' : ''}${p.mono === true ? ' mono' : ''}`)
      style(el, textStyle(p))
      reconcile(el, kids(node))
    },
  }

  // ---- Button ----

  KINDS.Button = {
    create() {
      const el = document.createElement('button')
      el.type = 'button'
      el.addEventListener('click', () => {
        const node = el.__node
        if (node && says(node, 'press') && typeof node.key === 'string') send({ kind: 'press', key: node.key })
      })
      return el
    },
    update(el, node) {
      const p = propsOf(node)
      const first = el.__node === undefined
      const look = p.plain === true ? 'plain' : p.variant === 'primary' ? 'primary' : 'secondary'
      const children = kids(node)
      classes(el, `btn ${look}${look === 'plain' && children.length === 0 ? ' words' : ''}${p.dimColor === true ? ' dim' : ''}${says(node, 'press') ? '' : ' inert'}`)
      if (typeof node.key === 'string') el.dataset.key = node.key
      reconcile(el, children.length > 0 ? children : [typeof p.label === 'string' ? p.label : ''])
      if (children.length > 0 && typeof p.label === 'string') el.setAttribute('aria-label', p.label)
      else el.removeAttribute('aria-label')
      if (first && p.autoFocus === true && !typing()) el.focus()
    },
  }

  /** The person is in a field: nothing takes the focus from under them by itself. */
  function typing() {
    const at = document.activeElement
    return at instanceof HTMLInputElement || at instanceof HTMLTextAreaElement
  }

  // ---- Input ----

  function label(el, text) {
    let lbl = el.querySelector(':scope > .lbl')
    if (typeof text !== 'string' || text === '') {
      if (lbl) lbl.remove()
      return
    }
    if (!lbl) {
      lbl = document.createElement('span')
      lbl.className = 'lbl'
      el.prepend(lbl)
    }
    if (lbl.textContent !== text) lbl.textContent = text
  }

  function fieldOf(wrap, isArea) {
    const el = document.createElement(isArea ? 'textarea' : 'input')
    if (!isArea) el.type = 'text'
    el.spellcheck = false
    el.autocomplete = 'off'
    let timer = 0
    let composing = false
    const node = () => wrap.__node
    const report = () => {
      clearTimeout(timer)
      timer = 0
      const n = node()
      if (leaving > 0 || !el.isConnected) return
      if (!n || !says(n, 'input') || typeof n.key !== 'string' || el.__said === el.value) return
      el.__said = el.value
      send({ kind: 'input', key: n.key, value: el.value })
    }
    wrap.__submit = () => {
      const n = node()
      if (!n || typeof n.key !== 'string') return
      report()
      if (says(n, 'submit')) send({ kind: 'submit', key: n.key, value: el.value })
    }
    el.addEventListener('compositionstart', () => {
      composing = true
    })
    el.addEventListener('compositionend', () => {
      composing = false
      clearTimeout(timer)
      timer = setTimeout(report, 150)
    })
    el.addEventListener('input', () => {
      // a word still being composed (an input method's candidates) is not text yet
      if (composing) return
      clearTimeout(timer)
      timer = setTimeout(report, 150)
    })
    el.addEventListener('blur', report)
    el.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.isComposing || composing || e.keyCode === 229) return
      // in a text area Enter saves, as the page says; shift+Enter is a new line
      if (isArea && (e.shiftKey || e.altKey)) return
      e.preventDefault()
      wrap.__submit()
    })
    return el
  }

  KINDS.Input = {
    create() {
      const wrap = document.createElement('label')
      return wrap
    },
    update(wrap, node) {
      const p = propsOf(node)
      const isArea = typeof p.rows === 'number' && p.rows > 1
      let field = wrap.__field
      const first = field === undefined
      if (first || wrap.__isArea !== isArea) {
        const made = fieldOf(wrap, isArea)
        if (field) {
          made.value = field.value
          field.replaceWith(made)
        } else wrap.append(made)
        field = made
        wrap.__field = made
        wrap.__isArea = isArea
        field.__tree = undefined
      }
      classes(wrap, `field input${isArea ? ' area' : ''}`)
      label(wrap, p.label)
      if (typeof node.key === 'string') field.dataset.key = node.key
      if (isArea && field.rows !== p.rows) field.rows = Math.max(2, Math.min(40, p.rows))
      const hint = typeof p.placeholder === 'string' ? p.placeholder : ''
      if (field.placeholder !== hint) field.placeholder = hint
      if (typeof p.label === 'string' && p.label.trim()) field.removeAttribute('aria-label')
      else field.setAttribute('aria-label', hint || String(node.key || ''))
      // The field is the person's while they are in it: what the drawing says is written into it only
      // when the drawing's own value changes, and never over the one they are typing in. An echo of
      // what they typed a moment ago would otherwise undo what they have typed since.
      const value = typeof p.value === 'string' ? p.value : ''
      if (field.__tree !== value) {
        field.__tree = value
        if (document.activeElement !== field && field.value !== value) field.value = value
        field.__said = value
      }
      // the button that does what Enter does, where the drawing names one
      let go = wrap.__go
      if (typeof p.submitLabel === 'string' && p.submitLabel !== '' && says(node, 'submit')) {
        if (!go) {
          go = document.createElement('button')
          go.type = 'button'
          go.className = 'btn secondary submit'
          go.addEventListener('click', () => wrap.__submit())
          wrap.append(go)
          wrap.__go = go
        }
        if (go.textContent !== p.submitLabel) go.textContent = p.submitLabel
      } else if (go) {
        go.remove()
        wrap.__go = undefined
      }
      if (first && p.autoFocus === true && !typing()) field.focus()
    },
  }

  // ---- Select ----

  /** The value of the line a menu shows while nothing is chosen: no option of a drawing has it. */
  const NONE = '\u0001none'

  KINDS.Select = {
    create() {
      const wrap = document.createElement('label')
      const sel = document.createElement('select')
      wrap.append(sel)
      wrap.__field = sel
      sel.addEventListener('change', () => {
        const node = wrap.__node
        if (!node || typeof node.key !== 'string' || sel.value === NONE) return
        if (says(node, 'select')) send({ kind: 'select', key: node.key, value: sel.value })
        // the drawing decides what is chosen: until the next one says, the pick shows; a menu with no
        // value of its own (one that only does something) goes back to its name
        if (typeof propsOf(node).value !== 'string') sel.value = NONE
        else wrap.__picked = true
      })
      return wrap
    },
    update(wrap, node) {
      const p = propsOf(node)
      const sel = wrap.__field
      classes(wrap, 'field select')
      label(wrap, p.label)
      if (typeof node.key === 'string') sel.dataset.key = node.key
      const options = Array.isArray(p.options) ? p.options.filter(o => o && typeof o.value === 'string') : []
      const hasValue = typeof p.value === 'string'
      const sig = JSON.stringify([options, hasValue, p.label])
      if (sel.__options !== sig) {
        sel.__options = sig
        sel.replaceChildren()
        if (!hasValue) {
          // nothing is chosen: the menu shows what it is for
          const none = document.createElement('option')
          none.value = NONE
          none.textContent = typeof p.label === 'string' && p.label.trim() ? `${p.label.trim()}…` : '选择…'
          none.disabled = true
          sel.append(none)
        }
        for (const o of options) {
          const opt = document.createElement('option')
          opt.value = o.value
          opt.textContent = typeof o.label === 'string' ? o.label : o.value
          sel.append(opt)
        }
        wrap.__tree = undefined
      }
      const value = hasValue ? p.value : NONE
      if (wrap.__tree !== value || wrap.__picked) {
        wrap.__tree = value
        wrap.__picked = false
        if (sel.value !== value) sel.value = value
      }
      if (typeof p.label === 'string' && p.label.trim()) sel.removeAttribute('aria-label')
      else sel.setAttribute('aria-label', String(node.key || ''))
    },
  }

  // ---- Svg: always a picture, never markup of this page ----

  KINDS.Svg = {
    create() {
      const el = document.createElement('img')
      el.className = 'svg'
      el.decoding = 'async'
      el.draggable = false
      return el
    },
    update(el, node) {
      const p = propsOf(node)
      const source = typeof p.source === 'string' ? p.source : ''
      if (el.__source !== source) {
        el.__source = source
        el.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`
      }
      const alt = typeof p.alt === 'string' ? p.alt : ''
      if (el.alt !== alt) el.alt = alt
      const s = {}
      if (typeof p.width === 'number' && p.width > 0) s.width = `${p.width}px`
      if (typeof p.height === 'number' && p.height > 0) s.height = `${p.height}px`
      style(el, s)
    },
  }

  // ---- Code ----

  KINDS.Code = {
    create() {
      const el = document.createElement('pre')
      el.className = 'code'
      return el
    },
    update(el, node) {
      const p = propsOf(node)
      const source = typeof p.source === 'string' ? p.source : ''
      const sig = `${p.format === 'diff' ? 'diff' : 'source'}\u0000${source}`
      if (el.__sig === sig) return
      el.__sig = sig
      if (p.format !== 'diff') {
        el.textContent = source
        return
      }
      el.replaceChildren(
        ...source.split('\n').map(line => {
          const span = document.createElement('span')
          const mark = line.startsWith('@@') ? 'hunk' : line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : ''
          if (mark) span.className = mark
          span.textContent = mark ? line : `${line}\n`
          return span
        }),
      )
    },
  }

  // ---- Markdown: read as blocks of plain text (headings, lists, code, quotes), each put in as text ----

  function inline(parent, text) {
    const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|\[([^\]\n]+)\]\(([^)\s]+)\)/g
    let at = 0
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m.index > at) parent.append(text.slice(at, m.index))
      if (m[1]) {
        const code = document.createElement('code')
        code.textContent = m[1].slice(1, -1)
        parent.append(code)
      } else if (m[2]) {
        const strong = document.createElement('strong')
        strong.textContent = m[2].slice(2, -2)
        parent.append(strong)
      } else if (/^https?:\/\//i.test(m[4])) {
        parent.append(linkTo(m[4], m[3]))
      } else {
        parent.append(m[3])
      }
      at = m.index + m[0].length
    }
    if (at < text.length) parent.append(text.slice(at))
  }

  function linkTo(href, text) {
    const a = document.createElement('a')
    a.className = 'link'
    a.href = href
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    a.textContent = text
    return a
  }

  function markdown(text) {
    const out = []
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    let para = []
    let list = null
    const endPara = () => {
      if (para.length === 0) return
      const p = document.createElement('p')
      inline(p, para.join('\n'))
      out.push(p)
      para = []
    }
    const endList = () => {
      list = null
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const fence = /^\s*(```|~~~)/.exec(line)
      if (fence) {
        endPara()
        endList()
        const body = []
        for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) body.push(lines[i])
        const pre = document.createElement('pre')
        pre.textContent = body.join('\n')
        out.push(pre)
        continue
      }
      if (line.trim() === '') {
        endPara()
        endList()
        continue
      }
      const head = /^(#{1,6})\s+(.*)$/.exec(line)
      if (head) {
        endPara()
        endList()
        const h = document.createElement(`h${Math.min(4, head[1].length)}`)
        inline(h, head[2].replace(/\s+#+\s*$/, ''))
        out.push(h)
        continue
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        endPara()
        endList()
        out.push(document.createElement('hr'))
        continue
      }
      const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
      if (item) {
        endPara()
        const tag = /\d/.test(item[2]) ? 'ol' : 'ul'
        if (!list || list.tagName.toLowerCase() !== tag) {
          list = document.createElement(tag)
          out.push(list)
        }
        const li = document.createElement('li')
        const depth = Math.min(4, Math.floor(item[1].replace(/\t/g, '  ').length / 2))
        if (depth > 0) li.className = `in${depth}`
        inline(li, item[3])
        list.append(li)
        continue
      }
      const quote = /^\s*>\s?(.*)$/.exec(line)
      if (quote) {
        endPara()
        endList()
        const last = out[out.length - 1]
        const q = last && last.tagName === 'BLOCKQUOTE' && lines[i - 1] && /^\s*>/.test(lines[i - 1]) ? last : document.createElement('blockquote')
        if (q !== last) out.push(q)
        else q.append('\n')
        inline(q, quote[1])
        continue
      }
      if (list && /^\s+\S/.test(line)) {
        // a line that goes on under a list item belongs to it
        const li = list.lastElementChild
        if (li) {
          li.append(' ')
          inline(li, line.trim())
          continue
        }
      }
      endList()
      para.push(line)
    }
    endPara()
    return out
  }

  KINDS.Markdown = {
    create() {
      return document.createElement('div')
    },
    update(el, node) {
      const p = propsOf(node)
      classes(el, `md${p.dimColor === true ? ' dim' : ''}`)
      const text = typeof p.text === 'string' ? p.text : ''
      if (el.__text === text) return
      el.__text = text
      el.replaceChildren(...markdown(text))
    },
  }

  // ---- Link ----

  KINDS.Link = {
    create() {
      return document.createElement('span')
    },
    update(el, node) {
      const p = propsOf(node)
      const href = typeof p.href === 'string' ? p.href : ''
      const text = typeof p.label === 'string' && p.label ? p.label : href
      const sig = `${href}\u0000${text}`
      if (el.__sig === sig) return
      el.__sig = sig
      // only an address of the web is a link: anything else is its text
      el.replaceChildren(/^https?:\/\//i.test(href) ? linkTo(href, text) : text)
    },
  }

  // ---------- the board (a Client whose module is board.tsx), drawn from its props ----------

  /** What is not in the props: the card picked with the keyboard, the drag in hand, a drawing that came mid-drag. */
  const boards = new Map()

  function boardState(id) {
    let st = boards.get(id)
    if (!st) {
      st = { sel: null, drag: null, pending: null }
      boards.set(id, st)
    }
    return st
  }

  function boardProps(node) {
    const p = propsOf(node).props
    const columns = p && Array.isArray(p.columns) ? p.columns.filter(c => c && typeof c.id === 'string' && Array.isArray(c.cards)) : []
    const pageSize = p && typeof p.pageSize === 'number' && p.pageSize > 0 ? Math.floor(p.pageSize) : 20
    const page = p && typeof p.page === 'number' && p.page > 0 ? Math.floor(p.page) : 0
    const paper = p && p.paper && Array.isArray(p.paper.sheets) && p.paper.sheets.length > 0 ? p.paper : null
    return { boardId: p && typeof p.boardId === 'string' ? p.boardId : '', columns, allowMerge: !!(p && p.allowMerge), allowReorder: !!(p && p.allowReorder), page, pageSize, paper }
  }

  const shown = (p, col) => col.cards.slice(p.page * p.pageSize, p.page * p.pageSize + p.pageSize)

  function findCard(p, id) {
    for (const col of p.columns) {
      const card = col.cards.find(c => c.id === id)
      if (card) return { col, card }
    }
    return null
  }

  /**
   * What letting go of `cardId` over column `colId` would do, as board.tsx decides it: `slot` is the place
   * among the cards shown (null over the heading or below the last card). Null cancels.
   */
  function outcome(p, cardId, colId, slot) {
    const src = findCard(p, cardId)
    const col = p.columns.find(c => c.id === colId)
    if (!src || !col) return null
    const over = slot === null ? undefined : shown(p, col)[slot]
    if (col.id === src.col.id) {
      if (!p.allowReorder || slot === null) return null
      const order = col.cards.map(c => c.id).filter(id => id !== cardId)
      const index = Math.min(p.page * p.pageSize + slot, order.length)
      order.splice(index, 0, cardId)
      if (order.join('\n') === col.cards.map(c => c.id).join('\n')) return null
      return { post: { type: 'reorder', column: col.id, order }, text: `排到第 ${index + 1} 位`, col: col.id }
    }
    if (Array.isArray(col.accepts) && !col.accepts.includes(src.card.kind)) return null
    if (p.allowMerge && over && over.kind === src.card.kind) {
      return { post: { type: 'merge', card: cardId, onto: over.id }, text: `合并到 ${over.label}`, onto: over.id }
    }
    const index = slot === null ? col.cards.length : Math.min(p.page * p.pageSize + slot, col.cards.length)
    return { post: { type: 'drop', card: cardId, from: src.col.id, to: col.id, index }, text: `移到 ${col.title}`, col: col.id }
  }

  function post(p, data) {
    send({ kind: 'board', data: { ...data, board: p.boardId } })
  }

  function paintBoard(el, node) {
    const p = boardProps(node)
    const st = boardState(p.boardId)
    if (st.sel && !findCard(p, st.sel)) st.sel = null
    // the same board again is left as it stands
    const sig = JSON.stringify([propsOf(node).props, st.sel])
    if (el.__sig === sig) return
    el.__sig = sig
    el.__props = p
    classes(el, `board${st.sel ? ' armed' : ''}`)
    const s = {}
    if (p.paper) {
      put(s, '--ink', colour(p.paper.ink))
      put(s, '--ink-soft', colour(p.paper.inkSoft))
    }
    style(el, s)
    const held = document.activeElement && el.contains(document.activeElement) ? document.activeElement.dataset : null
    const keep = held ? { card: held.card, col: held.col } : null
    el.replaceChildren(
      ...p.columns.map((col, i) => {
        const box = document.createElement('div')
        const sheet = p.paper ? p.paper.sheets[i % p.paper.sheets.length] : null
        box.className = `col${sheet ? ' paper' : ''}`
        box.dataset.colId = col.id
        if (sheet) {
          const head = colour(sheet.head)
          const body = colour(sheet.body)
          if (head) box.style.setProperty('--sheet-head', head)
          if (body) box.style.setProperty('--sheet-body', body)
        }
        const head = document.createElement('button')
        head.type = 'button'
        head.className = 'col-head'
        head.dataset.col = col.id
        const name = document.createElement('span')
        name.textContent = String(col.title ?? col.id)
        const count = document.createElement('span')
        count.className = 'count'
        count.textContent = String(col.cards.length)
        head.append(name, count)
        const body = document.createElement('div')
        body.className = 'col-body'
        const cards = shown(p, col)
        cards.forEach((card, k) => {
          const b = document.createElement('button')
          b.type = 'button'
          b.className = `card${st.sel === card.id ? ' selected' : ''}`
          b.dataset.card = card.id
          b.dataset.slot = String(k)
          const title = document.createElement('span')
          title.className = 'name'
          title.textContent = String(card.label ?? card.id)
          b.append(title)
          const meta = st.sel === card.id ? '已选中：再按一次打开，或按一列的标题放进去' : [card.badge, card.hint].filter(x => typeof x === 'string' && x).join(' · ')
          if (meta) {
            const m = document.createElement('span')
            m.className = 'meta'
            m.textContent = meta
            b.append(m)
          }
          body.append(b)
        })
        if (cards.length < p.pageSize) {
          const slot = document.createElement('div')
          slot.className = 'slot'
          slot.textContent = '空位：把卡片拖到这里'
          body.append(slot)
        }
        box.append(head, body)
        return box
      }),
    )
    if (keep) {
      const again = keep.card !== undefined ? el.querySelector(`[data-card="${CSS.escape(keep.card)}"]`) : keep.col !== undefined ? el.querySelector(`[data-col="${CSS.escape(keep.col)}"]`) : null
      if (again) again.focus({ preventScroll: true })
    }
  }

  /** The column and the place among its cards under a point of the screen. */
  function under(el, x, y) {
    const hit = document.elementFromPoint(x, y)
    const colEl = hit && el.contains(hit) ? hit.closest('.col') : null
    if (!colEl) return null
    const cardEl = hit.closest('.card')
    return { col: colEl.dataset.colId, slot: cardEl ? Number(cardEl.dataset.slot) : null, colEl, cardEl }
  }

  function boardEvents(el) {
    let ghost = null
    const clear = () => {
      for (const marked of el.querySelectorAll('.target, .onto, .dragging')) marked.classList.remove('target', 'onto', 'dragging')
    }
    const end = () => {
      const p = el.__props
      const st = p ? boardState(p.boardId) : null
      if (ghost) ghost.remove()
      ghost = null
      document.body.classList.remove('dragging')
      clear()
      if (!st) return
      st.drag = null
      // a drawing that came while the card was in hand is drawn now
      if (st.pending) {
        const node = st.pending
        st.pending = null
        paintBoard(el, node)
      }
    }
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0) return
      const cardEl = e.target instanceof Element ? e.target.closest('.card') : null
      const p = el.__props
      if (!cardEl || !p) return
      const st = boardState(p.boardId)
      st.drag = { card: cardEl.dataset.card, x: e.clientX, y: e.clientY, moved: false, pointer: e.pointerId, result: null }
      el.setPointerCapture(e.pointerId)
    })
    el.addEventListener('pointermove', e => {
      const p = el.__props
      const st = p ? boardState(p.boardId) : null
      const drag = st ? st.drag : null
      if (!drag || drag.pointer !== e.pointerId) return
      if (!drag.moved && Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < 5) return
      const src = findCard(p, drag.card)
      if (!src) return end()
      if (!drag.moved) {
        drag.moved = true
        document.body.classList.add('dragging')
        ghost = document.createElement('div')
        ghost.className = 'ghost'
        document.body.append(ghost)
      }
      clear()
      const from = el.querySelector(`[data-card="${CSS.escape(drag.card)}"]`)
      if (from) from.classList.add('dragging')
      const at = under(el, e.clientX, e.clientY)
      drag.result = at ? outcome(p, drag.card, at.col, at.slot) : null
      if (drag.result && at) {
        if (drag.result.onto !== undefined && at.cardEl) at.cardEl.classList.add('onto')
        else at.colEl.classList.add('target')
      }
      ghost.textContent = `${src.card.label}${drag.result ? ` → ${drag.result.text}` : ' （放开取消）'}`
      ghost.style.setProperty('left', `${Math.min(e.clientX + 12, window.innerWidth - 40)}px`)
      ghost.style.setProperty('top', `${e.clientY + 14}px`)
    })
    el.addEventListener('pointerup', e => {
      const p = el.__props
      const st = p ? boardState(p.boardId) : null
      const drag = st ? st.drag : null
      if (!drag || drag.pointer !== e.pointerId) return
      const result = drag.result
      const moved = drag.moved
      const card = drag.card
      // the click that follows a press without a move is this press: it opens the card, as in the pane
      if (!moved) st.clicked = { card, at: Date.now() }
      end()
      if (!moved) {
        st.sel = null
        post(p, { type: 'open', card })
      } else if (result) {
        st.sel = null
        post(p, result.post)
      }
    })
    el.addEventListener('pointercancel', end)
    // The keyboard's way, as board.tsx has it: Enter on a card picks it, Enter on it again opens it, and
    // Enter on a column's heading puts the picked card there.
    el.addEventListener('click', e => {
      const p = el.__props
      if (!p || !(e.target instanceof Element)) return
      const st = boardState(p.boardId)
      const cardEl = e.target.closest('.card')
      if (cardEl) {
        const card = cardEl.dataset.card
        if (st.clicked && st.clicked.card === card && Date.now() - st.clicked.at < 600) return
        if (st.sel === card) {
          st.sel = null
          post(p, { type: 'open', card })
        } else st.sel = card
        if (el.__node) paintBoard(el, el.__node)
        return
      }
      const headEl = e.target.closest('.col-head')
      if (!headEl || !st.sel) return
      const picked = st.sel
      st.sel = null
      const src = findCard(p, picked)
      const col = p.columns.find(c => c.id === headEl.dataset.col)
      if (src && col && src.col.id !== col.id && !(Array.isArray(col.accepts) && !col.accepts.includes(src.card.kind))) {
        post(p, { type: 'drop', card: picked, from: src.col.id, to: col.id, index: col.cards.length })
      }
      if (el.__node) paintBoard(el, el.__node)
    })
  }

  KINDS.Client = {
    create(node) {
      const el = document.createElement('div')
      // only the board is known here; any other module is a region this page has nothing to draw in
      if (/(^|\/)board\.tsx$/.test(String(propsOf(node).module || ''))) {
        el.__board = true
        boardEvents(el)
      }
      return el
    },
    update(el, node) {
      if (!el.__board) return
      const st = boardState(boardProps(node).boardId)
      if (st.drag && st.drag.moved) st.pending = node
      else paintBoard(el, node)
    },
  }

  // ---------- start ----------

  document.getElementById('lost-close').addEventListener('click', () => window.close())

  async function start() {
    if (!(await enter())) {
      const waiting = document.getElementById('wait')
      if (waiting) waiting.remove()
      lost(true)
      return
    }
    saidSize = pageSize()
    send({ kind: 'hello', width: saidSize.width, height: saidSize.height })
    watchSize()
    poll()
  }

  start()
})()
