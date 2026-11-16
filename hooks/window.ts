// atlas: the browser window's pure half. The pane is drawn for the window with
// an element table of its own, whose constructors build plain nodes; a drawn
// tree is turned into JSON for the page (web/window.js) with its handlers set
// aside by key; the helper's (bin/atlas_window.py) output is cut into lines
// and read; what a page did is checked before anything runs. No `$` here:
// register.tsx starts the helper and talks to it.

import type { Elements, RenderElement, RenderSurface } from 'claude-code'

// ---------- the element table ----------

/** What a constructor of the table makes: the element's name and the props it was given, children among them. */
type Made = { type: string; props: Record<string, unknown> }

function maker<P>(type: string): (props: P) => RenderElement {
  return props => ({ type, props: (props ?? {}) as Record<string, unknown> }) as unknown as RenderElement
}

/**
 * The desktop's elements as plain data. The JSX factory calls a constructor
 * with its props (`key` and `children` among them) and returns what it
 * returns, so the pane's views draw into this table exactly as into the
 * desktop's own.
 */
export const windowTable: Elements['desktop'] = {
  Box: maker('Box'),
  Text: maker('Text'),
  Button: maker('Button'),
  Input: maker('Input'),
  Select: maker('Select'),
  Svg: maker('Svg'),
  Link: maker('Link'),
  Code: maker('Code'),
  Markdown: maker('Markdown'),
  Client: maker('Client'),
}

// ---------- a drawn tree as JSON ----------

/** One element as the page gets it. `on` names the things it reports: press, select, input, submit. */
export type WindowNode = {
  type: string
  key?: string
  props: Record<string, unknown>
  children: (WindowNode | string)[]
  on?: string[]
}

/** What an element's handlers take beside the value: the engine's own argument, near enough. */
export type WindowEvent = { plugin: string; element: string; component: 'Pane'; requestId: string; surface: RenderSurface }

export type WindowHandlers = {
  type: string
  onPress?: (e: WindowEvent) => void
  onSelect?: (value: string, e: WindowEvent) => void
  onInput?: (value: string, e: WindowEvent) => void
  onSubmit?: (value: string, e: WindowEvent) => void
}

export type WindowDrawing = {
  tree: WindowNode
  /** The handlers of the tree's buttons, fields and menus, by key. */
  handlers: Map<string, WindowHandlers>
  /** What is wrong with the tree, each said once: two interactive elements under one key, one with no key. */
  problems: string[]
}

const HANDLERS: Record<string, readonly (readonly [prop: 'onPress' | 'onSelect' | 'onInput' | 'onSubmit', says: string])[]> = {
  Button: [['onPress', 'press']],
  Select: [['onSelect', 'select']],
  Input: [
    ['onInput', 'input'],
    ['onSubmit', 'submit'],
  ],
}

function isMade(v: unknown): v is Made {
  return typeof v === 'object' && v !== null && typeof (v as Made).type === 'string' && typeof (v as Made).props === 'object' && (v as Made).props !== null
}

/** A prop's value as JSON holds it: functions and undefined left out, nothing deeper than a prop ever goes. */
function plain(v: unknown, depth: number): unknown {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v !== 'object' || depth > 12) return undefined
  if (Array.isArray(v)) return v.map(x => plain(x, depth + 1) ?? null)
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) {
    const p = plain(x, depth + 1)
    if (p !== undefined) out[k] = p
  }
  return out
}

function flat(children: unknown, out: unknown[]): unknown[] {
  if (Array.isArray(children)) for (const c of children) flat(c, out)
  else if (children !== null && children !== undefined && typeof children !== 'boolean') out.push(children)
  return out
}

/** The text a Button's children come to, for one drawn without a label. */
function textOf(children: readonly (WindowNode | string)[]): string {
  return children.map(c => (typeof c === 'string' ? c : textOf(c.children))).join('')
}

/**
 * A tree drawn with `windowTable` as the page gets it, and the handlers it
 * held. A key two interactive elements share is in `problems` and in neither's
 * name afterwards: a press on it would have to guess which one was meant.
 */
export function serializeTree(root: unknown): WindowDrawing {
  const handlers = new Map<string, WindowHandlers>()
  const clashes = new Set<string>()
  const problems: string[] = []
  const walk = (made: Made): WindowNode => {
    const props: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(made.props)) {
      if (name === 'key' || name === 'children') continue
      const p = plain(value, 0)
      if (p !== undefined) props[name] = p
    }
    const children: (WindowNode | string)[] = []
    for (const c of flat(made.props.children, [])) {
      if (isMade(c)) children.push(walk(c))
      else if (typeof c === 'string') children.push(c)
      else if (typeof c === 'number') children.push(String(c))
    }
    const node: WindowNode = { type: made.type, props, children }
    const wired = HANDLERS[made.type]
    // a Button's address defaults to its label, as on every surface
    const given = made.props.key
    const key = typeof given === 'string' && given ? given : made.type === 'Button' ? String(made.props.label ?? '') || textOf(children) : ''
    if (key) node.key = key
    if (!wired) return node
    const mine: WindowHandlers = { type: made.type }
    const on: string[] = []
    for (const [prop, says] of wired) {
      const fn = made.props[prop]
      if (typeof fn !== 'function') continue
      mine[prop] = fn as never
      on.push(says)
    }
    if (on.length === 0) return node
    if (!key) {
      problems.push(`a ${made.type} has no key: it is drawn, and does nothing`)
      return node
    }
    const other = handlers.get(key)
    if (other || clashes.has(key)) {
      if (!clashes.has(key)) problems.push(`two interactive elements share the key "${key}" (${other?.type ?? '?'}, ${made.type}): neither is run`)
      clashes.add(key)
      handlers.delete(key)
      return node
    }
    handlers.set(key, mine)
    node.on = on
    return node
  }
  const tree = isMade(root) ? walk(root) : noteTree('Atlas 没有画出东西。')
  if (clashes.size > 0) strip(tree, clashes)
  return { tree, handlers, problems }
}

