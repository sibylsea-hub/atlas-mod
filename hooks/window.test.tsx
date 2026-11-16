// Tests for the browser window: the pure half (window.ts) by itself, then the
// bridge in register.tsx over a mocked world. No process is started and
// nothing is fetched: `$.process.spawn` and `$.http.fetch` end in this file,
// which plays the helper (bin/atlas_window.py has tests of its own).

import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

import type { AtlasSwitches, AtlasView } from '../types'
import type { AtlasIndex, MemoryFile } from './data'
import {
  WINDOW_ALREADY,
  WINDOW_NO_SURFACE,
  WINDOW_OPENED,
  asAct,
  readHelperLine,
  serializeTree,
  startFailure,
  takeLines,
  tokenOf,
  windowSize,
  windowSuits,
  windowTable,
  windowWish,
} from './window'
import type { WindowNode } from './window'

// ---------- a world beneath the plugin, the helper among it ----------

const HOME = '/home/t'
const CD = `${HOME}/.claude`
const CWD = '/work/proj'
const SLUG = '-work-proj'
const MEM = `${CD}/projects/${SLUG}/memory`
const PORT = 49152
const ROOT_RE = /\/bin\/atlas_window\.py$/

function memFile(name: string, title: string, linked: boolean): MemoryFile {
  return { name, path: `${MEM}/${name}`, size: 40, mtimeMs: 1_760_000_000_000, hasFrontmatter: true, title, description: `about ${title}`, type: 'user', linked }
}

function index(): AtlasIndex {
  return {
    version: 2,
    generatedAtMs: 1_760_000_000_000,
    elapsedMs: 1200,
    claudeDir: CD,
    home: HOME,
    warnings: [],
    globalClaudeMd: { path: `${CD}/CLAUDE.md`, exists: true, lines: 12, bytes: 300 },
    projects: [
      {
        slug: SLUG,
        cwd: CWD,
        label: 'proj',
        kind: 'project',
        isCurrent: true,
        sessionCount: 2,
        lastActiveMs: 1_760_000_000_000,
        memoryDir: MEM,
        memoryFiles: [memFile('style.md', '写作风格', true), memFile('robin.md', 'Robin 的偏好', true), memFile('loose.md', '还没索引的一条', false)],
        index: { exists: true, path: `${MEM}/MEMORY.md`, lines: 3, bytes: 120, overLineLimit: false, overByteLimit: false, links: ['style.md', 'robin.md'], deadLinks: [], orphans: ['loose.md'] },
        loads: [],
      },
      {
        slug: '-work-other',
        cwd: '/work/other',
        label: 'other',
        kind: 'project',
        isCurrent: false,
        sessionCount: 1,
        lastActiveMs: 1_759_000_000_000,
        memoryDir: `${CD}/projects/-work-other/memory`,
        memoryFiles: [{ ...memFile('c.md', 'C', false), path: `${CD}/projects/-work-other/memory/c.md` }],
        index: null,
        loads: [],
      },
    ],
    customMemory: [],
    sessions: [],
    skills: [
      { name: 'autodoc', source: 'user', path: `${CD}/skills/autodoc/SKILL.md`, description: 'writes the docs', plugin: null, projectCwd: null, useCount: 4, sessionsUsing: 2, lastUsedMs: 1_760_000_000_000, listedIn: 2 },
      { name: 'tidy', source: 'user', path: `${CD}/skills/tidy/SKILL.md`, description: 'tidies notes', plugin: null, projectCwd: null, useCount: 0, sessionsUsing: 0, lastUsedMs: null, listedIn: 2 },
      { name: 'lint', source: 'project', path: `${CWD}/.claude/skills/lint/SKILL.md`, description: 'lints', plugin: null, projectCwd: CWD, useCount: 1, sessionsUsing: 1, lastUsedMs: 1_759_000_000_000, listedIn: 1 },
    ],
    health: [{ severity: 'warn', kind: 'orphan', projectSlug: SLUG, path: `${MEM}/loose.md`, message: 'loose.md 没有被 MEMORY.md 索引' }],
  }
}

const SECTIONS = [
  { id: 'intro', text: 'You are an agent.', scope: 'shared' as const },
  { id: 'tone', text: 'Be brief and kind.', scope: 'shared' as const },
  { id: 'env_info_simple', text: 'cwd: /work/proj', scope: 'session' as const },
]

type WorldOptions = {
  /** What `$.session.surfaces()` answers; left out, nothing answers it (as in every other test file). */
  surfaces?: readonly RenderSurface[]
  /** The engine's answer to `$.ui.open`; placed when not given. */
  open?: { isPlaced: false; reason: string }
  /** The helper cannot be run at all: what the spawn's first pull is refused with. */
  spawnFails?: string
  /** What the helper says first; the ready line when not given, nothing at all for null. */
  first?: string | null
  /** What `POST /open` answers. */
  opened?: Record<string, unknown>
  store?: Record<string, unknown>
}

type Spawned = { argv: string[]; input: string | undefined; say: (line: unknown) => void; piece: (text: string) => void; exit: () => void }
type Fetched = { method: string; path: string; headers: Record<string, string>; body: unknown }

type World = {
  state: Record<string, unknown>
  view: () => AtlasView
  switches: () => AtlasSwitches | undefined
  store: Map<string, unknown>
  toasts: string[]
  logs: string[]
  clock: MockClock
  /** Every `$.ui.open` of the embedded pane. */
  panes: number
  /** Every helper the plugin started, in order. */
  spawned: Spawned[]
  /** Every request the plugin sent the helper. */
  fetched: Fetched[]
  /** The bodies of `POST /push`, in order. */
  pushes: () => { tree?: WindowNode; toasts?: string[]; focus?: string; title?: string }[]
  /** The drawings pushed, in order. */
  trees: () => WindowNode[]
  /** How often a window was asked for. */
  opens: () => number
  /** How many pages `GET /status` says are looking. */
  pages: { n: number }
  /** Set to refuse every `$.store.set` from then on. */
  flags: { storeFails: boolean }
  /** The helper running now. */
  helper: () => Spawned
  /** Lets what was said and done land, a drawing's short wait included. */
  flush: () => Promise<void>
}

const ok = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

