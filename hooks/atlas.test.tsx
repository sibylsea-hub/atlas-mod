import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AtlasIndex, DocNode, MemoryFile, TrashMeta } from './data'
import type { AtlasSwitches } from '../types'
import { filterSkillListing, lineDiff, reorderIndexLinks, replaceLine, splitLines, joinLines } from './text'

// ---------- a world beneath the plugin: files, commands, store ----------

const HOME = '/home/t'
const CD = `${HOME}/.claude`
const CWD = '/work/proj'
const SLUG = '-work-proj'
const MEM = `${CD}/projects/${SLUG}/memory`
const OSLUG = '-work-other'
const OMEM = `${CD}/projects/${OSLUG}/memory`
const SHARED = `${CD}/shared-memory`
const SURFACES = ['terminal', 'desktop'] as const
const S1 = `${CD}/projects/${SLUG}/sess-1.jsonl`
type Surface = (typeof SURFACES)[number]

const A_MD = '---\nname: A\ndescription: about a\nmetadata:\n  type: user\n---\n\nbody a\n'
const B_MD = 'just b text\nsecond\n'
const C_MD = '---\nname: C\ndescription: about c\n---\nc body\n'
const S_MD = '---\nname: S\ndescription: shared s\n---\ns body\n'
const INDEX_MD = '- [A](a.md) — about a\n- [Gone](gone.md) — missing\n'

function memFile(dir: string, name: string, title: string, description: string, linked: boolean, type: string | null, hasFm = true): MemoryFile {
  return { name, path: `${dir}/${name}`, size: 40, mtimeMs: 1_760_000_000_000, hasFrontmatter: hasFm, title, description, type, linked }
}

function docNode(path: string, kind: DocNode['kind'], scope: DocNode['scope'], projectSlug: string | null, title: string): DocNode {
  return { id: path, path, kind, scope, projectSlug, exists: true, isSymlink: false, realPath: path, title }
}

function fixture(): AtlasIndex {
  return {
    version: 1,
    generatedAtMs: 1_760_000_000_000,
    elapsedMs: 1234,
    claudeDir: CD,
    home: HOME,
    warnings: [],
    globalClaudeMd: { path: `${CD}/CLAUDE.md`, exists: true, lines: 1, bytes: 9 },
    projects: [
      {
        slug: SLUG,
        cwd: CWD,
        label: 'proj',
        kind: 'project',
        isCurrent: true,
        sessionCount: 1,
        lastActiveMs: 1_760_000_000_000,
        memoryDir: MEM,
        memoryFiles: [memFile(MEM, 'a.md', 'A', 'about a', true, 'user'), memFile(MEM, 'b.md', 'b', 'just b text', false, null, false)],
        index: { exists: true, path: `${MEM}/MEMORY.md`, lines: 2, bytes: 60, overLineLimit: false, overByteLimit: false, links: ['a.md', 'gone.md'], deadLinks: ['gone.md'], orphans: ['b.md'] },
        loads: [{ path: `${CD}/CLAUDE.md`, type: 'User' }],
        pathHistory: [
          { path: CWD, firstSeenMs: 1_759_000_000_000, lastSeenMs: 1_760_000_000_000, exists: true, source: 'cwd', launch: true },
          { path: '/work/proj-old', firstSeenMs: 1_750_000_000_000, lastSeenMs: 1_755_000_000_000, exists: false, source: 'cwd', launch: true },
        ],
        resolvedCwd: CWD,
        resolution: 'exists',
        relatedSlugs: ['-work-proj-old'],
        io: {
          writes: [
            { dir: `${CWD}/src`, count: 3, lastMs: 1_760_000_000_000, class: 'project', via: 'tool' },
            { dir: '/tmp/out', count: 1, lastMs: 1_760_000_000_000, class: 'scratch', via: 'bash' },
          ],
          reads: [{ dir: `${CD}/skills/autodoc`, count: 2, lastMs: 1_760_000_000_000, class: 'claude', via: 'tool' }],
        },
        diskBytes: 3 * 1024 * 1024,
      },
      {
        slug: OSLUG,
        cwd: '/work/other',
        label: 'other',
        kind: 'project',
        isCurrent: false,
        sessionCount: 1,
        lastActiveMs: 1_759_000_000_000,
        memoryDir: OMEM,
        memoryFiles: [memFile(OMEM, 'c.md', 'C', 'about c', false, null)],
        index: null,
        loads: [],
      },
      {
        slug: '-tmp-x',
        cwd: '/tmp/x',
        label: 'x',
        kind: 'tmp',
        isCurrent: false,
        sessionCount: 1,
        lastActiveMs: 1_758_000_000_000,
        memoryDir: null,
        memoryFiles: [],
        index: null,
        loads: [],
      },
    ],
    customMemory: [{ name: 'shared-memory', path: SHARED, files: [memFile(SHARED, 's.md', 'S', 'shared s', true, null)], index: null }],
    sessions: [
      {
        id: 'sess-1',
        projectSlug: SLUG,
        path: `${CD}/projects/${SLUG}/sess-1.jsonl`,
        cwd: CWD,
        title: '整理记忆',
        startedMs: 1_760_000_000_000,
        lastMs: 1_760_000_100_000,
        entrypoint: 'claude-desktop',
        version: '2.1.299',
        loads: [{ path: `${CD}/CLAUDE.md`, type: 'User' }],
        skillsAvailable: ['autodoc', 'anthropic-skills:docx'],
        skillsInvoked: [{ name: 'autodoc', count: 2, via: 'tool', inSubagent: false }],
        memoryReads: [`${MEM}/a.md`],
        memoryWrites: [],
        subagentCount: 0,
      },
    ],
    skills: [
      { name: 'autodoc', source: 'user', path: `${CD}/skills/autodoc/SKILL.md`, description: 'browse sites', plugin: null, projectCwd: null, useCount: 2, sessionsUsing: 1, lastUsedMs: 1_760_000_100_000, listedIn: 1 },
      { name: 'anthropic-skills:docx', source: 'synced', path: `${CD}/skills/synced/b1/docx/SKILL.md`, description: 'word files', plugin: null, projectCwd: null, useCount: 0, sessionsUsing: 0, lastUsedMs: null, listedIn: 1 },
    ],
    docs: {
      nodes: [
        docNode(`${CD}/CLAUDE.md`, 'claude-md', 'global', null, '全局说明'),
        docNode(`${CWD}/CLAUDE.md`, 'claude-md', 'project', SLUG, '项目说明'),
        docNode(`${CWD}/docs/x.md`, 'doc', 'project', SLUG, 'x 文档'),
        docNode(`${MEM}/MEMORY.md`, 'memory-index', 'project', SLUG, 'MEMORY.md'),
        docNode(`${MEM}/a.md`, 'memory', 'project', SLUG, 'A'),
        { ...docNode(`${MEM}/s-link.md`, 'memory', 'project', SLUG, 'S 链接'), isSymlink: true, realPath: `${SHARED}/s.md` },
        docNode(`${SHARED}/s.md`, 'custom-memory', 'shared-memory', null, 'S'),
        { ...docNode(`${MEM}/gone.md`, 'doc', 'project', SLUG, 'gone.md'), exists: false },
      ],
      edges: [
        { from: `${CWD}/CLAUDE.md`, to: `${CWD}/docs/x.md`, type: 'import' },
        { from: `${CWD}/docs/x.md`, to: `${CWD}/CLAUDE.md`, type: 'link' },
        { from: `${MEM}/MEMORY.md`, to: `${MEM}/a.md`, type: 'index' },
        { from: `${MEM}/MEMORY.md`, to: `${MEM}/s-link.md`, type: 'index' },
        { from: `${MEM}/s-link.md`, to: `${SHARED}/s.md`, type: 'symlink' },
        { from: `${MEM}/a.md`, to: `${MEM}/gone.md`, type: 'link' },
      ],
      truncated: false,
    },
    crossProject: [
      { from: SLUG, to: 'shared-memory', kind: 'symlink', count: 5 },
      { from: OSLUG, to: SLUG, kind: 'session-read', count: 2 },
    ],
    scratchWorkspaces: [],
    trash: { path: `${CD}/atlas-trash`, items: 0, bytes: 0 },
    health: [
      { severity: 'warn', kind: 'dead-link', projectSlug: SLUG, path: `${MEM}/MEMORY.md`, message: 'MEMORY.md 链接了不存在的 gone.md' },
      { severity: 'warn', kind: 'orphan', projectSlug: SLUG, path: `${MEM}/b.md`, message: 'b.md 没有被 MEMORY.md 索引' },
      { severity: 'warn', kind: 'no-index', projectSlug: OSLUG, path: OMEM, message: '有记忆文件但没有 MEMORY.md' },
      { severity: 'info', kind: 'no-frontmatter', projectSlug: SLUG, path: `${MEM}/b.md`, message: 'b.md 没有 frontmatter' },
    ],
  }
}