/** Takes `on` off every element whose key clashed, the first one drawn too. */
function strip(node: WindowNode, clashes: ReadonlySet<string>): void {
  if (node.on && node.key !== undefined && clashes.has(node.key)) delete node.on
  for (const c of node.children) if (typeof c !== 'string') strip(c, clashes)
}

/** A tree of one line, for when the pane itself could not be drawn. */
export function noteTree(text: string): WindowNode {
  return { type: 'Box', props: { flexDirection: 'column' }, children: [{ type: 'Text', key: 'window-note', props: { color: 'error', wrap: 'wrap' }, children: [text] }] }
}

// ---------- the size of the drawing ----------

export const WINDOW_WIDTH = 528
export const WINDOW_HEIGHT = 860

/**
 * The columns and rows the pane is drawn at for a page this many CSS pixels
 * wide and tall: views.tsx takes a column for about 9px (`panePx`) and one
 * less than it is given, and a row is a line of text.
 */
export function windowSize(widthPx: number, heightPx: number): { bodyColumns: number; bodyRows: number } {
  const w = Number.isFinite(widthPx) ? widthPx : WINDOW_WIDTH
  const h = Number.isFinite(heightPx) ? heightPx : WINDOW_HEIGHT
  return {
    bodyColumns: Math.max(36, Math.min(240, Math.floor(w / 9))) + 1,
    bodyRows: Math.max(24, Math.min(60, Math.round(h / 20))),
  }
}

// ---------- what the helper says ----------

/** The whole lines in `rest + piece`, and what is left after the last newline. A child's output comes in pieces that end anywhere. */
export function takeLines(rest: string, piece: string): { lines: string[]; rest: string } {
  const parts = (rest + piece).split('\n')
  const tail = parts.pop() ?? ''
  const lines = parts.map(l => (l.endsWith('\r') ? l.slice(0, -1) : l)).filter(l => l.length > 0)
  // a line longer than anything the helper writes is not one of its lines: dropped, not kept growing
  return { lines, rest: tail.length > 64_000_000 ? '' : tail }
}

export type WindowAct =
  | { kind: 'press'; key: string }
  | { kind: 'select'; key: string; value: string }
  | { kind: 'input'; key: string; value: string }
  | { kind: 'submit'; key: string; value: string }
  | { kind: 'board'; data: unknown }
  | { kind: 'hello'; width: number; height: number }
  | { kind: 'resize'; width: number; height: number }

/** What a page did, when it is one of the things a page does and whole; null otherwise. */
export function asAct(doc: unknown): WindowAct | null {
  if (typeof doc !== 'object' || doc === null) return null
  const d = doc as Record<string, unknown>
  switch (d.kind) {
    case 'press':
      return typeof d.key === 'string' ? { kind: 'press', key: d.key } : null
    case 'select':
    case 'input':
    case 'submit':
      return typeof d.key === 'string' && typeof d.value === 'string' ? { kind: d.kind, key: d.key, value: d.value } : null
    case 'board':
      return typeof d.data === 'object' && d.data !== null ? { kind: 'board', data: d.data } : null
    case 'hello':
    case 'resize': {
      const width = Number(d.width)
      const height = Number(d.height)
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
      return { kind: d.kind, width: Math.min(8000, width), height: Math.min(8000, height) }
    }
    default:
      return null
  }
}

export type HelperLine =
  | { kind: 'ready'; port: number }
  | { kind: 'failed'; error: string }
  | { kind: 'page'; open: boolean }
  | { kind: 'act'; act: WindowAct }
  /** A tick, what an open came to, an act that is none, or a line that is not the helper's. */
  | { kind: 'other' }

export function readHelperLine(line: string): HelperLine {
  let doc: unknown
  try {
    doc = JSON.parse(line)
  } catch {
    return { kind: 'other' }
  }
  if (typeof doc !== 'object' || doc === null) return { kind: 'other' }
  const d = doc as Record<string, unknown>
  if (d.ready === true && typeof d.port === 'number' && Number.isInteger(d.port) && d.port > 0 && d.port < 65536) return { kind: 'ready', port: d.port }
  if (d.ready === false) return { kind: 'failed', error: typeof d.error === 'string' ? d.error : '' }
  if (d.page === 'open' || d.page === 'gone') return { kind: 'page', open: d.page === 'open' }
  if ('act' in d) {
    const act = asAct(d.act)
    return act ? { kind: 'act', act } : { kind: 'other' }
  }
  return { kind: 'other' }
}