function world(on: On, opts: WorldOptions = {}): World {
  const state: Record<string, unknown> = {}
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  const toasts: string[] = []
  const logs: string[] = []
  const spawned: Spawned[] = []
  const fetched: Fetched[] = []
  const pages = { n: 0 }
  const counts = { panes: 0 }
  const flags = { storeFails: false }
  on('state.set', ($, e, next) => {
    if (e.plugin === 'atlas') state[e.key] = e.value
    return next(e)
  })
  const clock = mock.clock(on, { now: 1_760_000_200_000 })
  mock.env(on, { HOME })
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    if (flags.storeFails) return { deny: 'the store is full' }
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.root', () => ({ value: CWD }))
  on('session.id', () => ({ value: 'current-session' }))
  on('session.cwd', () => ({ value: CWD }))
  const surfaces = opts.surfaces
  if (surfaces) on('session.surfaces', () => ({ value: surfaces }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => {
    counts.panes++
    return { value: opts.open ?? { isPlaced: true as const } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', () => ({ value: { isCopied: true as const } }))
  on('ui.focus', () => ({}))
  on('ui.message', () => ({}))
  on('ui.invalidate', ($, e, next) => (e.event === 'ui.render' ? next(e) : { value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    if (argv[0] === '/bin/date') return { value: ok('+0800\n') }
    if (argv[0] === '/usr/bin/python3' && argv[3] === 'index') return { value: ok(JSON.stringify(index())) }
    if (argv[0] === '/usr/bin/python3' && argv[3] === 'search') {
      return { value: ok(JSON.stringify({ query: argv[4], results: [{ path: `${MEM}/style.md`, projectSlug: SLUG, scope: 'project', line: 3, text: 'short sentences' }] })) }
    }
    if (argv[0] === '/usr/bin/python3' && argv[3] === 'purge') return { value: ok(JSON.stringify({ purged: [], keptCount: 0, freedBytes: 0, dryRun: false, refused: [] })) }
    return { value: ok('') }
  })
  const files = new Map([[`${CD}/CLAUDE.md`, '# 全局说明\n\n- 说话简短\n']])
  on('fs.read', ($, e) => (files.has(e.path) ? { value: files.get(e.path) ?? '' } : { deny: `ENOENT ${e.path}` }))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.stat', ($, e) => (files.has(e.path) ? { value: { kind: 'file' as const, size: 20, mtimeMs: 1_760_000_000_000, isLink: false, realPath: e.path } } : { deny: `ENOENT ${e.path}` }))
  on('fs.list', () => ({ value: [] }))
  on('prompt.section', ($, e) => ({ text: e.text }))
  on('prompt.compose', () => ({ sections: SECTIONS }))
  // the helper: a child whose output is whatever the test says next
  on('process.spawn', async function* ($, e) {
    const queue: (string | null)[] = []
    let wake: (() => void) | null = null
    const piece = (text: string | null) => {
      queue.push(text)
      const w = wake
      wake = null
      if (w) w()
    }
    spawned.push({ argv: [...e.argv], input: e.input, say: line => piece(JSON.stringify(line) + '\n'), piece, exit: () => piece(null) })
    if (opts.spawnFails) return { deny: opts.spawnFails }
    const first = opts.first === undefined ? `{"ready":true,"port":${PORT}}\n` : opts.first
    if (first !== null) yield { stream: 'stdout' as const, text: first }
    for (;;) {
      while (queue.length === 0) {
        await new Promise<void>(resolve => {
          wake = resolve
        })
      }
      const text = queue.shift()
      if (text === null || text === undefined) break
      yield { stream: 'stdout' as const, text }
    }
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', ($, e) => {
    const url = new URL(e.url)
    const init = e.init ?? {}
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
    fetched.push({ method: init.method ?? 'GET', path: url.pathname, headers: init.headers ?? {}, body })
    const answer = (doc: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(doc) } })
    if (url.host !== `127.0.0.1:${PORT}`) return { value: { status: 502, ok: false, headers: {}, text: '' } }
    if (url.pathname === '/push') return answer({ v: fetched.length, pages: pages.n })
    if (url.pathname === '/open') return answer(opts.opened ?? { opened: true, how: 'chrome-app' })
    if (url.pathname === '/status') return answer({ pages: pages.n, v: 0 })
    return { value: { status: 404, ok: false, headers: {}, text: '' } }
  })
  const flush = async () => {
    await clock.settle()
    await clock.advance(60)
    await clock.settle()
  }
  return {
    state,
    view: () => state.view as AtlasView,
    switches: () => state.switches as AtlasSwitches | undefined,
    store,
    toasts,
    logs,
    clock,
    get panes() {
      return counts.panes
    },
    spawned,
    fetched,
    pushes: () => fetched.filter(f => f.path === '/push').map(f => f.body as { tree?: WindowNode; toasts?: string[]; focus?: string; title?: string }),
    trees: () => fetched.flatMap(f => (f.path === '/push' && (f.body as { tree?: WindowNode }).tree ? [(f.body as { tree: WindowNode }).tree] : [])),
    opens: () => fetched.filter(f => f.path === '/open').length,
    pages,
    flags,
    helper: () => {
      const last = spawned[spawned.length - 1]
      if (!last) throw new Error('no helper was started')
      return last
    },
    flush,
  }
}

function command($: Engine, args = '') {
  return $.command.run({ command: 'atlas', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
}

/** `/atlas …`, and what it left running (a scan) let finish: a test ends with nothing in flight. */
async function atlas($: Engine, w: World, args = '') {
  const r = await command($, args)
  await w.flush()
  return r
}

/** A terminal session with the window open and a page looking at it. */
async function opened($: Engine, on: On, opts: WorldOptions = {}): Promise<World> {
  const w = world(on, { surfaces: ['terminal'], ...opts })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  const r = await atlas($, w)
  expect(r.text).toBe(WINDOW_OPENED)
  await w.flush()
  w.pages.n = 1
  w.helper().say({ page: 'open' })
  w.helper().say({ act: { kind: 'hello', width: 528, height: 860 } })
  await w.flush()
  return w
}

/** The embedded pane, drawn in the terminal beside the window. */
function mountPane($: Engine) {
  return $.ui.mount({
    plugin: 'atlas',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'atlas',
    props: { title: 'Atlas', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    viewport: { columns: 102, rows: 40, isFullscreen: true },
  })
}

/** What the page did, as the helper passes it on. */
async function act(w: World, doc: Record<string, unknown>): Promise<void> {
  w.helper().say({ act: doc })
  await w.flush()
}

function nodes(tree: WindowNode | undefined, out: WindowNode[] = []): WindowNode[] {
  if (!tree) return out
  out.push(tree)
  for (const c of tree.children) if (typeof c !== 'string') nodes(c, out)
  return out
}

function byKey(tree: WindowNode | undefined, key: string): WindowNode | undefined {
  return nodes(tree).find(n => n.key === key)
}

function lastTree(w: World): WindowNode | undefined {
  const trees = w.trees()
  return trees[trees.length - 1]
}

// ---------- window.ts ----------

describe('window.ts > the table and a drawn tree', () => {
  const { Box, Text, Button, Input, Select, Svg, Client } = windowTable

  test('a constructor makes a plain node, and JSX draws into the table as into a surface', () => {
    const noop = () => undefined
    const tree = serializeTree(
      <Box key="root" flexDirection="column" gap="sm">
        <Text key="t" size="footnote" dimColor>
          hello
        </Text>
        <Button key="go" label="Go" variant="primary" onPress={noop} />
        <Svg key="pic" source="<svg/>" alt="a picture" />
        <Client key="board:skills" module="./board.tsx" props={{ boardId: 'skills', columns: [] }} width={50} height={8} />
      </Box>,
    ).tree
    expect(tree).toEqual({
      type: 'Box',
      key: 'root',
      props: { flexDirection: 'column', gap: 'sm' },
      children: [
        { type: 'Text', key: 't', props: { size: 'footnote', dimColor: true }, children: ['hello'] },
        { type: 'Button', key: 'go', props: { label: 'Go', variant: 'primary' }, children: [], on: ['press'] },
        { type: 'Svg', key: 'pic', props: { source: '<svg/>', alt: 'a picture' }, children: [] },
        // the engine reads a Client's module off the source and writes the plugin's own path for it
        { type: 'Client', key: 'board:skills', props: { module: expect.stringMatching(/board\.tsx$/), props: { boardId: 'skills', columns: [] }, width: 50, height: 8 }, children: [] },
      ],
    })
  })

  test('a function component is resolved: what it returns is what is drawn', () => {
    // as views.tsx's paperButton does: a component that wraps the table's own Button in a Box
    const Pill = (props: { key?: string; label: string; onPress: () => void }) => (
      <Box key={`pill:${props.key}`} borderStyle="round" paddingX="xs" paddingY={0}>
        <Button key={props.key} plain onPress={props.onPress}>
          <Text weight="medium">{props.label}</Text>
        </Button>
      </Box>
    )
    let pressed = 0
    const drawn = serializeTree(
      <Box flexDirection="row">
        <Pill key="save" label="保存" onPress={() => pressed++} />
      </Box>,
    )
    expect(drawn.tree.children).toEqual([
      {
        type: 'Box',
        key: 'pill:save',
        props: { borderStyle: 'round', paddingX: 'xs', paddingY: 0 },
        children: [{ type: 'Button', key: 'save', props: { plain: true }, children: [{ type: 'Text', props: { weight: 'medium' }, children: ['保存'] }], on: ['press'] }],
      },
    ])
    drawn.handlers.get('save')?.onPress?.({ plugin: 'atlas', element: 'save', component: 'Pane', requestId: 'atlas', surface: 'terminal' })
    expect(pressed).toBe(1)
  })

  test('handlers stay out of the JSON and are kept by key', () => {
    const calls: string[] = []
    const drawn = serializeTree(
      <Box>
        <Button key="b" label="B" onPress={() => calls.push('press')} />
        <Select key="s" label="S" value="a" options={[{ value: 'a', label: 'A' }]} onSelect={v => calls.push(`select:${v}`)} />
        <Input key="i" label="I" value="x" onInput={v => calls.push(`input:${v}`)} onSubmit={v => calls.push(`submit:${v}`)} />
        <Input key="only-submit" value="" onSubmit={v => calls.push(`submit2:${v}`)} />
      </Box>,
    )
    const text = JSON.stringify(drawn.tree)
    expect(text).not.toContain('onPress')
    expect(text).not.toContain('onSelect')
    expect(text).not.toContain('onInput')
    expect(text).not.toContain('onSubmit')
    expect(JSON.parse(text)).toEqual(drawn.tree)
    expect(drawn.tree.children.map(c => (typeof c === 'string' ? c : c.on))).toEqual([['press'], ['select'], ['input', 'submit'], ['submit']])
    expect([...drawn.handlers.keys()]).toEqual(['b', 's', 'i', 'only-submit'])
    const e = { plugin: 'atlas', element: 'x', component: 'Pane' as const, requestId: 'atlas', surface: 'terminal' as const }
    drawn.handlers.get('b')?.onPress?.(e)
    drawn.handlers.get('s')?.onSelect?.('a', e)
    drawn.handlers.get('i')?.onInput?.('typed', e)
    drawn.handlers.get('i')?.onSubmit?.('done', e)
    drawn.handlers.get('only-submit')?.onSubmit?.('z', e)
    expect(drawn.handlers.get('only-submit')?.onInput).toBeUndefined()
    expect(calls).toEqual(['press', 'select:a', 'input:typed', 'submit:done', 'submit2:z'])
    expect(drawn.problems).toEqual([])
  })

  test('children are flattened; what is not drawn is left out; a number is its text', () => {
    const rows = [<Text key="a">a</Text>, null, false, [<Text key="b">b</Text>, undefined]]
    const tree = serializeTree(
      <Box>
        {'one'}
        {rows}
        {3}
        {true}
      </Box>,
    ).tree
    expect(tree.children).toEqual(['one', { type: 'Text', key: 'a', props: {}, children: ['a'] }, { type: 'Text', key: 'b', props: {}, children: ['b'] }, '3'])
  })

  test('undefined and function props are left out, at any depth; the rest is kept as it is', () => {
    const tree = serializeTree(
      <Box key="k" borderColor={undefined} hover={{ display: 'flex' }}>
        <Client key="c" module="./board.tsx" props={{ a: 1, f: () => 1, u: undefined, list: [1, undefined, 'x'], deep: { n: null, f: () => 2 } }} />
      </Box>,
    ).tree
    expect(tree.props).toEqual({ hover: { display: 'flex' } })
    expect(tree.children).toEqual([{ type: 'Client', key: 'c', props: { module: expect.stringMatching(/board\.tsx$/), props: { a: 1, list: [1, null, 'x'], deep: { n: null } } }, children: [] }])
  })

  test("a Button's key defaults to its label, then to its text", () => {
    const noop = () => undefined
    const drawn = serializeTree(
      <Box>
        <Button label="刷新" onPress={noop} />
        <Button plain onPress={noop}>
          <Text>打开</Text> 它
        </Button>
      </Box>,
    )
    expect([...drawn.handlers.keys()]).toEqual(['刷新', '打开 它'])
    expect(drawn.problems).toEqual([])
  })

  test('two interactive elements under one key are reported, and neither is run', () => {
    const calls: string[] = []
    const drawn = serializeTree(
      <Box>
        <Button key="same" label="A" onPress={() => calls.push('a')} />
        <Box key="same">
          <Text key="same">a Box and a Text may share it: nothing is pressed on them</Text>
        </Box>
        <Input key="same" value="" onSubmit={() => calls.push('b')} />
        <Button key="same" label="C" onPress={() => calls.push('c')} />
        <Button key="other" label="D" onPress={() => calls.push('d')} />
      </Box>,
    )
    expect(drawn.problems).toEqual(['two interactive elements share the key "same" (Button, Input): neither is run'])
    expect([...drawn.handlers.keys()]).toEqual(['other'])
    // the page is told which elements report: none of the three does
    expect(nodes(drawn.tree).filter(n => n.key === 'same').map(n => n.on)).toEqual([undefined, undefined, undefined, undefined, undefined])
    expect(byKey(drawn.tree, 'other')?.on).toEqual(['press'])
  })

  test('an interactive element with no key at all is reported and inert', () => {
    const drawn = serializeTree(
      <Box>
        <Button plain onPress={() => undefined} />
      </Box>,
    )
    expect(drawn.problems).toEqual(['a Button has no key: it is drawn, and does nothing'])
    expect(drawn.handlers.size).toBe(0)
  })

  test('what is no tree at all draws a line saying so', () => {
    for (const junk of [null, undefined, 'text', 3, {}, { type: 'Box' }]) {
      const drawn = serializeTree(junk)
      expect(drawn.tree.type).toBe('Box')
      expect(JSON.stringify(drawn.tree)).toContain('Atlas 没有画出东西')
    }
  })
})

describe('window.ts > what the helper says', () => {
  test('takeLines: lines come whole however the pieces fall', () => {
    const text = '{"ready":true,"port":5}\n{"page":"open"}\n{"act":{"kind":"press","key":"tab:prompt"}}\n'
    // cut at every position, and into every pair of positions
    for (let i = 0; i <= text.length; i++) {
      for (let j = i; j <= text.length; j += 7) {
        const pieces = [text.slice(0, i), text.slice(i, j), text.slice(j)]
        let rest = ''
        const lines: string[] = []
        for (const p of pieces) {
          const cut = takeLines(rest, p)
          rest = cut.rest
          lines.push(...cut.lines)
        }
        expect(lines).toEqual(['{"ready":true,"port":5}', '{"page":"open"}', '{"act":{"kind":"press","key":"tab:prompt"}}'])
        expect(rest).toBe('')
      }
    }
  })

  test('takeLines: several lines in a piece, an unfinished one kept, empty ones dropped, CRLF', () => {
    expect(takeLines('', 'a\nb\nc')).toEqual({ lines: ['a', 'b'], rest: 'c' })
    expect(takeLines('c', '')).toEqual({ lines: [], rest: 'c' })
    expect(takeLines('c', 'd\n')).toEqual({ lines: ['cd'], rest: '' })
    expect(takeLines('', '\n\nx\n\n')).toEqual({ lines: ['x'], rest: '' })
    expect(takeLines('', 'a\r\nb\r\n')).toEqual({ lines: ['a', 'b'], rest: '' })
    // a \r that is the end of one piece and whose \n opens the next
    const first = takeLines('', 'a\r')
    expect(first).toEqual({ lines: [], rest: 'a\r' })
    expect(takeLines(first.rest, '\nb')).toEqual({ lines: ['a'], rest: 'b' })
  })

  test('readHelperLine: the lines the helper writes', () => {
    expect(readHelperLine('{"ready":true,"port":49152}')).toEqual({ kind: 'ready', port: 49152 })
    expect(readHelperLine('{"ready":false,"error":"could not listen on 127.0.0.1"}')).toEqual({ kind: 'failed', error: 'could not listen on 127.0.0.1' })
    expect(readHelperLine('{"page":"open"}')).toEqual({ kind: 'page', open: true })
    expect(readHelperLine('{"page":"gone"}')).toEqual({ kind: 'page', open: false })
    expect(readHelperLine('{"act":{"kind":"press","key":"k"}}')).toEqual({ kind: 'act', act: { kind: 'press', key: 'k' } })
    for (const other of ['{"tick":3}', '{"window":"opened","how":"chrome-app"}', '{"ready":true}', '{"ready":true,"port":0}', '{"ready":true,"port":"5"}', '{"page":"maybe"}', '{"act":{"kind":"eval"}}', 'not json', '', '[]', 'null', '3']) {
      expect(readHelperLine(other)).toEqual({ kind: 'other' })
    }
  })

  test('asAct: only what a page does, and only whole', () => {
    expect(asAct({ kind: 'press', key: 'k', extra: 1 })).toEqual({ kind: 'press', key: 'k' })
    expect(asAct({ kind: 'select', key: 'k', value: 'v' })).toEqual({ kind: 'select', key: 'k', value: 'v' })
    expect(asAct({ kind: 'input', key: 'k', value: '' })).toEqual({ kind: 'input', key: 'k', value: '' })
    expect(asAct({ kind: 'submit', key: 'k', value: '多行\n文字' })).toEqual({ kind: 'submit', key: 'k', value: '多行\n文字' })
    expect(asAct({ kind: 'board', data: { board: 'skills', type: 'open', card: 's:a' } })).toEqual({ kind: 'board', data: { board: 'skills', type: 'open', card: 's:a' } })
    expect(asAct({ kind: 'hello', width: 528.5, height: 860 })).toEqual({ kind: 'hello', width: 528.5, height: 860 })
    expect(asAct({ kind: 'resize', width: 1e9, height: 700 })).toEqual({ kind: 'resize', width: 8000, height: 700 })
    for (const bad of [
      null,
      'press',
      {},
      { kind: 'press' },
      { kind: 'press', key: 3 },
      { kind: 'select', key: 'k' },
      { kind: 'input', key: 'k', value: 3 },
      { kind: 'board' },
      { kind: 'board', data: 'x' },
      { kind: 'resize', width: 0, height: 10 },
      { kind: 'resize', width: 'wide', height: 10 },
      { kind: 'hello', width: 10 },
      { kind: 'eval', code: '1' },
    ]) {
      expect(asAct(bad)).toBeNull()
    }
  })

  test('the command, the surfaces, the size, the token and why a start failed', () => {
    expect(['', '  ', 'window', ' Window ', '窗口', 'pane', '面板', 'something else'].map(windowWish)).toEqual(['auto', 'auto', 'window', 'window', 'window', 'pane', 'pane', 'auto'])
    expect(windowSuits(['terminal'])).toBe(true)
    expect(windowSuits(['terminal', 'desktop'])).toBe(false)
    expect(windowSuits(['desktop'])).toBe(false)
    expect(windowSuits(['mobile'])).toBe(false)
    expect(windowSuits([])).toBe(false)
    expect(windowSuits(undefined)).toBe(false)
    // views.tsx draws at one column less than it is given, a column 9px wide: the drawing is never wider than the page
    for (const px of [330, 528, 529, 700, 1200]) {
      const { bodyColumns } = windowSize(px, 860)
      expect((bodyColumns - 1) * 9).toBeLessThanOrEqual(Math.max(px, 36 * 9))
      expect((bodyColumns - 1) * 9).toBeGreaterThan(px - 9 - 1)
    }
    expect(windowSize(100, 100)).toEqual({ bodyColumns: 37, bodyRows: 24 })
    expect(windowSize(1e6, 1e6)).toEqual({ bodyColumns: 241, bodyRows: 60 })
    expect(windowSize(Number.NaN, Number.NaN)).toEqual(windowSize(528, 860))
    expect(tokenOf(new Uint8Array([0, 1, 15, 16, 255]))).toBe('00010f10ff')
    expect(startFailure('/usr/bin/python3', "ENOENT: no such file or directory, posix_spawn '/usr/bin/python3'", '')).toContain('没能运行 Python（/usr/bin/python3）')
    expect(startFailure('python', 'could not listen on 127.0.0.1: [Errno 48] Address already in use', '')).toBe('窗口的服务没能启动：could not listen on 127.0.0.1: [Errno 48] Address already in use。')
    expect(startFailure('python', '', 'Traceback (most recent call last):\n  File "x"\nSyntaxError: invalid syntax\n')).toBe('窗口的服务没能启动：SyntaxError: invalid syntax。')
    expect(startFailure('python', '', '')).toBe('窗口的服务没能启动：它没有说原因就退出了。')
  })
})

// ---------- the command ----------

describe('/atlas > window or pane', () => {
  test('a terminal alone: the window, on a helper started with the token on its standard input', async ($, on) => {
    const w = world(on, { surfaces: ['terminal'] })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    const r = await atlas($, w)
    expect(r.text).toBe(WINDOW_OPENED)
    expect(r.text).toContain('已在浏览器窗口里打开 Atlas。')
    expect(r.text).toContain('/atlas pane')
    expect(w.panes).toBe(0)
    expect(w.spawned).toHaveLength(1)
    const helper = w.helper()
    expect(helper.argv[0]).toBe('/usr/bin/python3')
    expect(helper.argv[1]).toBe('-I')
    expect(helper.argv[2]).toMatch(ROOT_RE)
    expect(helper.argv.slice(3)).toEqual(['--web', helper.argv[2]?.replace(ROOT_RE, '/web'), '--no-open'])
    // the token: 64 hex digits on standard input, nowhere on the command line, and on every request
    const token = (helper.input ?? '').trim()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(helper.input).toBe(`${token}\n`)
    expect(helper.argv.join(' ')).not.toContain(token)
    expect(w.fetched.map(f => `${f.method} ${f.path}`)).toEqual(['GET /status', 'POST /open'])
    for (const f of w.fetched) expect(f.headers['X-Atlas-Token']).toBe(token)
    expect(w.fetched[1]?.headers['Content-Type']).toBe('application/json')
    // a scan starts, as it does when the pane opens
    await w.flush()
    expect((w.state.scan as { status: string }).status).toBe('done')
  })

  for (const surfaces of [['terminal', 'desktop'], ['desktop'], ['desktop', 'terminal'], ['terminal', 'mobile'], ['vscode']] as const) {
    test(`a graphical surface attached (${surfaces.join(' + ')}): the pane, exactly as before`, async ($, on) => {
      const w = world(on, { surfaces })
      await $.session.start({ cwd: CWD, surface: surfaces[0], isInteractive: true })
      expect((await atlas($, w)).text).toBe('已打开 Atlas 面板。')
      expect(w.panes).toBe(1)
      expect(w.spawned).toHaveLength(0)
      expect(w.fetched).toHaveLength(0)
    })
  }

  test('no surface at all (a -p run): the summary as before, and nothing is started or fetched', async ($, on) => {
    const w = world(on, { surfaces: [], open: { isPlaced: false, reason: 'no surface is attached' } })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
    const r = await atlas($, w)
    expect(r.text).toContain('Atlas：2 个项目有记忆')
    expect(r.text).toContain('这个会话的界面还没接上来')
    expect(w.spawned).toHaveLength(0)
    expect(w.fetched).toHaveLength(0)
    // not even when the window is asked for by name
    expect((await atlas($, w, 'window')).text).toBe(WINDOW_NO_SURFACE)
    expect(w.spawned).toHaveLength(0)
    expect(w.fetched).toHaveLength(0)
  })

  test('where the surfaces cannot be read: the pane', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    expect((await atlas($, w)).text).toBe('已打开 Atlas 面板。')
    expect(w.spawned).toHaveLength(0)
  })

  test('/atlas window opens the window on any surface; /atlas pane the pane in a terminal', async ($, on) => {
    const w = world(on, { surfaces: ['desktop'] })
    await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
    expect((await atlas($, w, 'window')).text).toBe(WINDOW_OPENED)
    expect(w.spawned).toHaveLength(1)
    expect(w.opens()).toBe(1)
    expect(w.panes).toBe(0)
    expect((await atlas($, w, 'pane')).text).toBe('已打开 Atlas 面板。')
    expect(w.panes).toBe(1)
  })

  test('/atlas pane in a terminal session starts no helper', async ($, on) => {
    const w = world(on, { surfaces: ['terminal'] })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    expect((await atlas($, w, 'pane')).text).toBe('已打开 Atlas 面板。')
    expect(w.panes).toBe(1)
    expect(w.spawned).toHaveLength(0)
    expect(w.fetched).toHaveLength(0)
  })

  test('already open: a bare /atlas says so; /atlas window opens another; one helper serves them all', async ($, on) => {
    const w = await opened($, on)
    expect(w.opens()).toBe(1)
    expect((await atlas($, w)).text).toBe(WINDOW_ALREADY)
    expect(w.opens()).toBe(1)
    expect((await atlas($, w, 'window')).text).toBe(WINDOW_OPENED)
    expect(w.opens()).toBe(2)
    // the window was closed: the helper says nobody is looking, and a bare /atlas opens one again
    w.pages.n = 0
    w.helper().say({ page: 'gone' })
    await w.clock.advance(5000)
    expect((await atlas($, w)).text).toBe(WINDOW_OPENED)
    expect(w.opens()).toBe(3)
    expect(w.spawned).toHaveLength(1)
    expect(w.panes).toBe(0)
  })

  test('a second bare /atlas while the first window is still opening opens no second one', async ($, on) => {
    const w = world(on, { surfaces: ['terminal'] })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    expect((await atlas($, w)).text).toBe(WINDOW_OPENED)
    // no page has polled yet
    expect((await atlas($, w)).text).toBe(WINDOW_ALREADY)
    expect(w.opens()).toBe(1)
    await w.clock.advance(5000)
    expect((await atlas($, w)).text).toBe(WINDOW_OPENED)
    expect(w.opens()).toBe(2)
  })

  test('a window the helper could not open: said, and the pane opened instead', async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], opened: { opened: false, how: 'failed', error: 'no browser could be started' } })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    expect((await atlas($, w)).text).toBe('没能打开浏览器窗口：no browser could be started。先打开了嵌在终端里的面板。\n已打开 Atlas 面板。')
    expect(w.panes).toBe(1)
    // asked for by name, there is no falling back
    expect((await atlas($, w, 'window')).text).toBe('没能打开浏览器窗口：no browser could be started。')
    expect(w.panes).toBe(1)
  })

  test('opening suppressed (ATLAS_WINDOW_NO_OPEN=1): said as that', async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], opened: { opened: false, how: 'suppressed' } })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    expect((await atlas($, w, 'window')).text).toBe('没能打开浏览器窗口：ATLAS_WINDOW_NO_OPEN=1 关掉了自动打开。')
  })

  test('a window that did not open leaves its address to be opened by hand, when the helper names a loopback one', async ($, on) => {
    const url = 'http://127.0.0.1:5123/?t=one-use-ticket'
    const w = world(on, { surfaces: ['terminal'], opened: { opened: false, how: 'failed', error: 'no browser could be started', url } })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    expect((await atlas($, w, 'window')).text).toBe(`没能打开浏览器窗口：no browser could be started。可以自己在浏览器里打开这个地址（两分钟内有效，只能用一次）：${url}`)
  })

  test('an address that is not this machine is never shown', async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], opened: { opened: false, how: 'failed', error: 'no browser could be started', url: 'http://elsewhere.example/?t=x' } })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    expect((await atlas($, w, 'window')).text).toBe('没能打开浏览器窗口：no browser could be started。')
  })
})