function baseFiles(): Record<string, string> {
  return {
    [`${MEM}/MEMORY.md`]: INDEX_MD,
    [`${MEM}/a.md`]: A_MD,
    [`${MEM}/b.md`]: B_MD,
    [`${OMEM}/c.md`]: C_MD,
    [`${SHARED}/s.md`]: S_MD,
    [`${CD}/CLAUDE.md`]: '# global\n',
    [`${CD}/skills/autodoc/SKILL.md`]: '---\nname: autodoc\ndescription: browse\n---\nuse it\n',
    [`${CD}/skills/synced/b1/docx/SKILL.md`]: '---\nname: docx\ndescription: word\n---\nsynced body\n',
  }
}

type World = {
  /** Atlas's trash as the mocked atlas.py keeps it. */
  trash: Map<string, { meta: TrashMeta; files: [string, string][] }>
  /** What the mocked atlas.py purge answers when no --now is given. */
  autoPurged: TrashMeta[]
  /** The last value the plugin wrote under each of its state keys. */
  state: Record<string, unknown>
  switches: () => AtlasSwitches | undefined
  fs: Map<string, string>
  runs: string[][]
  toasts: string[]
  clock: MockClock
}

const ok = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1)

function world(
  on: On,
  opts: {
    files?: Record<string, string>
    index?: unknown
    indexFails?: string
    store?: Record<string, unknown>
    merged?: string
    trashed?: TrashMeta[]
    autoPurged?: TrashMeta[]
  } = {},
): World {
  const fs = new Map(Object.entries(opts.files ?? baseFiles()))
  const runs: string[][] = []
  const toasts: string[] = []
  const trash = new Map<string, { meta: TrashMeta; files: [string, string][] }>()
  for (const m of opts.trashed ?? []) trash.set(m.id, { meta: m, files: [] })
  let seq = 0
  const atlas = (args: string[]): unknown => {
    const flag = (name: string) => {
      const i = args.indexOf(name)
      return i >= 0 ? args[i + 1] : undefined
    }
    const positional = (from: number) => {
      const out: string[] = []
      for (let i = from; i < args.length; i++) {
        const a = args[i] ?? ''
        if (a.startsWith('--')) {
          i++
          continue
        }
        out.push(a)
      }
      return out
    }
    const cmd = args[0]
    if (cmd === 'trash') {
      const trashed: TrashMeta[] = []
      for (const path of positional(1)) {
        const files = [...fs.entries()].filter(([k]) => k === path || k.startsWith(path + '/'))
        if (files.length === 0) continue
        for (const [k] of files) fs.delete(k)
        const id = `1760000300000-0000000${seq++}`
        const meta: TrashMeta = { id, originalPath: path, kind: flag('--kind') ?? 'memory', pathClass: 'memory', label: flag('--label') ?? base(path), deletedAtMs: 1_760_000_300_000, expiresAtMs: 1_760_000_300_000 + Number(flag('--days') ?? 30) * 86_400_000, sizeBytes: 10 }
        trash.set(id, { meta, files })
        trashed.push(meta)
      }
      return { trashed, refused: trashed.length ? [] : [{ path: args[1], reason: '不存在' }] }
    }
    if (cmd === 'restore') {
      const restored: TrashMeta[] = []
      for (const id of positional(1)) {
        const item = trash.get(id)
        if (!item) continue
        for (const [k, v] of item.files) fs.set(k, v)
        trash.delete(id)
        restored.push(item.meta)
      }
      return { restored, refused: [] }
    }
    if (cmd === 'purge') {
      const now = flag('--now')
      if (now) {
        const item = trash.get(now)
        trash.delete(now)
        return { purged: item ? [item.meta] : [], keptCount: trash.size, freedBytes: item ? item.meta.sizeBytes : 0, dryRun: false, refused: [] }
      }
      const purged = opts.autoPurged ?? []
      return { purged, keptCount: trash.size, freedBytes: purged.reduce((n, m) => n + m.sizeBytes, 0), dryRun: false, refused: [] }
    }
    if (cmd === 'trash-list') {
      const items = [...trash.values()].map(t => ({ ...t.meta, exists: true }))
      return { path: `${CD}/atlas-trash`, items, bytes: items.reduce((n, m) => n + m.sizeBytes, 0) }
    }
    if (cmd === 'set-expiry') {
      const item = trash.get(args[1] ?? '')
      if (item) item.meta = { ...item.meta, expiresAtMs: 1_760_000_300_000 + Number(flag('--days')) * 86_400_000 }
      return item ? { updated: item.meta } : { refused: [{ id: args[1], reason: '没有这一项' }] }
    }
    if (cmd === 'archive-memory') {
      const path = args[1] ?? ''
      const to = `${CD}/memory-archive/${flag('--project-label')}/${base(path)}`
      if (!fs.has(path)) return { archived: null, refused: [{ path, reason: '不存在' }] }
      fs.set(to, fs.get(path) ?? '')
      fs.delete(path)
      return { archived: { from: path, to, indexLines: [] }, refused: [] }
    }
    return { error: `unknown ${cmd}` }
  }
  const isDir = (p: string) => [...fs.keys()].some(k => k.startsWith(p.replace(/\/$/, '') + '/'))
  const state: Record<string, unknown> = {}
  on('state.set', ($, e, next) => {
    if (e.plugin === 'atlas') state[e.key] = e.value
    return next(e)
  })
  const clock = mock.clock(on, { now: 1_760_000_200_000 })
  mock.store(on, opts.store ?? {})
  mock.env(on, { HOME })
  on('session.root', () => ({ value: CWD }))
  on('session.id', () => ({ value: 'current-session' }))
  on('session.cwd', () => ({ value: CWD }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', () => ({ value: { isCopied: true as const } }))
  on('ui.focus', () => ({}))
  on('ui.message', () => ({}))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    if (argv[0] === '/bin/date') return { value: ok('+0800\n') }
    if (argv[0] === '/usr/bin/python3' && argv[3] === 'index') {
      if (opts.indexFails) return { value: ok(JSON.stringify({ error: opts.indexFails }), 1) }
      return { value: ok(JSON.stringify(opts.index ?? fixture())) }
    }
    if (argv[0] === '/usr/bin/python3' && argv[3] !== 'index' && argv[3] !== 'search') {
      return { value: ok(JSON.stringify(atlas(argv.slice(3)))) }
    }
    if (argv[0] === '/usr/bin/python3' && argv[3] === 'search') {
      return { value: ok(JSON.stringify({ query: argv[4], results: [{ path: `${MEM}/a.md`, projectSlug: SLUG, scope: 'project', line: 8, text: 'body a' }] })) }
    }
    if (argv[0] === '/bin/mv' && argv[1] === '-n') {
      const src = argv[2] ?? ''
      const to = argv[3] ?? ''
      const dest = to.endsWith('/') ? to + base(src) : to
      if (fs.has(src) && !fs.has(dest)) {
        fs.set(dest, fs.get(src) ?? '')
        fs.delete(src)
      }
      return { value: ok('') }
    }
    return { value: ok('') }
  })
  on('fs.read', ($, e) => (fs.has(e.path) ? { value: fs.get(e.path) ?? '' } : { deny: `ENOENT ${e.path}` }))
  on('fs.write', ($, e) => {
    fs.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: fs.has(e.path) || isDir(e.path) }))
  on('fs.stat', ($, e) => {
    if (fs.has(e.path)) return { value: { kind: 'file' as const, size: (fs.get(e.path) ?? '').length, mtimeMs: 1_760_000_000_000, isLink: false, realPath: e.path } }
    if (isDir(e.path)) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }
    return { deny: `ENOENT ${e.path}` }
  })
  on('fs.list', ($, e) => {
    const dir = e.path.replace(/\/$/, '')
    const names = new Map<string, 'file' | 'dir'>()
    for (const k of fs.keys()) {
      if (!k.startsWith(dir + '/')) continue
      const rest = k.slice(dir.length + 1)
      const i = rest.indexOf('/')
      names.set(i < 0 ? rest : rest.slice(0, i), i < 0 ? 'file' : 'dir')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: kind === 'file' ? (fs.get(`${dir}/${name}`) ?? '').length : 0, mtimeMs: 0, isLink: false })) }
  })
  on('model.complete', () => ({
    value: {
      isAnswered: true as const,
      text: opts.merged ?? '---\nname: C\ndescription: about c; shared s\n---\nc body\ns body\n',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  on('prompt.context', ($, e) => ({ blocks: e.blocks, ...(e.instructionFiles ? { instructionFiles: e.instructionFiles } : {}) }))
  on('prompt.section', ($, e) => ({ text: e.text }))
  on('skill.prompt', ($, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: 'ran' }))
  return { trash, autoPurged: opts.autoPurged ?? [], state, switches: () => state.switches as AtlasSwitches | undefined, fs, runs, toasts, clock }
}

async function start($: Engine, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'atlas', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(r.text).toContain('已打开')
  await w.clock.settle()
}

const PANE_PROPS = {
  title: 'Atlas · 记忆与 Skills',
  isFocused: true,
  bodyColumns: 120,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

/** Mounts the pane. A heading the desktop draws as a picture is found by its words too, as a Text is. */
async function mountPane($: Engine, surface: Surface) {
  const ui = await $.ui.mount({ plugin: 'atlas', surface, component: 'Pane', requestId: 'atlas', props: PANE_PROPS, viewport: { columns: 122, rows: 40, isFullscreen: true } })
  const find = ui.find.bind(ui)
  const byWords = (async (q: Parameters<typeof find>[0]) => {
    const hit = await find(q)
    if (hit !== undefined || q.type !== 'Text' || q.text === undefined) return hit
    const want = q.text
    const pic = (await ui.findAll({ type: 'Svg' })).find(p => {
      const alt = p.props.alt
      return typeof alt === 'string' && (typeof want === 'string' ? alt === want : want.test(alt))
    })
    return pic ? { ...pic, type: 'Text', text: String(pic.props.alt) } : undefined
  }) as typeof ui.find
  // the mounted drawing is frozen: the same drawing, with this one way of finding
  return { ...ui, find: byWords }
}

/** One test per surface, each with a fresh plugin and world. */
function both(name: string, body: ($: Engine, on: On, surface: Surface) => Promise<void>, timeoutMs = 15_000): void {
  for (const surface of SURFACES) test(`${name} (${surface})`, { timeoutMs }, ($, on) => body($, on, surface))
}

async function pressByText(ui: Awaited<ReturnType<typeof mountPane>>, text: string | RegExp): Promise<void> {
  const b = await ui.find({ type: 'Button', text })
  expect(b, `a Button showing ${String(text)}`).toBeDefined()
  await ui.press({ key: b?.key ?? '' })
}

// The board's geometry as board.tsx lays it out: 119 cells, columns side by side.
const BOARD_W = 119
const colX = (n: number, i: number) => Math.floor(BOARD_W / n) * i + 2

async function drag(ui: Awaited<ReturnType<typeof mountPane>>, board: string, from: [number, number], to: [number, number]): Promise<void> {
  await ui.resize({ columns: BOARD_W, rows: 21, in: board })
  await ui.pointer({ type: 'down', x: from[0], y: from[1], button: 'left', in: board })
  await ui.pointer({ type: 'move', x: from[0] + 1, y: from[1], button: 'left', in: board })
  await ui.pointer({ type: 'move', x: to[0], y: to[1], button: 'left', in: board })
  await ui.pointer({ type: 'up', x: to[0], y: to[1], button: 'left', in: board })
}

// ---------- pure pieces ----------

describe('text helpers', () => {
  test('skill listing drops exactly the off entries, wrapped ones whole', () => {
    const listing = [
      'The following skills are available:',
      '',
      '- autodoc: browse sites',
      '- claude-api: Reference for the API',
      'TRIGGER — read before',
      'SKIP when other providers',
      '- anthropic-skills:docx: Word files',
      '',
      'Trailing note.',
    ].join('\n')
    expect(filterSkillListing(listing, new Set(['claude-api']))).toBe(
      ['The following skills are available:', '', '- autodoc: browse sites', '- anthropic-skills:docx: Word files', '', 'Trailing note.'].join('\n'),
    )
    expect(filterSkillListing(listing, new Set(['anthropic-skills:docx']))).toBe(
      ['The following skills are available:', '', '- autodoc: browse sites', '- claude-api: Reference for the API', 'TRIGGER — read before', 'SKIP when other providers', '', 'Trailing note.'].join('\n'),
    )
    expect(filterSkillListing(listing, new Set())).toBe(listing)
  })

  test('a line edit keeps CRLF and a missing final newline', () => {
    const crlf = 'one\r\ntwo\r\nthree'
    expect(replaceLine(crlf, 1, 'TWO')).toBe('one\r\nTWO\r\nthree')
    expect(joinLines(splitLines('a\n\nb\n'))).toBe('a\n\nb\n')
  })

  test('reorder moves link lines only', () => {
    const s = '# 索引\n\n- [A](a.md) — a\n备注\n- [B](b.md) — b\n'
    expect(reorderIndexLinks(s, ['b.md', 'a.md'])).toBe('# 索引\n\n- [B](b.md) — b\n备注\n- [A](a.md) — a\n')
  })

  test('diff is unified hunks', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nB\nc\n')).toBe('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c')
  })
})

// ---------- the pane ----------

both('the pane opens from /atlas, draws, navigates', async ($, on, surface) => {
  const w = world(on)
  await start($, w)
  const ui = await mountPane($, surface)
  expect(await ui.find({ type: 'Text', text: /^上次扫描 \d\d:\d\d · 用时 1\.2s$/ }), 'pane step 1').toBeDefined()
  expect(await ui.find({ key: `proj:${SLUG}` }), 'pane step 2').toBeDefined()
  expect((await ui.find({ key: `proj:${SLUG}` }))?.text).toContain('本会话')
  expect(await ui.find({ type: 'Text', text: '另有 1 个空记忆目录（1 个来自无文件夹会话）' }), 'pane step 3').toBeDefined()
  await ui.press({ key: `proj:${SLUG}` })
  expect(await ui.find({ type: 'Text', text: 'proj · 本会话' }), 'pane step 4').toBeDefined()
  expect(await ui.find({ key: `mf:${MEM}/b.md` }), 'pane step 5').toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^未索引 · just b text$/ }), 'pane step 6').toBeDefined()
  await ui.press({ key: 'back' })
  expect(await ui.find({ key: `proj:${SLUG}` }), 'pane step 7').toBeDefined()
  await ui.press({ key: 'tab:sessions' })
  expect((await ui.find({ key: `sess:${S1}` }))?.text).toContain('整理记忆')
  await ui.press({ key: `sess:${S1}` })
  expect((await ui.find({ key: 'sk:0' }))?.text).toContain('autodoc ×2')
  await ui.press({ key: 'back' })
  await ui.press({ key: 'tab:skills' })
  expect(await ui.find({ type: 'Client', key: 'board:skills' }), 'pane step 8').toBeDefined()
  await ui.press({ key: 'smode:list' })
  expect(await ui.find({ type: 'Text', text: '从未调用' }), 'pane step 9').toBeDefined()
  await ui.press({ key: 'tab:health' })
  expect(await ui.find({ type: 'Button', text: '加入索引' }), 'pane step 10').toBeDefined()
  expect(await ui.find({ type: 'Text', text: '警告 3' }), 'pane step 11').toBeDefined()
  await ui.unmount()
})