/** Random bytes as the token the helper takes: letters and digits only. */
export function tokenOf(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

// ---------- the command ----------

export type WindowWish = 'window' | 'pane' | 'auto'

/** What `/atlas …` asks for: the window, the embedded pane, or whichever suits the surface. */
export function windowWish(args: string): WindowWish {
  const word = args.trim().toLowerCase()
  if (word === 'window' || word === '窗口') return 'window'
  if (word === 'pane' || word === '面板') return 'pane'
  return 'auto'
}

/**
 * Whether a bare `/atlas` opens the window: only where a terminal is all that
 * draws the session. With a graphical surface attached the pane is drawn there
 * as before; with none (a `-p` run), or where the surfaces cannot be read,
 * nothing new happens.
 */
export function windowSuits(surfaces: readonly string[] | undefined): boolean {
  return surfaces !== undefined && surfaces.length > 0 && surfaces.every(s => s === 'terminal')
}

export const WINDOW_OPENED = '已在浏览器窗口里打开 Atlas。要用嵌在终端里的面板，发 /atlas pane。'
export const WINDOW_ALREADY = 'Atlas 的窗口已经开着。要再开一个，发 /atlas window；要用嵌在终端里的面板，发 /atlas pane。'
export const WINDOW_NO_SURFACE = '这个会话没有接着任何界面，所以没有打开窗口。'

/** Why the helper did not start, as a sentence for the person. */
export function startFailure(python: string, why: string, errors: string): string {
  const last = errors.trim().split('\n').pop()?.trim() ?? ''
  const said = (why || last).replace(/[。.\s]+$/, '')
  if (/ENOENT|not found|no such file|cannot find/i.test(said)) return `没能运行 Python（${python}）：${said}。窗口需要 Python 3.9 或更新的版本。`
  return `窗口的服务没能启动：${said || '它没有说原因就退出了'}。`
}

// ---------- held in the module (lost on reload; the window then has to be opened again) ----------

export const heldW = {
  status: 'off' as 'off' | 'starting' | 'ready',
  /** Counts the helpers started: a loop of an earlier one sees it has been replaced. */
  gen: 0,
  port: 0,
  token: '',
  starting: null as Promise<string | null> | null,
  /** Ends the helper by leaving its stream. */
  stop: null as (() => void) | null,
  /** A page is polling: the pane is drawn for the window only while one is. */
  listening: false,
  /** When the last window was asked for: a second bare /atlas right after it opens no second one. */
  openedAtMs: 0,
  width: WINDOW_WIDTH,
  height: WINDOW_HEIGHT,
  /** Something the drawing reads has changed since the last push. */
  stale: false,
  toasts: [] as string[],
  focus: null as string | null,
  /** Wakes the loop that draws and pushes. */
  wake: null as (() => void) | null,
  /** The handlers of the tree last pushed. */
  handlers: new Map<string, WindowHandlers>(),
  /** The tree last pushed, as text: one that draws the same again is not sent. */
  lastTree: '',
  /** The surface a press in the window names (where a copy goes): the session's first. */
  surface: 'terminal' as RenderSurface,
  /** The problems already said in the debug log. */
  said: new Set<string>(),
}

function nudge(): void {
  const wake = heldW.wake
  heldW.wake = null
  if (wake) wake()
}

/** Something the pane draws from has changed. Costs nothing while no window is open. */
export function windowStale(): void {
  if (heldW.status !== 'ready') return
  heldW.stale = true
  if (heldW.listening) nudge()
}

export function windowToast(text: string): void {
  if (heldW.status !== 'ready' || !heldW.listening) return
  heldW.toasts.push(text)
  if (heldW.toasts.length > 20) heldW.toasts.splice(0, heldW.toasts.length - 20)
  nudge()
}

export function windowFocus(key: string): void {
  if (heldW.status !== 'ready' || !heldW.listening) return
  heldW.focus = key
  nudge()
}

/** A page started or stopped polling. One that starts is drawn for at once; what was only for the one that left is dropped. */
export function windowPage(open: boolean): void {
  heldW.listening = open
  if (open) {
    heldW.stale = true
    nudge()
  } else {
    heldW.toasts = []
    heldW.focus = null
  }
}

/** Whether the drawing loop has something to send to someone. */
export function windowWants(): boolean {
  return heldW.status === 'ready' && heldW.listening && (heldW.stale || heldW.toasts.length > 0 || heldW.focus !== null)
}

/** The helper is gone (or is being replaced): everything about it is forgotten. */
export function windowOff(): void {
  heldW.status = 'off'
  heldW.port = 0
  heldW.token = ''
  heldW.stop = null
  heldW.listening = false
  heldW.stale = false
  heldW.toasts = []
  heldW.focus = null
  heldW.handlers = new Map()
  heldW.lastTree = ''
  heldW.openedAtMs = 0
  nudge()
}