// ---------- the helper failing ----------

describe('/atlas > the helper does not start', () => {
  test('Python cannot be run: a clear line, and the pane instead', async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], spawnFails: "ENOENT: no such file or directory, posix_spawn '/usr/bin/python3'" })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    const r = await atlas($, w)
    expect(r.text).toContain('没能运行 Python（/usr/bin/python3）')
    expect(r.text).toContain('窗口需要 Python 3.9 或更新的版本。先打开了嵌在终端里的面板。\n已打开 Atlas 面板。')
    expect(w.panes).toBe(1)
    expect(w.fetched).toHaveLength(0)
    const named = await atlas($, w, 'window')
    expect(named.text).toContain('没能运行 Python（/usr/bin/python3）')
    expect(named.text).not.toContain('面板')
    expect(w.panes).toBe(1)
    // each ask is a new try
    expect(w.spawned).toHaveLength(2)
  })

  test('the port cannot be had: what the helper said before it exited', async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], first: '{"ready":false,"error":"could not listen on 127.0.0.1: [Errno 13] Permission denied"}\n' })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    const asked = command($, 'window')
    await w.clock.settle()
    w.helper().exit()
    expect((await asked).text).toBe('窗口的服务没能启动：could not listen on 127.0.0.1: [Errno 13] Permission denied。')
    expect(w.fetched).toHaveLength(0)
  })

  test('a helper that never says it is ready is given ten seconds', async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], first: null })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    let text = ''
    const asked = command($, 'window').then(r => {
      text = r.text ?? ''
    })
    await w.clock.advance(9000)
    expect(text).toBe('')
    await w.clock.advance(1500)
    await asked
    expect(text).toBe('窗口的服务没能启动：等了 10 秒，/usr/bin/python3 还没有回话。')
    expect(w.fetched).toHaveLength(0)
  })

  test('a helper that exits later is started again by the next /atlas', async ($, on) => {
    const w = await opened($, on)
    const before = w.fetched.length
    w.helper().exit()
    await w.flush()
    // nothing is drawn for, or sent to, a helper that is gone
    const ui = await mountPane($)
    await ui.press({ key: 'tab:health' })
    await w.flush()
    expect(w.fetched).toHaveLength(before)
    w.pages.n = 0
    expect((await atlas($, w)).text).toBe(WINDOW_OPENED)
    expect(w.spawned).toHaveLength(2)
    expect(w.spawned[1]?.input).not.toBe(w.spawned[0]?.input)
  })
})