both('an indexer error is shown as an error line', async ($, on, surface) => {
  const w = world(on, { indexFails: 'boom: no projects dir' })
  await start($, w)
  const ui = await mountPane($, surface)
  const line = await ui.find({ type: 'Text', text: /boom: no projects dir/ })
  expect(line?.text).toContain('atlas.py 出错（退出码 1）')
  expect(line?.props.color).toBe('error')
  await ui.unmount()
})

// ---------- switches ----------

both('a skill dropped into 关 leaves the listing, the Skill tool and its prompt', async ($, on, surface) => {
  const w = world(on)
  await start($, w)
  const ui = await mountPane($, surface)
  await ui.press({ key: 'tab:skills' })
  // the click fallback: select the card, then press the 关 header
  await ui.press({ key: 'card:s:autodoc' })
  expect(await ui.find({ in: 'board:skills', type: 'Text', text: /已选中/ })).toBeDefined()
  await ui.press({ key: 'head:off' })
  const sw = { value: w.switches() }
  expect(sw.value?.skillsOff).toEqual(['autodoc'])
  const listing = '- autodoc: browse sites\n  more about autodoc\n- anthropic-skills:docx: Word files\n'
  const shown = await $.prompt.attachment({ type: 'skill_listing', text: listing, origin: { kind: 'engine' } })
  expect(shown.text).toBe('- anthropic-skills:docx: Word files\n')
  const denied = await $.tool.call({ tool: 'Skill', skill: 'autodoc' })
  expect(denied.deny).toBe('这个 skill 已在 Atlas 面板里关闭。')
  const passed = await $.tool.call({ tool: 'Skill', skill: 'anthropic-skills:docx' })
  expect(passed.deny).toBeUndefined()
  const prompt = await $.skill.prompt({ skill: 'autodoc', text: 'do it', frontmatter: {}, source: 'userSettings' })
  expect(prompt.text).toBe('这个 skill 已在 Atlas 面板里关闭，不要使用它。')
  const read = await $.tool.call({ tool: 'Read', file_path: `${CD}/skills/autodoc/SKILL.md` })
  expect(read.deny).toBe('这个 skill 已在 Atlas 面板里关闭。')
  void w
  await ui.unmount()
})

both('a memory group dragged into 关闭 blocks reads inside it only', async ($, on, surface) => {
  const w = world(on)
  await start($, w)
  const ui = await mountPane($, surface)
  // 本会话加载: 挂载 [proj] / 可读 [other, shared-memory] / 关闭 []
  await drag(ui, 'board:load', [colX(3, 1), 1], [colX(3, 2), 3])
  const sw = { value: w.switches() }
  expect(sw.value?.memory).toEqual({ [`project:${OSLUG}`]: 'off' })
  const inside = await $.tool.call({ tool: 'Read', file_path: `${OMEM}/c.md` })
  expect(inside.deny).toBe('这组记忆在 Atlas 面板里关闭了。')
  const bash = await $.tool.call({ tool: 'Bash', command: `cat ${OMEM}/c.md` })
  expect(bash.deny).toBe('这组记忆在 Atlas 面板里关闭了。')
  const outside = await $.tool.call({ tool: 'Read', file_path: `${MEM}/a.md` })
  expect(outside.deny).toBeUndefined()
  void w
  await ui.unmount()
})

both('prompt.context: a 挂载 group adds its files, a file switched off is dropped', async ($, on, surface) => {
  const w = world(on)
  await start($, w)
  const files = [
    { path: `${CD}/CLAUDE.md`, kind: 'user' as const, content: '# global\n' },
    { path: `${MEM}/MEMORY.md`, kind: 'memory' as const, content: INDEX_MD },
  ]
  const first = await $.prompt.context({ blocks: [{ name: 'claudeMd', text: 'x' }], instructionFiles: files })
  expect(first.instructionFiles?.map(f => f.path)).toEqual(files.map(f => f.path))
  const ui = await mountPane($, surface)
  // shared-memory: 可读 → 挂载 (second card of 可读)
  await drag(ui, 'board:load', [colX(3, 1), 2], [colX(3, 0), 0])
  // the loaded global CLAUDE.md is a file card in 挂载 (after the current group); drop it in 可读
  await drag(ui, 'board:load', [colX(3, 0), 3], [colX(3, 1), 0])
  const sw = { value: w.switches() }
  expect(sw.value?.memory).toEqual({ 'shared-memory': 'mount' })
  expect(sw.value?.files).toEqual({ [`${CD}/CLAUDE.md`]: 'read' })
  const next = await $.prompt.context({ blocks: [{ name: 'claudeMd', text: 'x' }], instructionFiles: files })
  expect(next.instructionFiles?.map(f => f.path)).toEqual([`${MEM}/MEMORY.md`, `${SHARED}/s.md`])
  expect(next.instructionFiles?.[1]?.kind).toBe('memory')
  expect(next.instructionFiles?.[1]?.content).toBe(S_MD)
  void w
  await ui.unmount()
})