// ---------- the drawing ----------

describe('the window > drawing', () => {
  test('nothing is drawn until a page listens; then the pane as the desktop draws it, at the page width', async ($, on) => {
    const w = world(on, { surfaces: ['terminal'] })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await atlas($, w)
    await w.flush()
    expect(w.pushes()).toHaveLength(0)
    w.pages.n = 1
    w.helper().say({ page: 'open' })
    w.helper().say({ act: { kind: 'hello', width: 528, height: 860 } })
    await w.flush()
    const pushes = w.pushes()
    expect(pushes).toHaveLength(1)
    expect(pushes[0]?.title).toBe('Atlas · proj')
    const tree = pushes[0]?.tree
    // the desktop drawing: the skin menu, pictures, the tabs as buttons with the chosen one primary
    expect(byKey(tree, 'skin')?.type).toBe('Select')
    expect(byKey(tree, 'skin')?.on).toEqual(['select'])
    expect(nodes(tree).some(n => n.type === 'Svg')).toBe(true)
    expect(byKey(tree, 'tab:memory')?.props.variant).toBe('primary')
    expect(byKey(tree, 'tab:skills')?.props.variant).toBe('secondary')
    expect(byKey(tree, 'tab:skills')?.on).toEqual(['press'])
    // the board, with what the page needs to draw it
    const board = byKey(tree, 'board:load')
    expect(board?.type).toBe('Client')
    expect(board?.props.module).toMatch(/board\.tsx$/)
    expect((board?.props.props as { boardId: string; columns: { id: string }[] }).columns.map(c => c.id)).toEqual(['mount', 'read', 'off'])
    // no picture is wider than the page
    for (const pic of nodes(tree).filter(n => n.type === 'Svg')) {
      const width = /<svg[^>]*\swidth="(\d+(?:\.\d+)?)"/.exec(String(pic.props.source))?.[1]
      if (width) expect(Number(width)).toBeLessThanOrEqual(528)
    }
    expect(w.logs.filter(l => l.startsWith('atlas window:'))).toEqual([])
  })

  test('a change is drawn and pushed; one that draws the same is not sent again', async ($, on) => {
    const w = await opened($, on)
    expect(w.trees()).toHaveLength(1)
    await act(w, { kind: 'press', key: 'tab:skills' })
    expect(w.view().tab).toBe('skills')
    expect(w.trees()).toHaveLength(2)
    expect(byKey(lastTree(w), 'tab:skills')?.props.variant).toBe('primary')
    expect(byKey(lastTree(w), 'board:skills')?.type).toBe('Client')
    // the same tab again: state is written, the drawing is the same, and no drawing is sent
    await act(w, { kind: 'press', key: 'tab:skills' })
    expect(w.trees()).toHaveLength(2)
    // nor is anything at all sent for a write that changes nothing the window shows
    const sent = w.pushes().length
    await act(w, { kind: 'resize', width: 528, height: 860 })
    expect(w.pushes()).toHaveLength(sent)
  })

  test('a burst of writes is one drawing', async ($, on) => {
    const w = await opened($, on)
    const before = w.trees().length
    // three presses land before the drawing's short wait is over
    w.helper().say({ act: { kind: 'press', key: 'tab:skills' } })
    w.helper().say({ act: { kind: 'press', key: 'tab:health' } })
    w.helper().say({ act: { kind: 'press', key: 'tab:sessions' } })
    await w.flush()
    expect(w.view().tab).toBe('sessions')
    expect(w.trees().length - before).toBe(1)
    expect(byKey(lastTree(w), 'tab:sessions')?.props.variant).toBe('primary')
  })

  test('a change made elsewhere (the pane, a hook) reaches the window too', async ($, on) => {
    const w = await opened($, on)
    const ui = await mountPane($)
    const before = w.trees().length
    await ui.press({ key: 'tab:health' })
    await w.flush()
    expect(w.trees().length).toBe(before + 1)
    expect(byKey(lastTree(w), 'tab:health')?.props.variant).toBe('primary')
    // and what the window does shows in the pane: both draw from the same state
    await act(w, { kind: 'press', key: 'tab:skills' })
    expect((await ui.find({ key: 'tab:skills' }))?.props.variant).toBe('primary')
  })

  test('no page listening: nothing is drawn or sent, and the next page gets the state as it is then', async ($, on) => {
    const w = await opened($, on)
    w.pages.n = 0
    w.helper().say({ page: 'gone' })
    await w.flush()
    const before = w.pushes().length
    const ui = await mountPane($)
    await ui.press({ key: 'tab:health' })
    await ui.press({ key: 'tab:trash' })
    await w.flush()
    expect(w.pushes()).toHaveLength(before)
    w.pages.n = 1
    w.helper().say({ page: 'open' })
    await w.flush()
    expect(w.pushes()).toHaveLength(before + 1)
    expect(byKey(lastTree(w), 'tab:trash')?.props.variant).toBe('primary')
  })

  test('a resize draws again at the new width', async ($, on) => {
    const w = await opened($, on)
    const narrow = JSON.stringify(lastTree(w))
    await act(w, { kind: 'resize', width: 900, height: 860 })
    expect(w.trees()).toHaveLength(2)
    const wide = JSON.stringify(lastTree(w))
    expect(wide).not.toBe(narrow)
    // the same size again changes nothing
    await act(w, { kind: 'resize', width: 900, height: 860 })
    expect(w.trees()).toHaveLength(2)
  })

  test('every page of the pane draws with no two interactive elements under one key', async ($, on) => {
    const w = await opened($, on)
    for (const tab of ['sessions', 'skills', 'prompt', 'tools', 'hooks', 'structure', 'health', 'trash', 'memory']) {
      await act(w, { kind: 'press', key: `tab:${tab}` })
      expect(w.view().tab).toBe(tab)
      expect(byKey(lastTree(w), `tab:${tab}`)?.props.variant).toBe('primary')
    }
    await act(w, { kind: 'press', key: 'mode:sort' })
    await act(w, { kind: 'press', key: 'tab:hooks' })
    await act(w, { kind: 'press', key: 'hook-new' })
    await act(w, { kind: 'press', key: 'tab:prompt' })
    await act(w, { kind: 'press', key: 'sec:tone' })
    expect(w.logs.filter(l => l.startsWith('atlas window:'))).toEqual([])
  })
})