test('prompt.context passes through unchanged when its own work fails', async ($, on) => {
  const w = world(on)
  on('state.get', { plugin: 'atlas', key: 'switches' }, () => ({ deny: 'state unavailable' }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  const files = [{ path: `${CD}/CLAUDE.md`, kind: 'user' as const, content: '# global\n' }]
  const out = await $.prompt.context({ blocks: [{ name: 'claudeMd', text: 'x' }], instructionFiles: files })
  expect(out.instructionFiles).toEqual(files)
  expect(out.blocks).toEqual([{ name: 'claudeMd', text: 'x' }])
  void w
})

test('stored defaults seed the session switches at session.start', async ($, on) => {
  const w = world(on, {
    store: {
      prefs: {
        skillsOff: { global: ['autodoc'], byProject: { [CWD]: ['anthropic-skills:docx'] } },
        skillDirs: { autodoc: `${CD}/skills/autodoc` },
        memory: { defaults: { global: { 'shared-memory': 'mount' }, byProject: { [CWD]: { [`project:${OSLUG}`]: 'off' } } } },
        groups: [],
      },
    },
  })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  const sw = { value: w.switches() }
  expect(sw.value?.skillsOff).toEqual(['autodoc', 'anthropic-skills:docx'])
  expect(sw.value?.memory).toEqual({ 'shared-memory': 'mount', [`project:${OSLUG}`]: 'off' })
  expect(sw.value?.skillDirs).toEqual({ autodoc: `${CD}/skills/autodoc` })
  const read = await $.tool.call({ tool: 'Read', file_path: `${CD}/skills/autodoc/notes.md` })
  expect(read.deny).toBe('这个 skill 已在 Atlas 面板里关闭。')
})

// ---------- the editor ----------

const E_PATH = `${MEM}/e.md`
const E_CRLF = '---\r\nname: E\r\ndescription: old desc\r\n---\r\nline one\r\nline two'

async function openEditor($: Engine, on: On, surface: Surface, text: string) {
  const files = { ...baseFiles(), [E_PATH]: text }
  const idx = fixture()
  idx.projects[0]?.memoryFiles.push(memFile(MEM, 'e.md', 'E', 'old desc', true, null))
  const w = world(on, { files, index: idx })
  await start($, w)
  const ui = await mountPane($, surface)
  await ui.press({ key: `proj:${SLUG}` })
  await ui.press({ key: `mf:${E_PATH}` })
  await ui.press({ key: 'f-mode' })
  return { w, ui }
}

both('a line edit writes the whole file with one line changed (CRLF, no final newline)', async ($, on, surface) => {
  const { w, ui } = await openEditor($, on, surface, E_CRLF)
  expect((await ui.find({ key: 'line:5' }))?.props.value).toBe('line two')
  await ui.input({ key: 'line:5', text: 'line 2' })
  expect(w.fs.get(E_PATH)).toBe('---\r\nname: E\r\ndescription: old desc\r\n---\r\nline one\r\nline 2')
  expect(w.toasts).toContain('已保存')
  await ui.press({ key: 'ins:4' })
  expect(w.fs.get(E_PATH)).toBe('---\r\nname: E\r\ndescription: old desc\r\n---\r\nline one\r\n\r\nline 2')
  await ui.press({ key: 'del:5' })
  expect(w.fs.get(E_PATH)).toBe('---\r\nname: E\r\ndescription: old desc\r\n---\r\nline one\r\nline 2')
  await ui.unmount()
})

both('a frontmatter field edit leaves the body untouched', async ($, on, surface) => {
  const { w, ui } = await openEditor($, on, surface, E_CRLF)
  await ui.input({ key: 'fm:description', text: '新的描述: 有冒号' })
  expect(w.fs.get(E_PATH)).toBe('---\r\nname: E\r\ndescription: "新的描述: 有冒号"\r\n---\r\nline one\r\nline two')
  await ui.unmount()
})

both('a file changed on disk refuses the write; undo restores the last save', async ($, on, surface) => {
  const { w, ui } = await openEditor($, on, surface, 'a\nb\n')
  await ui.input({ key: 'line:0', text: 'A' })
  expect(w.fs.get(E_PATH)).toBe('A\nb\n')
  await ui.press({ key: 'f-undo' })
  expect(w.fs.get(E_PATH)).toBe('a\nb\n')
  w.fs.set(E_PATH, 'changed elsewhere\n')
  await ui.input({ key: 'line:1', text: 'B' })
  expect(w.fs.get(E_PATH)).toBe('changed elsewhere\n')
  expect(await ui.find({ type: 'Text', text: '文件在外面被改过了' })).toBeDefined()
  await ui.press({ key: 'f-reload' })
  expect((await ui.find({ key: 'line:0' }))?.props.value).toBe('changed elsewhere')
  await ui.unmount()
})

both('synced and plugin skill files show no edit controls', async ($, on, surface) => {
  const w = world(on)
  await start($, w)
  const ui = await mountPane($, surface)
  await ui.press({ key: 'tab:skills' })
  await ui.press({ key: 'smode:list' })
  await ui.press({ key: 'skill:anthropic-skills:docx' })
  expect(await ui.find({ type: 'Text', text: '只读：由 Claude 应用同步/插件提供，改了会被覆盖' })).toBeDefined()
  await ui.press({ key: `skf:${CD}/skills/synced/b1/docx/SKILL.md` })
  expect(await ui.find({ type: 'Text', text: /docx\/SKILL\.md$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '只读：由 Claude 应用同步/插件提供，改了会被覆盖' })).toBeDefined()
  expect(await ui.find({ key: 'f-mode' })).toBeUndefined()
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  await ui.unmount()
})

// ---------- the 记忆整理 board ----------

async function sortBoard($: Engine, on: On, surface: Surface, files?: Record<string, string>) {
  const w = world(on, files ? { files } : {})
  await start($, w)
  const ui = await mountPane($, surface)
  await ui.press({ key: 'mode:sort' })
  return { w, ui }
}
// columns: proj [a.md, b.md] | shared-memory [s.md] | other [c.md]

both('dragging a memory file to another project moves it and fixes both MEMORY.md', async ($, on, surface) => {
  const { w, ui } = await sortBoard($, on, surface)
  await drag(ui, 'board:sort', [colX(3, 0), 1], [colX(3, 2), 5])
  expect(w.runs).toContainEqual(['/bin/mv', '-n', `${MEM}/a.md`, `${OMEM}/`])
  expect(w.fs.has(`${MEM}/a.md`)).toBe(false)
  expect(w.fs.get(`${OMEM}/a.md`)).toBe(A_MD)
  expect(w.fs.get(`${MEM}/MEMORY.md`)).toBe('- [Gone](gone.md) — missing\n')
  expect(w.fs.get(`${OMEM}/MEMORY.md`)).toBe('- [A](a.md) — about a\n')
  expect(w.toasts).toContain('已移到 other')
  await ui.press({ key: 'op-undo' })
  expect(w.fs.get(`${MEM}/a.md`)).toBe(A_MD)
  expect(w.fs.get(`${MEM}/MEMORY.md`)).toBe(INDEX_MD)
  await ui.unmount()
})

both('a name clash in the target group changes nothing', async ($, on, surface) => {
  const files = { ...baseFiles(), [`${OMEM}/b.md`]: 'other b\n' }
  const { w, ui } = await sortBoard($, on, surface, files)
  const before = [...w.fs.entries()]
  await drag(ui, 'board:sort', [colX(3, 0), 2], [colX(3, 2), 0])
  expect([...w.fs.entries()]).toEqual(before)
  expect(w.runs.some(r => r[0] === '/bin/mv')).toBe(false)
  expect(await ui.find({ type: 'Text', text: /other 里已经有 b\.md，没有移动/ })).toBeDefined()
  await ui.unmount()
})

both('a card dropped on a card merges: diff, then 应用 writes and trashes the source', async ($, on, surface) => {
  const { w, ui } = await sortBoard($, on, surface)
  await drag(ui, 'board:sort', [colX(3, 1), 1], [colX(3, 2), 1])
  const diff = await ui.find({ type: 'Code' })
  expect(diff?.props.format).toBe('diff')
  expect(diff?.text).toContain('+s body')
  expect(await ui.find({ type: 'Text', text: '合并后 s.md 会移进回收站（7 天后自动清空），并从 MEMORY.md 去掉' })).toBeDefined()
  await ui.press({ key: 'merge-apply' })
  expect(w.fs.get(`${OMEM}/c.md`)).toBe('---\nname: C\ndescription: about c; shared s\n---\nc body\ns body\n')
  expect(w.runs.map(r => r.slice(3))).toContainEqual(['trash', `${SHARED}/s.md`, '--days', '7', '--kind', 'memory', '--label', 's.md', '--protect-session', 'current-session'])
  expect(w.fs.has(`${SHARED}/s.md`)).toBe(false)
  expect(w.runs.some(r => r[0] === '/bin/mv')).toBe(false)
  await ui.press({ key: 'op-undo' })
  expect(w.fs.get(`${SHARED}/s.md`)).toBe(S_MD)
  expect(w.fs.get(`${OMEM}/c.md`)).toBe(C_MD)
  await ui.unmount()
})

both('reordering inside a project column keeps every non-link line', async ($, on, surface) => {
  const index = '# 索引\n\n- [A](a.md) — a\n备注行\n- [B](b.md) — b\n'
  const { w, ui } = await sortBoard($, on, surface, { ...baseFiles(), [`${MEM}/MEMORY.md`]: index })
  await drag(ui, 'board:sort', [colX(3, 0), 2], [colX(3, 0), 1])
  expect(w.fs.get(`${MEM}/MEMORY.md`)).toBe('# 索引\n\n- [B](b.md) — b\n备注行\n- [A](a.md) — a\n')
  await ui.unmount()
})

both('a click on a card opens it; select + header press drops it', async ($, on, surface) => {
  const { w, ui } = await sortBoard($, on, surface)
  await ui.resize({ columns: BOARD_W, rows: 21, in: 'board:sort' })
  await ui.pointer({ type: 'down', x: colX(3, 2), y: 1, button: 'left', in: 'board:sort' })
  await ui.pointer({ type: 'up', x: colX(3, 2), y: 1, button: 'left', in: 'board:sort' })
  expect(await ui.find({ type: 'Text', text: '~/.claude/projects/-work-other/memory/c.md' })).toBeDefined()
  await ui.press({ key: 'back' })
  await ui.press({ key: `card:${SHARED}/s.md` })
  await ui.press({ key: `head:project:${OSLUG}` })
  expect(w.runs).toContainEqual(['/bin/mv', '-n', `${SHARED}/s.md`, `${OMEM}/`])
  expect(w.fs.get(`${OMEM}/MEMORY.md`)).toBe('- [S](s.md) — shared s\n')
  await ui.unmount()
})

// ---------- 体检 one-click fixes ----------

both('each 体检 fix writes what it says', async ($, on, surface) => {
  const w = world(on)
  await start($, w)
  const ui = await mountPane($, surface)
  await ui.press({ key: 'tab:health' })
  await pressByText(ui, '删掉这条链接')
  expect(w.fs.get(`${MEM}/MEMORY.md`)).toBe('- [A](a.md) — about a\n')
  await pressByText(ui, '加入索引')
  expect(w.fs.get(`${MEM}/MEMORY.md`)).toBe('- [A](a.md) — about a\n- [b](b.md) — just b text\n')
  await pressByText(ui, '生成 MEMORY.md')
  expect(w.fs.get(`${OMEM}/MEMORY.md`)).toBe('- [C](c.md) — about c\n')
  await pressByText(ui, '补 frontmatter')
  expect((await ui.find({ key: 'fmd:name' }))?.props.value).toBe('b')
  expect((await ui.find({ key: 'fmd:description' }))?.props.value).toBe('just b text')
  await ui.press({ key: 'fmd:write' })
  expect(w.fs.get(`${MEM}/b.md`)).toBe('---\nname: b\ndescription: just b text\n---\n\njust b text\nsecond\n')
  await ui.unmount()
})

// ---------- 结构, 交织, 去向 ----------

both('the document tree nests, marks symlinks and missing files, stops at a cycle', async ($, on, surface) => {
  const w = world(on)
  await start($, w)
  const ui = await mountPane($, surface)
  await ui.press({ key: 'tab:structure' })
  expect((await ui.find({ key: 'node:0' }))?.props.label).toBe('全局说明')
  expect((await ui.find({ key: 'node:1' }))?.props.label).toBe('项目说明')
  expect((await ui.find({ key: 'node:1.0' }))?.props.label).toBe('x 文档')
  expect(await ui.find({ type: 'Text', text: '@导入' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '索引 ↪ ~/.claude/shared-memory/s.md' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '└─ ' })).toBeDefined()
  expect(await ui.find({ key: 'node:1.0.0' })).toBeUndefined()
  await ui.press({ key: 'tog:1.0' })
  expect((await ui.find({ key: 'node:1.0.0' }))?.props.label).toBe('项目说明')
  expect(await ui.find({ type: 'Text', text: '链接 （循环）' })).toBeDefined()
  expect(await ui.find({ key: 'tog:1.0.0' })).toBeUndefined()
  await ui.press({ key: 'tog:2.0' })
  expect(await ui.find({ type: 'Text', text: '链接 （不存在）' })).toBeDefined()
  await ui.press({ key: 'open:2.0' })
  expect(w.runs).toContainEqual(['/usr/bin/open', '-R', `${MEM}/a.md`])
  await ui.press({ key: 'node:1.0' })
  expect(await ui.find({ type: 'Text', text: '/work/proj/docs/x.md' })).toBeDefined()
  await ui.unmount()
})

both('交织: an Svg graph on the desktop only, a list everywhere', async ($, on, surface) => {
  const w = world(on)
  await start($, w)
  const ui = await mountPane($, surface)
  await ui.press({ key: 'tab:structure' })
  await ui.press({ key: 'smode:cross' })
  const svg = await ui.find({ type: 'Svg' })
  if (surface === 'desktop') {
    expect(svg).toBeDefined()
    expect(String(svg?.props.source)).toContain('共享记忆')
    expect(String(svg?.props.source).length).toBeLessThan(131_072)
  } else {
    expect(svg).toBeUndefined()
  }
  expect((await ui.find({ key: 'cross:0' }))?.props.label).toBe('proj → 共享记忆 · 软链接 · 5')
  expect((await ui.find({ key: 'cross:1' }))?.props.label).toBe('other → proj · 会话读 · 2')
  await ui.press({ key: 'cross:1' })
  expect(await ui.find({ type: 'Text', text: 'other' })).toBeDefined()
  await ui.unmount()
})

both('去向 lists where a project wrote and read, each with 打开', async ($, on, surface) => {
  const w = world(on)
  await start($, w)
  const ui = await mountPane($, surface)
  await ui.press({ key: `proj:${SLUG}` })
  expect(await ui.find({ type: 'Text', text: '/work/proj/src  ×3 · 项目内' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '/tmp/out  ×1 · 临时 · bash' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '~/.claude/skills/autodoc  ×2 · Claude' })).toBeDefined()
  await ui.press({ key: `open:io:p:${SLUG}:w:0` })
  expect(w.runs).toContainEqual(['/usr/bin/open', `${CWD}/src`])
  await ui.press({ key: 'open:p-cwd' })
  expect(w.runs).toContainEqual(['/usr/bin/open', CWD])
  expect(await ui.find({ type: 'Text', text: /^\/work\/proj-old  启动处 · （不存在）/ })).toBeDefined()
  await ui.unmount()
})

// ---------- delete, restore, purge, archive ----------

both('删除 takes two presses and calls atlas.py trash with --days and --protect-session; 撤销 restores', async ($, on, surface) => {
  const w = world(on, { files: { ...baseFiles(), [S1]: '{}\n' } })
  await start($, w)
  const ui = await mountPane($, surface)
  await ui.press({ key: 'tab:sessions' })
  await ui.press({ key: `sess:${S1}` })
  expect(await ui.find({ type: 'Text', text: '桌面 app 侧栏里这条会话还在，但打不开了；要从侧栏去掉，请在 app 里删除或归档它' })).toBeDefined()
  await ui.select({ key: `days:session:${S1}`, value: '30' })
  await ui.press({ key: `del:session:${S1}` })
  expect(w.runs.some(r => r[3] === 'trash')).toBe(false)
  expect((await ui.find({ key: `delok:session:${S1}` }))?.props.label).toBe('确认删除（30 天后自动清空）')
  await ui.press({ key: `delok:session:${S1}` })
  expect(w.runs.map(r => r.slice(3))).toContainEqual([
    'trash',
    `${CD}/projects/${SLUG}/sess-1.jsonl`,
    '--days',
    '30',
    '--label',
    '会话「整理记忆」',
    '--kind',
    'session',
    '--protect-session',
    'current-session',
  ])
  expect(w.fs.has(`${CD}/projects/${SLUG}/sess-1.jsonl`)).toBe(false)
  expect(w.toasts).toContain('已删除 会话「整理记忆」，30 天内可在回收站恢复')
  await ui.press({ key: 'op-undo' })
  expect(w.runs.map(r => r.slice(3, 4))).toContainEqual(['restore'])
  expect(w.fs.get(`${CD}/projects/${SLUG}/sess-1.jsonl`)).toBe('{}\n')
  await ui.unmount()
})

test('the current session offers no 删除', async ($, on) => {
  const idx = fixture()
  const s0 = idx.sessions[0]
  if (s0) s0.id = 'current-session'
  const w = world(on, { index: idx })
  await start($, w)
  const ui = await mountPane($, 'desktop')
  await ui.press({ key: 'tab:sessions' })
  await ui.press({ key: `sess:${S1}` })
  expect(await ui.find({ type: 'Text', text: '这是当前会话，不能删除。' })).toBeDefined()
  expect(await ui.find({ key: `del:session:${S1}` })).toBeUndefined()
  await ui.unmount()
})

const ITEM: TrashMeta = {
  id: '1760000000000-abcdef01',
  originalPath: `${MEM}/old.md`,
  kind: 'memory',
  pathClass: 'memory',
  label: 'old.md',
  deletedAtMs: 1_760_000_000_000,
  expiresAtMs: 1_760_600_000_000,
  sizeBytes: 2048,
}

both('回收站: 恢复, 改保存时间, and 立即清空 only after 确认永久删除', async ($, on, surface) => {
  const w = world(on, { trashed: [ITEM, { ...ITEM, id: '1760000000000-abcdef02', label: 'two.md' }] })
  await start($, w)
  const ui = await mountPane($, surface)
  await ui.press({ key: 'tab:trash' })
  expect(await ui.find({ type: 'Text', text: '回收站占用 4.0 KB' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '到期的东西每 6 小时自动清空一次；只在开着带 Atlas 的会话时才会运行。' })).toBeDefined()
  await ui.select({ key: `expiry:${ITEM.id}`, value: '90' })
  expect(w.runs.map(r => r.slice(3))).toContainEqual(['set-expiry', ITEM.id, '--days', '90'])
  await ui.press({ key: `purge:${ITEM.id}` })
  expect(w.runs.some(r => r[3] === 'purge' && r[4] === '--now')).toBe(false)
  expect((await ui.find({ key: `purgeok:${ITEM.id}` }))?.props.label).toBe('确认永久删除')
  await ui.press({ key: `purgeok:${ITEM.id}` })
  expect(w.runs.map(r => r.slice(3))).toContainEqual(['purge', '--now', ITEM.id])
  expect(w.trash.has(ITEM.id)).toBe(false)
  await ui.press({ key: 'restore:1760000000000-abcdef02' })
  expect(w.runs.map(r => r.slice(3))).toContainEqual(['restore', '1760000000000-abcdef02'])
  expect(await ui.find({ type: 'Text', text: '回收站是空的' })).toBeDefined()
  await ui.unmount()
})

both('归档 a memory file calls atlas.py archive-memory', async ($, on, surface) => {
  const w = world(on)
  await start($, w)
  const ui = await mountPane($, surface)
  await ui.press({ key: `proj:${SLUG}` })
  await ui.press({ key: `mf:${MEM}/a.md` })
  expect((await ui.find({ key: 'f-archive' }))?.props.label).toBe('归档到 memory-archive/proj/')
  expect(await ui.find({ key: `del:file:${MEM}/a.md` })).toBeDefined()
  await ui.press({ key: 'f-archive' })
  expect(w.runs.map(r => r.slice(3))).toContainEqual(['archive-memory', `${MEM}/a.md`, '--project-label', 'proj'])
  expect(w.fs.get(`${CD}/memory-archive/proj/a.md`)).toBe(A_MD)
  expect(w.runs.some(r => r[3] === 'trash')).toBe(false)
  await ui.unmount()
})

both('an archived session leaves the list until 显示已归档', async ($, on, surface) => {
  const w = world(on)
  await start($, w)
  const ui = await mountPane($, surface)
  await ui.press({ key: 'tab:sessions' })
  await ui.press({ key: `sess:${S1}` })
  await ui.press({ key: `arch:sessions:${S1}` })
  await ui.press({ key: 'back' })
  expect(await ui.find({ key: `sess:${S1}` })).toBeUndefined()
  expect((await ui.find({ key: 'showarch:sessions' }))?.props.label).toBe('显示已归档（1）')
  await ui.press({ key: 'showarch:sessions' })
  expect(await ui.find({ key: `sess:${S1}` })).toBeDefined()
  expect(w.runs.some(r => r[3] === 'trash')).toBe(false)
  await ui.unmount()
})

test('session.start purges expired trash and says what it freed', async ($, on) => {
  const w = world(on, { autoPurged: [{ ...ITEM, sizeBytes: 2 * 1024 * 1024 }] })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  expect(w.runs.map(r => r.slice(3))).toContainEqual(['purge'])
  expect(w.toasts).toContain('回收站自动清空了 1 项，释放 2.0 MB')
  const before = w.runs.filter(r => r[3] === 'purge').length
  await w.clock.advance(6 * 3600_000)
  expect(w.runs.filter(r => r[3] === 'purge').length).toBe(before + 1)
})

// ---------- inert by default ----------

test('the guards stay inert when the switches cannot be read', async ($, on) => {
  world(on)
  on('state.get', { plugin: 'atlas', key: 'switches' }, () => ({ deny: 'state unavailable' }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  expect((await $.tool.call({ tool: 'Read', file_path: `${OMEM}/c.md` })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: `cat ${OMEM}/c.md` })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Write', file_path: `${MEM}/new.md`, content: 'x' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Skill', skill: 'autodoc' })).deny).toBeUndefined()
})

test('with no switch touched, prompt.context leaves the files as Claude Code loaded them', async ($, on) => {
  const w = world(on)
  await start($, w)
  const files = [{ path: `${CD}/CLAUDE.md`, kind: 'user' as const, content: '# global\n' }]
  const out = await $.prompt.context({ blocks: [{ name: 'claudeMd', text: 'x' }], instructionFiles: files })
  expect(out.instructionFiles).toEqual(files)
  const listing = '- autodoc: browse\n'
  expect((await $.prompt.attachment({ type: 'skill_listing', text: listing, origin: { kind: 'engine' } })).text).toBe(listing)
  expect((await $.prompt.section({ name: 'memory', text: 'memory rules' })).text).toBe('memory rules')
})