// ---------- what the page does ----------

describe('the window > what the page does', () => {
  test('a press runs the handler the drawing held: the state change the pane makes', async ($, on) => {
    const w = await opened($, on)
    await act(w, { kind: 'press', key: 'tab:prompt' })
    expect(w.view().tab).toBe('prompt')
    // a row of the page opens its own page, as in the pane
    await act(w, { kind: 'press', key: 'sec:tone' })
    expect(w.view().stack).toEqual([{ kind: 'section', id: 'tone', from: 'sec:tone' }])
    await act(w, { kind: 'press', key: 'back' })
    expect(w.view().stack).toEqual([])
  })

  test('a select: the skin, saved for every session as the pane saves it', async ($, on) => {
    const w = await opened($, on)
    expect(byKey(lastTree(w), 'skin')?.props.value).toBe('journal')
    await act(w, { kind: 'select', key: 'skin', value: 'porto' })
    expect((w.store.get('prefs') as { skin?: string }).skin).toBe('porto')
    expect((w.state.prefs as { skin?: string }).skin).toBe('porto')
    expect(byKey(lastTree(w), 'skin')?.props.value).toBe('porto')
  })

  test('an input and a submit: a field that reports each change, and Enter', async ($, on) => {
    const w = await opened($, on)
    await act(w, { kind: 'press', key: 'tab:hooks' })
    await act(w, { kind: 'press', key: 'hook-new' })
    expect(w.view().stack[0]?.kind).toBe('hooknew')
    expect(byKey(lastTree(w), 'hd-command')?.on).toEqual(['input', 'submit'])
    await act(w, { kind: 'input', key: 'hd-command', value: 'echo 你好' })
    expect(w.view().hookDraft?.command).toBe('echo 你好')
    await act(w, { kind: 'submit', key: 'hd-matcher', value: 'Bash' })
    expect(w.view().hookDraft?.matcher).toBe('Bash')
    // the search field reports only Enter
    await act(w, { kind: 'press', key: 'tab:memory' })
    expect(byKey(lastTree(w), 'search')?.on).toEqual(['submit'])
    await act(w, { kind: 'input', key: 'search', value: 'ignored' })
    expect((w.state.search as { query: string } | undefined)?.query ?? '').toBe('')
    await act(w, { kind: 'submit', key: 'search', value: 'style' })
    expect((w.state.search as { query: string; status: string }).query).toBe('style')
    expect((w.state.search as { query: string; status: string }).status).toBe('done')
    expect(byKey(lastTree(w), 'hit:0')?.type).toBe('Button')
  })

  test('a board message does what the board in the pane does', async ($, on) => {
    const w = await opened($, on)
    await act(w, { kind: 'press', key: 'tab:skills' })
    const board = () => (byKey(lastTree(w), 'board:skills')?.props.props as { columns: { id: string; cards: { id: string }[] }[] }).columns
    expect(board().map(c => [c.id, c.cards.map(x => x.id)])).toEqual([
      ['on', ['s:autodoc', 's:tidy', 's:lint']],
      ['off', []],
    ])
    await act(w, { kind: 'board', data: { board: 'skills', type: 'drop', card: 's:tidy', from: 'on', to: 'off', index: 0 } })
    expect(w.switches()?.skillsOff).toEqual(['tidy'])
    expect(board().map(c => [c.id, c.cards.map(x => x.id)])).toEqual([
      ['on', ['s:autodoc', 's:lint']],
      ['off', ['s:tidy']],
    ])
    // a click on a card opens it
    await act(w, { kind: 'board', data: { board: 'skills', type: 'open', card: 's:autodoc' } })
    expect(w.view().stack).toEqual([{ kind: 'skill', name: 'autodoc' }])
    // what is no post of a board does nothing
    await act(w, { kind: 'board', data: { board: 'skills', type: 'explode' } })
    expect(w.toasts).toEqual([])
  })

  test('a card dragged on the board in the desktop pane and the same drop in the window leave the same switches', async ($, on) => {
    const w = await opened($, on)
    // the pane as the desktop app draws it, its board 119 cells wide: two columns side by side, a row per card
    const ui = await $.ui.mount({
      plugin: 'atlas',
      surface: 'desktop',
      component: 'Pane',
      requestId: 'atlas',
      props: { title: 'Atlas', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
      viewport: { columns: 122, rows: 40, isFullscreen: true },
    })
    await ui.press({ key: 'tab:skills' })
    const board = 'board:skills'
    const drag = async (from: [number, number], to: [number, number]) => {
      await ui.resize({ columns: 119, rows: 21, in: board })
      await ui.pointer({ type: 'down', x: from[0], y: from[1], button: 'left', in: board })
      await ui.pointer({ type: 'move', x: from[0] + 1, y: from[1], button: 'left', in: board })
      await ui.pointer({ type: 'move', x: to[0], y: to[1], button: 'left', in: board })
      await ui.pointer({ type: 'up', x: to[0], y: to[1], button: 'left', in: board })
    }
    // lint is the third card of 开 (the heading is row 0): onto the heading of 关, and back
    await drag([2, 3], [61, 0])
    expect(w.switches()?.skillsOff).toEqual(['lint'])
    const viaPane = JSON.stringify(w.switches())
    await drag([61, 1], [2, 0])
    expect(w.switches()?.skillsOff).toEqual([])
    await act(w, { kind: 'board', data: { board: 'skills', type: 'drop', card: 's:lint', from: 'on', to: 'off', index: 0 } })
    expect(JSON.stringify(w.switches())).toBe(viaPane)
  })

  test('a key the drawing does not hold, and an act that is none, do nothing', async ($, on) => {
    const w = await opened($, on)
    const view = JSON.stringify(w.view())
    const pushes = w.pushes().length
    await act(w, { kind: 'press', key: 'no-such-button' })
    await act(w, { kind: 'select', key: 'tab:skills', value: 'x' })
    await act(w, { kind: 'submit', key: 'skin', value: 'porto' })
    await act(w, { kind: 'eval', code: 'process.exit()' })
    w.helper().piece('this is not json\n')
    w.helper().piece('{"act":"press"}\n')
    await w.flush()
    expect(JSON.stringify(w.view())).toBe(view)
    expect(w.pushes()).toHaveLength(pushes)
    expect(w.toasts).toEqual([])
  })

  test('acts cut across pieces of output still arrive whole and in order', async ($, on) => {
    const w = await opened($, on)
    const lines = `${JSON.stringify({ act: { kind: 'press', key: 'tab:skills' } })}\n${JSON.stringify({ tick: 1 })}\n${JSON.stringify({ act: { kind: 'press', key: 'tab:health' } })}\n`
    for (let i = 0; i < lines.length; i += 11) w.helper().piece(lines.slice(i, i + 11))
    await w.flush()
    expect(w.view().tab).toBe('health')
  })

  test('a toast and the key to focus reach the window while it listens; the terminal still gets the toast', async ($, on) => {
    const w = await opened($, on)
    await act(w, { kind: 'press', key: 'tab:prompt' })
    const last = w.pushes()[w.pushes().length - 1]
    expect(last?.focus).toBe('tab:prompt')
    // a copy toasts
    await act(w, { kind: 'press', key: 'tab:memory' })
    await act(w, { kind: 'press', key: 'global-claude-md' })
    await act(w, { kind: 'press', key: 'f-copy' })
    expect(w.toasts).toEqual(['已复制'])
    expect(w.pushes().some(p => p.toasts?.includes('已复制'))).toBe(true)
    // with nobody looking, the toast is the terminal's alone, and is not kept for a later page
    w.pages.n = 0
    w.helper().say({ page: 'gone' })
    await w.flush()
    const before = w.pushes().length
    const ui = await mountPane($)
    await ui.press({ key: 'f-copy' })
    expect(w.toasts).toEqual(['已复制', '已复制'])
    w.pages.n = 1
    w.helper().say({ page: 'open' })
    await w.flush()
    expect(w.pushes().slice(before).some(p => p.toasts)).toBe(false)
  })

  test('a handler that throws is told in a toast, as the pane tells it', async ($, on) => {
    const w = await opened($, on)
    await act(w, { kind: 'press', key: 'tab:skills' })
    // the store refuses the write a default-level change makes
    w.flags.storeFails = true
    await act(w, { kind: 'press', key: 'scope:skills:global' })
    await act(w, { kind: 'board', data: { board: 'skills', type: 'drop', card: 's:tidy', from: 'on', to: 'off', index: 0 } })
    expect(w.toasts.some(t => t.startsWith('没有完成：'))).toBe(true)
    expect(w.pushes().some(p => p.toasts?.some(t => t.startsWith('没有完成：')))).toBe(true)
  })
})
