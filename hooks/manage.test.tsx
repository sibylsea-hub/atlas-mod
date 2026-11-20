// Tests for the 提示词 and Hooks pages: the pure half (manage.ts) by itself,
// then both pages through the pane, over a mocked world. Nothing here reads
// or writes a real file: every `$.fs` / `$.store` call ends in this file.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Plugin } from 'claude-code/testing'

import type { AtlasManage, AtlasParkedHook, AtlasPromptEdits, AtlasPromptExtra, AtlasSwitches } from '../types'
import {
  addHook,
  applyCompose,
  approxTokens,
  draftHook,
  dropExtra,
  editSettings,
  editsIn,
  extraId,
  mergeEdits,
  normalizeEdits,
  normalizeParked,
  parkedRow,
  parseHooks,
  parseTimeout,
  putExtra,
  removeAt,
  rowId,
  scanHooks,
  scriptPath,
  sectionAnswer,
  sectionRows,
  sessionEdits,
  setOff,
  setRewrite,
  settingsFiles,
  updateAt,
} from './manage'
import type { HooksTable, SectionSeen } from './manage'
import { levelEdits, levelState, levelsText, levelsWhere, sectionLevelsText } from './manage'
import { heldM, injectCaution, injectLevelsText, injectName, injectOffOf, recordInject, setInjectOff } from './manage'
import { SENT_KEPT, isOwnPrompt, keepSent, outsideName, outsideOf, sectionsMark, settleOutside, splitOutside, systemBlocks } from './manage'
import { kilo } from './journal-specs'
import { cleanName, renameLevelsText, renameOf, renameUser, setRename } from './manage'
import {
  mcpParts,
  recordTool,
  setToolPlace,
  setToolRewrite,
  toolAnswer,
  toolLevelState,
  toolLevelsText,
  toolMarks,
  toolNamesIn,
  toolOffDeny,
  toolOrigin,
  toolPlaceOf,
  toolRewriteOf,
  toolRow,
  toolRows,
} from './manage'
import type { ToolListed, ToolSeen } from './manage'
import { basename, dirname, isAbsolutePath, isInside, normalizePath, shortPath, slashes, slugify } from './text'
import { VIEW0, normalizePrefs, notPlacedText } from './model'
import { buttonKind } from './views'
import { ARCHIVE, JOURNAL, PORTO_SKIN, RIVIERA_SKIN, SKINS, skinOf } from './skins'

// ---------- fixtures ----------

const HOME = '/home/t'
const CD = `${HOME}/.claude`
const CWD = '/work/proj'
const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]

const USER_SETTINGS = `${CD}/settings.json`
const PROJECT_SETTINGS = `${CWD}/.claude/settings.json`
const LOCAL_SETTINGS = `${CWD}/.claude/settings.local.json`
const OTHER_SETTINGS = '/work/other/.claude/settings.json'

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/** A settings file as Atlas is meant to write one: 2-space JSON, a final newline. */
function pretty(doc: unknown): string {
  return JSON.stringify(doc, null, 2) + '\n'
}

/** Deep-frozen: a function that changes its argument throws instead of passing. */
function frozen<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const x of Object.values(v)) frozen(x)
  }
  return v
}

type Hook = Record<string, unknown>
type Group = { matcher?: string; hooks: Hook[] }
type Settings = Record<string, unknown> & { hooks: Record<string, Group[]> }

const GUARD: Hook = { type: 'command', command: 'bash ~/.claude/hooks/guard.sh', timeout: 5 }
const SECOND: Hook = { type: 'command', command: 'echo second' }
const EDIT: Hook = { type: 'command', command: 'echo edit', async: true }
const DONE: Hook = { type: 'command', command: 'say done' }
const PROMPTED: Hook = { type: 'command', command: 'echo prompt' }

/** A user settings file with plenty beside its hooks, fresh on every call. */
function settings(): Settings {
  return clone({
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    model: 'opus',
    permissions: { allow: ['Bash(ls:*)', 'Read(~/notes/**)'], deny: [], defaultMode: 'acceptEdits' },
    env: { FOO: 'bar', EMPTY: '' },
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [GUARD, SECOND] },
        { matcher: 'Edit|Write', hooks: [EDIT] },
      ],
      Stop: [{ hooks: [DONE] }],
    },
    statusLine: { type: 'command', command: 'echo hi', padding: 0 },
    includeCoAuthoredBy: false,
    cleanupPeriodDays: 30,
    nothing: null,
    enabledPlugins: { 'atlas@local': true },
    注释: '中文键、"引号" 和 \\ 反斜杠也要原样留下',
  })
}

const USER_TEXT = pretty(settings())
const PROJECT_TEXT = pretty({ hooks: { UserPromptSubmit: [{ hooks: [PROMPTED] }] } })

function group(doc: Settings, event: string, g: number): Group {
  const found = doc.hooks[event]?.[g]
  if (!found) throw new Error(`the fixture has no group ${event}[${g}]`)
  return found
}

/** The user settings fixture after `change`, as the text Atlas should have written. */
function userText(change: (doc: Settings) => void, from: Settings = settings()): string {
  change(from)
  return pretty(from)
}

function hooksTable(): HooksTable {
  return settings().hooks
}

/** Where a hook stands, as a row names it. */
function at(event: string, g: number, i: number, hook: Hook, matcher = '') {
  return { event, g, i, json: JSON.stringify(hook), matcher }
}

function extra(id: string, text: string, off = false, name = id): AtlasPromptExtra {
  return { id, name, text, off }
}

const NONE: AtlasPromptEdits = { off: [], rewrite: {}, extra: [] }

type Section = { id: string; text: string; scope: 'shared' | 'session' }

const INTRO = 'You are an agent.'
const TONE = 'Be brief and kind.'
const ENV = 'cwd: /work/proj'
const SECTIONS: readonly Section[] = [
  { id: 'intro', text: INTRO, scope: 'shared' },
  { id: 'tone', text: TONE, scope: 'shared' },
  { id: 'env_info_simple', text: ENV, scope: 'session' },
]

// ---------- pure: 提示词 ----------

describe('manage.ts 提示词', () => {
  test('normalizeEdits keeps well-formed edits only', () => {
    for (const junk of [null, undefined, 'x', 3, true, []]) expect(normalizeEdits(junk)).toEqual(NONE)
    expect(
      normalizeEdits({
        off: ['tone', 3, 'tone', null, 'intro'],
        rewrite: { tone: 'T', bad: 1, worse: null },
        extra: [
          { id: 'atlas:a', name: 'A', text: 'ta', off: true },
          { id: 'atlas:a', name: 'a second one under the same id', text: 'x' },
          { id: 'atlas:b' },
          { id: '', name: 'no id' },
          { name: 'no id either' },
          'junk',
          null,
          { id: 'atlas:c', name: 5, text: 6, off: 'yes' },
        ],
        somethingElse: true,
      }),
    ).toEqual({
      off: ['tone', 'intro'],
      rewrite: { tone: 'T' },
      extra: [
        { id: 'atlas:a', name: 'A', text: 'ta', off: true },
        { id: 'atlas:b', name: 'atlas:b', text: '', off: false },
        { id: 'atlas:c', name: 'atlas:c', text: '', off: false },
      ],
    })
  })

  test('mergeEdits: the global default, then the project over it', () => {
    const global = frozen<AtlasPromptEdits>({
      off: ['tone', 'intro'],
      rewrite: { intro: 'G intro', env: 'G env' },
      extra: [extra('atlas:a', 'global a'), extra('atlas:g', 'global g')],
    })
    const project = frozen<AtlasPromptEdits>({
      off: ['intro', 'memory'],
      rewrite: { intro: 'P intro' },
      extra: [extra('atlas:p', 'project p'), extra('atlas:a', 'project a')],
    })
    expect(mergeEdits(global, project)).toEqual({
      off: ['tone', 'intro', 'memory'],
      rewrite: { intro: 'P intro', env: 'G env' },
      extra: [extra('atlas:p', 'project p'), extra('atlas:a', 'project a'), extra('atlas:g', 'global g')],
    })
    expect(mergeEdits(global, undefined)).toEqual(global)
    expect(mergeEdits(NONE, project)).toEqual(project)
  })

  test('sessionEdits and editsIn read the level asked for', () => {
    const mine: AtlasPromptEdits = { off: ['tone'], rewrite: {}, extra: [] }
    const sw: AtlasSwitches = { skillsOff: [], skillDirs: {}, memory: {}, files: {}, prompt: mine }
    const old: AtlasSwitches = { skillsOff: [], skillDirs: {}, memory: {}, files: {} }
    expect(sessionEdits(sw)).toEqual(mine)
    expect(sessionEdits(old)).toEqual(NONE)
    expect(sessionEdits(null)).toEqual(NONE)
    expect(sessionEdits(undefined)).toEqual(NONE)
    const g: AtlasPromptEdits = { off: ['g'], rewrite: {}, extra: [] }
    const p: AtlasPromptEdits = { off: ['p'], rewrite: {}, extra: [] }
    const base = { skillsOff: { global: [], byProject: {} }, skillDirs: {}, memory: { defaults: { global: {}, byProject: {} } }, groups: [], archived: { sessions: [], projects: [] } }
    const prefs = { ...base, prompt: { global: g, byProject: { [CWD]: p } } }
    expect(editsIn(prefs, 'session', CWD, sw)).toEqual(mine)
    expect(editsIn(prefs, 'global', CWD, sw)).toEqual(g)
    expect(editsIn(prefs, 'project', CWD, sw)).toEqual(p)
    expect(editsIn(prefs, 'project', '/work/elsewhere', sw)).toEqual(NONE)
    // prefs an earlier version stored hold no prompt edits at all
    expect(editsIn(base, 'global', CWD, sw)).toEqual(NONE)
    expect(editsIn(base, 'project', CWD, sw)).toEqual(NONE)
  })

  test('setOff adds once and removes, leaving what it was given untouched', () => {
    const e = frozen<AtlasPromptEdits>({ off: ['intro'], rewrite: { tone: 'T' }, extra: [extra('atlas:a', 'a')] })
    expect(setOff(e, 'tone', true)).toEqual({ ...e, off: ['intro', 'tone'] })
    expect(setOff(e, 'intro', true)).toEqual(e)
    expect(setOff(e, 'intro', false)).toEqual({ ...e, off: [] })
    expect(setOff(e, 'never-off', false)).toEqual(e)
  })

  test('setRewrite sets, replaces and (null) takes back', () => {
    const e = frozen<AtlasPromptEdits>({ off: ['intro'], rewrite: { tone: 'T' }, extra: [] })
    expect(setRewrite(e, 'env', 'E')).toEqual({ ...e, rewrite: { tone: 'T', env: 'E' } })
    expect(setRewrite(e, 'tone', 'T2')).toEqual({ ...e, rewrite: { tone: 'T2' } })
    expect(setRewrite(e, 'tone', null)).toEqual({ ...e, rewrite: {} })
    expect(setRewrite(e, 'env', null)).toEqual(e)
  })

  test('putExtra appends a new section and replaces one in place; dropExtra removes just that one', () => {
    const e = frozen<AtlasPromptEdits>({ off: ['intro'], rewrite: {}, extra: [extra('atlas:a', 'a'), extra('atlas:b', 'b')] })
    expect(putExtra(e, extra('atlas:c', 'c')).extra).toEqual([extra('atlas:a', 'a'), extra('atlas:b', 'b'), extra('atlas:c', 'c')])
    expect(putExtra(e, extra('atlas:a', 'A!', true)).extra).toEqual([extra('atlas:a', 'A!', true), extra('atlas:b', 'b')])
    expect(dropExtra(e, 'atlas:a')).toEqual({ ...e, extra: [extra('atlas:b', 'b')] })
    expect(dropExtra(e, 'atlas:none')).toEqual(e)
  })

  test('extraId: atlas:<slug>, numbered when taken', () => {
    expect(extraId('说话方式', [])).toBe('atlas:说话方式')
    expect(extraId('  My   Style ', [])).toBe('atlas:my-style')
    expect(extraId('a: b', [])).toBe('atlas:a-b')
    expect(extraId(':::', [])).toBe('atlas:section')
    expect(extraId('Style', ['atlas:style'])).toBe('atlas:style-2')
    expect(extraId('Style', ['atlas:style', 'atlas:style-2'])).toBe('atlas:style-3')
    expect(extraId('x'.repeat(100), [])).toBe('atlas:' + 'x'.repeat(40))
    for (const name of ['One two\tthree', 'a::b', ' 新 的 段 ', 'atlas:x']) {
      const id = extraId(name, [])
      expect(id).toMatch(/^atlas:[^\s:]+$/)
    }
  })

  test('sectionAnswer: off leaves it out, a rewrite replaces it, anything else passes', () => {
    const e: AtlasPromptEdits = { off: ['tone', 'both'], rewrite: { env: 'E2', both: 'B2', gone: 'G2' }, extra: [] }
    expect(sectionAnswer(e, 'tone', 'T')).toEqual({ text: null })
    expect(sectionAnswer(e, 'tone', null)).toEqual({ text: null })
    expect(sectionAnswer(e, 'env', 'E')).toEqual({ text: 'E2' })
    // off wins over a rewrite
    expect(sectionAnswer(e, 'both', 'B')).toEqual({ text: null })
    // a section the engine leaves out stays out
    expect(sectionAnswer(e, 'gone', null)).toBeNull()
    expect(sectionAnswer(e, 'intro', 'I')).toBeNull()
    expect(sectionAnswer(NONE, 'tone', 'T')).toBeNull()
  })

  test('applyCompose drops off sections, replaces rewritten ones, puts enabled own sections last', () => {
    const list = frozen<SectionSeen[]>([
      { id: 'intro', text: 'I', scope: 'shared' },
      { id: 'tone', text: 'T', scope: 'shared' },
      { id: 'both', text: 'B', scope: 'shared' },
      { id: 'env', text: 'E', scope: 'session' },
    ])
    const e = frozen<AtlasPromptEdits>({
      off: ['tone', 'both'],
      rewrite: { env: 'E2', both: 'B2', absent: 'never sent' },
      extra: [extra('atlas:a', 'text a'), extra('atlas:off', 'not sent', true), extra('atlas:blank', '  \n\t'), extra('atlas:z', 'text z')],
    })
    const out = applyCompose(e, list)
    expect(out).toEqual([
      { id: 'intro', text: 'I', scope: 'shared' },
      { id: 'env', text: 'E2', scope: 'session' },
      { id: 'atlas:a', text: 'text a', scope: 'session' },
      { id: 'atlas:z', text: 'text z', scope: 'session' },
    ])
    // every shared section still ahead of every session one
    const firstSession = out.findIndex(s => s.scope === 'session')
    expect(out.slice(firstSession).every(s => s.scope === 'session')).toBe(true)
    expect(applyCompose(NONE, list)).toEqual(list)
  })

  test('applyCompose keeps a rewritten section on its side of the cache boundary, and other fields', () => {
    const list = [{ id: 'tone', text: 'T', scope: 'shared' as const, note: 'kept' }]
    expect(applyCompose({ off: [], rewrite: { tone: 'T2' }, extra: [] }, list)).toEqual([{ id: 'tone', text: 'T2', scope: 'shared', note: 'kept' }])
  })

  test('applyCompose: an own section already in the list is replaced where it stands, not sent twice', () => {
    const list: SectionSeen[] = [
      { id: 'intro', text: 'I', scope: 'shared' },
      { id: 'atlas:a', text: 'as composed before', scope: 'session' },
      { id: 'env', text: 'E', scope: 'session' },
    ]
    expect(applyCompose({ off: [], rewrite: {}, extra: [extra('atlas:a', 'text a')] }, list)).toEqual([
      { id: 'intro', text: 'I', scope: 'shared' },
      { id: 'atlas:a', text: 'text a', scope: 'session' },
      { id: 'env', text: 'E', scope: 'session' },
    ])
  })

  test('sectionRows: composed sections in order, then the off ones known only from their originals', () => {
    const composed: SectionSeen[] = [
      { id: 'intro', text: 'I', scope: 'shared' },
      { id: 'env', text: 'E2', scope: 'session' },
      { id: 'atlas:a', text: 'own', scope: 'session' },
    ]
    const original = new Map<string, string | null>([
      ['intro', 'I'],
      ['tone', 'T'],
      ['env', 'E'],
      ['left_out_by_engine', null],
      ['atlas:a', 'own'],
    ])
    const e: AtlasPromptEdits = { off: ['tone', 'ghost'], rewrite: { env: 'E2' }, extra: [extra('atlas:a', 'own')] }
    expect(sectionRows(composed, original, e)).toEqual([
      { id: 'intro', scope: 'shared', state: 'on', original: 'I', sent: 'I' },
      { id: 'env', scope: 'session', state: 'rewritten', original: 'E', sent: 'E2' },
      { id: 'tone', scope: null, state: 'off', original: 'T', sent: null },
      // off at this level though the engine never showed it: still listed, so it can be switched on
      { id: 'ghost', scope: null, state: 'off', original: null, sent: null },
    ])
  })

  test('sectionRows: with no original seen, a rewritten section does not pass its rewrite off as the original', () => {
    // what loadPrompt holds after a reload: the composed text is already the
    // rewrite and nothing recorded the engine's own text (register.tsx:1391)
    const composed: SectionSeen[] = [{ id: 'tone', text: 'my rewrite', scope: 'shared' }]
    const rows = sectionRows(composed, new Map(), { off: [], rewrite: { tone: 'my rewrite' }, extra: [] })
    expect(rows).toEqual([{ id: 'tone', scope: 'shared', state: 'rewritten', original: null, sent: 'my rewrite' }])
  })

  test('approxTokens: about four characters each, a CJK character about one', () => {
    expect(approxTokens('')).toBe(0)
    expect(approxTokens('abcd')).toBe(1)
    expect(approxTokens('abcde')).toBe(2)
    expect(approxTokens('你好')).toBe(2)
    expect(approxTokens('你好ab')).toBe(3)
  })
})

// ---------- pure: Hooks ----------

describe('manage.ts Hooks', () => {
  test('settingsFiles names the three files, each path once', () => {
    expect(settingsFiles({ claudeDir: CD, cwd: CWD })).toEqual([
      { source: 'user', path: USER_SETTINGS },
      { source: 'project', path: PROJECT_SETTINGS },
      { source: 'local', path: LOCAL_SETTINGS },
    ])
    // a session started in the home folder: the project's file is the user's
    expect(settingsFiles({ claudeDir: CD, cwd: HOME })).toEqual([
      { source: 'user', path: USER_SETTINGS },
      { source: 'local', path: `${HOME}/.claude/settings.local.json` },
    ])
    expect(settingsFiles({ claudeDir: CD, cwd: '' })).toEqual([{ source: 'user', path: USER_SETTINGS }])
    expect(settingsFiles({ claudeDir: '', cwd: '' })).toEqual([])
  })

  test('rowId is <source>:<Event>:<groupIndex>:<hookIndex>', () => {
    expect(rowId('user', 'PreToolUse', 0, 1)).toBe('user:PreToolUse:0:1')
    expect(rowId('local', 'Stop', 2, 0)).toBe('local:Stop:2:0')
  })

  test('parseHooks lists every hook in the file order, with where it stands', () => {
    const text = JSON.stringify({
      model: 'opus',
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh', timeout: 5 }, { type: 'prompt', prompt: 'is it safe?' }] },
          { hooks: [{ type: 'http', url: 'https://example.test/hook' }] },
        ],
        Stop: [{ matcher: '', hooks: [{ command: 'say done' }] }],
      },
    })
    const { rows, error } = parseHooks({ source: 'user', path: '/f.json', text })
    expect(error).toBeNull()
    expect(rows).toEqual([
      { id: 'user:PreToolUse:0:0', isOn: true, source: 'user', file: '/f.json', event: 'PreToolUse', matcher: 'Bash', g: 0, i: 0, type: 'command', body: 'guard.sh', timeout: 5, json: '{"type":"command","command":"guard.sh","timeout":5}' },
      { id: 'user:PreToolUse:0:1', isOn: true, source: 'user', file: '/f.json', event: 'PreToolUse', matcher: 'Bash', g: 0, i: 1, type: 'prompt', body: 'is it safe?', timeout: null, json: '{"type":"prompt","prompt":"is it safe?"}' },
      { id: 'user:PreToolUse:1:0', isOn: true, source: 'user', file: '/f.json', event: 'PreToolUse', matcher: '', g: 1, i: 0, type: 'http', body: 'https://example.test/hook', timeout: null, json: '{"type":"http","url":"https://example.test/hook"}' },
      { id: 'user:Stop:0:0', isOn: true, source: 'user', file: '/f.json', event: 'Stop', matcher: '', g: 0, i: 0, type: 'command', body: 'say done', timeout: null, json: '{"command":"say done"}' },
    ])
  })

  test('parseHooks: no file, an empty file and a file with no hooks are all "none", not an error', () => {
    for (const text of [null, '', '  \n', '{}', '{"model":"opus"}', '{"hooks":{}}']) {
      expect(parseHooks({ source: 'project', path: '/f.json', text })).toEqual({ rows: [], error: null })
    }
  })

  test('parseHooks says so when it cannot read the file as settings', () => {
    for (const text of ['{', '{ "a": 1, }', '// a comment\n{}', '[]', '"x"', '3', 'null', '{"hooks": []}', '{"hooks": "x"}']) {
      const out = parseHooks({ source: 'user', path: '/f.json', text })
      expect(out.rows, text).toEqual([])
      expect(typeof out.error, text).toBe('string')
    }
  })

  test('parseHooks skips what is not a hook and keeps the real places of the rest', () => {
    const text = JSON.stringify({ hooks: { A: 'x', B: [null, 'x', { hooks: 'no' }, { matcher: 5, hooks: [null, 3, { command: 'ok' }] }] } })
    const { rows, error } = parseHooks({ source: 'local', path: '/f.json', text })
    expect(error).toBeNull()
    expect(rows.map(r => [r.id, r.matcher, r.body])).toEqual([['local:B:3:2', '', 'ok']])
  })

  test('scanHooks: every file with its own error, the parked hooks after, switched off', () => {
    const parked: AtlasParkedHook[] = [
      { id: 'off:1', file: '/u.json', event: 'Stop', matcher: '', json: JSON.stringify(DONE) },
      { id: 'off:2', file: OTHER_SETTINGS, event: 'PreToolUse', matcher: 'Bash', json: JSON.stringify(GUARD) },
    ]
    const scan = scanHooks(
      [
        { source: 'user', path: '/u.json', text: '{ broken' },
        { source: 'project', path: '/p.json', text: PROJECT_TEXT },
        { source: 'local', path: '/l.json', text: null },
      ],
      parked,
    )
    expect(scan.files.map(f => [f.source, f.path, f.error === null])).toEqual([
      ['user', '/u.json', false],
      ['project', '/p.json', true],
      ['local', '/l.json', true],
    ])
    expect(scan.files[0]?.text).toBe('{ broken')
    expect(scan.rows.map(r => [r.id, r.isOn, r.source, r.file])).toEqual([
      ['project:UserPromptSubmit:0:0', true, 'project', '/p.json'],
      ['off:1', false, 'user', '/u.json'],
      // parked from a file this session does not read: no source
      ['off:2', false, null, OTHER_SETTINGS],
    ])
  })

  test('parkedRow shows the hook as it was stored', () => {
    const files = [{ source: 'user' as const, path: USER_SETTINGS }]
    expect(parkedRow({ id: 'off:1', file: USER_SETTINGS, event: 'PreToolUse', matcher: 'Bash', json: JSON.stringify(GUARD) }, files)).toEqual({
      id: 'off:1',
      isOn: false,
      source: 'user',
      file: USER_SETTINGS,
      event: 'PreToolUse',
      matcher: 'Bash',
      g: -1,
      i: -1,
      type: 'command',
      body: 'bash ~/.claude/hooks/guard.sh',
      timeout: 5,
      json: JSON.stringify(GUARD),
    })
    // stored text that is no hook: shown empty, the text kept as it is
    const broken = parkedRow({ id: 'off:2', file: USER_SETTINGS, event: 'Stop', matcher: '', json: '{ nope' }, files)
    expect(broken.body).toBe('')
    expect(broken.json).toBe('{ nope')
    expect(broken.isOn).toBe(false)
  })

  test('normalizeParked keeps well-formed entries, each id once', () => {
    for (const junk of [null, undefined, 'x', {}, 3]) expect(normalizeParked(junk)).toEqual([])
    expect(
      normalizeParked([
        { id: 'off:1', file: '/f', event: 'Stop', matcher: 'm', json: '{}' },
        { id: 'off:1', file: '/other', event: 'Stop', matcher: '', json: '{}' },
        { id: 'off:2', file: '/f', event: 'Stop', json: '{}' },
        { id: 'off:3', file: '/f', event: 'Stop', matcher: '' },
        { id: 'off:4', event: 'Stop', matcher: '', json: '{}' },
        { file: '/f', event: 'Stop', matcher: '', json: '{}' },
        null,
        'x',
      ]),
    ).toEqual([
      { id: 'off:1', file: '/f', event: 'Stop', matcher: 'm', json: '{}' },
      { id: 'off:2', file: '/f', event: 'Stop', matcher: '', json: '{}' },
    ])
  })

  test('editSettings: every other key survives, in order; 2-space JSON with a final newline', () => {
    // the file as a person might keep it: 4 spaces, no final newline
    const before = JSON.stringify(settings(), null, 4)
    const after = editSettings(before, table => void removeAt(table, at('PreToolUse', 0, 1, SECOND)))
    expect(after).toBe(userText(d => group(d, 'PreToolUse', 0).hooks.splice(1, 1)))
    const doc = JSON.parse(after) as Settings
    const want = settings()
    expect(Object.keys(doc)).toEqual(Object.keys(want))
    for (const key of Object.keys(want)) if (key !== 'hooks') expect(doc[key], key).toEqual(want[key])
    expect(after.endsWith('}\n')).toBe(true)
    expect(after).toContain('\n  "model": "opus",\n')
    expect(after).not.toContain('\t')
  })

  test('editSettings: a change that changes nothing gives a normal file back byte for byte', () => {
    expect(editSettings(USER_TEXT, () => undefined)).toBe(USER_TEXT)
    // and adds no "hooks" to a file that has none
    expect(editSettings('{\n  "model": "opus"\n}\n', () => undefined)).toBe('{\n  "model": "opus"\n}\n')
    expect(editSettings('{\n  "hooks": {}\n}\n', () => undefined)).toBe('{\n  "hooks": {}\n}\n')
  })

  test('editSettings: no file or an empty one starts from an empty settings object', () => {
    for (const text of [null, '', ' \n']) {
      expect(editSettings(text, table => void addHook(table, 'Stop', '', DONE))).toBe(pretty({ hooks: { Stop: [{ hooks: [DONE] }] } }))
    }
    // a file with other keys and no hooks: the hooks go in, the rest stays ahead of them
    expect(editSettings('{"model":"opus","env":{"A":"1"}}', table => void addHook(table, 'Stop', '', DONE))).toBe(
      pretty({ model: 'opus', env: { A: '1' }, hooks: { Stop: [{ hooks: [DONE] }] } }),
    )
  })

  test('editSettings refuses a file it cannot read as a settings object, before any change', () => {
    for (const text of ['{', '{ "a": 1, }', '// a comment\n{}', '{"a":1} trailing', '[]', '"x"', '3', 'null', '{"hooks": []}', '{"hooks": "x"}', '{"hooks": null}']) {
      let called = false
      expect(() =>
        editSettings(text, () => {
          called = true
        }),
      ).toThrow()
      expect(called, text).toBe(false)
    }
  })

  test('editSettings: the last hook of a matcher group takes the group with it, the last group its event', () => {
    // one of two hooks: the group stays
    let after = editSettings(USER_TEXT, table => void removeAt(table, at('PreToolUse', 0, 0, GUARD)))
    expect(after).toBe(userText(d => group(d, 'PreToolUse', 0).hooks.splice(0, 1)))
    // the only hook of a group: the group goes, the event keeps its other group
    after = editSettings(USER_TEXT, table => void removeAt(table, at('PreToolUse', 1, 0, EDIT)))
    expect(after).toBe(userText(d => d.hooks.PreToolUse?.splice(1, 1)))
    // the only hook of an event: the event's key goes, the other events stay
    after = editSettings(USER_TEXT, table => void removeAt(table, at('Stop', 0, 0, DONE)))
    expect(after).toBe(userText(d => delete d.hooks.Stop))
    expect(Object.keys((JSON.parse(after) as Settings).hooks)).toEqual(['PreToolUse'])
  })

  test('editSettings: taking out every hook leaves the rest of the file as it was', () => {
    const after = editSettings(USER_TEXT, table => {
      removeAt(table, at('PreToolUse', 0, 1, SECOND))
      removeAt(table, at('PreToolUse', 0, 0, GUARD))
      removeAt(table, at('PreToolUse', 1, 0, EDIT))
      removeAt(table, at('Stop', 0, 0, DONE))
    })
    const doc = JSON.parse(after) as Record<string, unknown>
    const want: Record<string, unknown> = settings()
    for (const key of Object.keys(want)) if (key !== 'hooks') expect(doc[key], key).toEqual(want[key])
    expect(parseHooks({ source: 'user', path: USER_SETTINGS, text: after })).toEqual({ rows: [], error: null })
  })

  test('removeAt takes out the hook at the place and answers it', () => {
    const table = hooksTable()
    expect(removeAt(table, at('PreToolUse', 0, 0, GUARD))).toEqual(GUARD)
    expect(table).toEqual({
      PreToolUse: [
        { matcher: 'Bash', hooks: [SECOND] },
        { matcher: 'Edit|Write', hooks: [EDIT] },
      ],
      Stop: [{ hooks: [DONE] }],
    })
  })

  test('removeAt refuses when another hook stands at the place, and changes nothing', () => {
    const places = [
      at('PreToolUse', 0, 0, SECOND), // the hook that stands at 0:1
      at('PreToolUse', 0, 5, GUARD),
      at('PreToolUse', 7, 0, GUARD),
      at('Nope', 0, 0, GUARD),
      at('Stop', 0, 0, { ...DONE, timeout: 1 }),
      at('PreToolUse', -1, -1, GUARD), // a parked row's place
    ]
    for (const place of places) {
      const table = hooksTable()
      expect(() => removeAt(table, place), JSON.stringify(place)).toThrow()
      expect(table, JSON.stringify(place)).toEqual(hooksTable())
    }
  })

  test('addHook joins the group with the same matcher, or starts one', () => {
    const table = hooksTable()
    const NEW: Hook = { type: 'command', command: 'echo new' }
    expect(addHook(table, 'PreToolUse', 'Edit|Write', NEW)).toEqual({ g: 1, i: 1 })
    expect(addHook(table, 'PreToolUse', 'Read', NEW)).toEqual({ g: 2, i: 0 })
    // no matcher: the group without one, written without the key
    expect(addHook(table, 'Stop', '', NEW)).toEqual({ g: 0, i: 1 })
    expect(addHook(table, 'PreToolUse', '', NEW)).toEqual({ g: 3, i: 0 })
    expect(addHook(table, 'Notification', 'idle', NEW)).toEqual({ g: 0, i: 0 })
    expect(table).toEqual({
      PreToolUse: [
        { matcher: 'Bash', hooks: [GUARD, SECOND] },
        { matcher: 'Edit|Write', hooks: [EDIT, NEW] },
        { matcher: 'Read', hooks: [NEW] },
        { hooks: [NEW] },
      ],
      Stop: [{ hooks: [DONE, NEW] }],
      Notification: [{ matcher: 'idle', hooks: [NEW] }],
    })
    expect(Object.keys((table.PreToolUse as Group[])[3] ?? {})).toEqual(['hooks'])
    // a group written with an empty matcher is the no-matcher group too
    const other: HooksTable = { Stop: [{ matcher: '', hooks: [DONE] }] }
    expect(addHook(other, 'Stop', '', NEW)).toEqual({ g: 0, i: 1 })
  })

  test('the place addHook answers is where the hook stands in the file editSettings writes', () => {
    // a hand-edited file that still holds an emptied group ahead of the others
    const NEW: Hook = { type: 'command', command: 'echo new' }
    const text = pretty({ hooks: { PreToolUse: [{ matcher: 'A', hooks: [] }, { matcher: 'B', hooks: [SECOND] }] } })
    let place = { g: -1, i: -1 }
    const after = editSettings(text, table => {
      place = addHook(table, 'PreToolUse', 'C', NEW)
    })
    const row = parseHooks({ source: 'user', path: USER_SETTINGS, text: after }).rows.find(r => r.json === JSON.stringify(NEW))
    expect(row?.id).toBe(rowId('user', 'PreToolUse', place.g, place.i))
  })

  test('addHook does not write over an event whose value is not a list of groups', () => {
    // the brackets forgotten: Atlas lists no hook for it, and the text is the person's to fix
    const text = pretty({ model: 'opus', hooks: { Stop: { hooks: [DONE] } } })
    expect(parseHooks({ source: 'user', path: USER_SETTINGS, text })).toEqual({ rows: [], error: null })
    let after: string
    try {
      after = editSettings(text, table => void addHook(table, 'Stop', '', SECOND))
    } catch {
      return // refused: nothing is written, which is fine
    }
    expect(after).toContain('say done')
  })

  test('parseTimeout: seconds, empty for none, null for anything else', () => {
    expect(parseTimeout('')).toBeUndefined()
    expect(parseTimeout('   ')).toBeUndefined()
    expect(parseTimeout('30')).toBe(30)
    expect(parseTimeout(' 2.5 ')).toBe(2.5)
    for (const bad of ['abc', '-1', '0', '-0.5', '5s', '1 2', 'NaN', 'Infinity', '１０']) expect(parseTimeout(bad), bad).toBeNull()
  })

  test('updateAt changes the body under the key the hook already uses', () => {
    const table: HooksTable = {
      Stop: [{ hooks: [{ type: 'command', command: 'old', statusMessage: 'kept' }, { type: 'prompt', prompt: 'old?' }, { type: 'http', url: 'https://old.test' }] }],
    }
    const hooks = (table.Stop as Group[])[0]?.hooks ?? []
    expect(updateAt(table, at('Stop', 0, 0, hooks[0] ?? {}), { body: 'new --flag' })).toEqual({ g: 0, i: 0 })
    updateAt(table, at('Stop', 0, 1, hooks[1] ?? {}), { body: 'new?' })
    updateAt(table, at('Stop', 0, 2, hooks[2] ?? {}), { body: 'https://new.test' })
    expect(table).toEqual({
      Stop: [{ hooks: [{ type: 'command', command: 'new --flag', statusMessage: 'kept' }, { type: 'prompt', prompt: 'new?' }, { type: 'http', url: 'https://new.test' }] }],
    })
  })

  test('updateAt sets and clears the timeout', () => {
    const table = hooksTable()
    updateAt(table, at('Stop', 0, 0, DONE), { timeout: '30' })
    expect((table.Stop as Group[])[0]?.hooks).toEqual([{ ...DONE, timeout: 30 }])
    updateAt(table, at('PreToolUse', 0, 0, GUARD, 'Bash'), { timeout: ' ' })
    expect((table.PreToolUse as Group[])[0]?.hooks).toEqual([{ type: 'command', command: 'bash ~/.claude/hooks/guard.sh' }, SECOND])
  })

  test('updateAt refuses an empty body and a bad timeout', () => {
    for (const patch of [{ body: '' }, { body: '  \n' }, { timeout: 'abc' }, { timeout: '-1' }, { timeout: '0' }]) {
      const table = hooksTable()
      expect(() => updateAt(table, at('PreToolUse', 0, 0, GUARD, 'Bash'), patch), JSON.stringify(patch)).toThrow()
    }
    // and through editSettings nothing comes out to write
    expect(() => editSettings(USER_TEXT, table => void updateAt(table, at('PreToolUse', 0, 0, GUARD, 'Bash'), { body: 'changed', timeout: 'abc' }))).toThrow()
  })

  test('updateAt refuses when another hook stands at the place', () => {
    const table = hooksTable()
    expect(() => updateAt(table, at('PreToolUse', 0, 0, SECOND, 'Bash'), { body: 'x' })).toThrow()
    expect(() => updateAt(table, at('Stop', 3, 0, DONE), { body: 'x' })).toThrow()
    expect(table).toEqual(hooksTable())
  })

  test('updateAt: a new matcher moves only that hook when it shares its group', () => {
    // to a matcher another group has: it joins that group
    let table = hooksTable()
    expect(updateAt(table, at('PreToolUse', 0, 1, SECOND, 'Bash'), { matcher: 'Edit|Write' })).toEqual({ g: 1, i: 1 })
    expect(table).toEqual({
      PreToolUse: [
        { matcher: 'Bash', hooks: [GUARD] },
        { matcher: 'Edit|Write', hooks: [EDIT, SECOND] },
      ],
      Stop: [{ hooks: [DONE] }],
    })
    // to a matcher no group has: a group of its own, last
    table = hooksTable()
    expect(updateAt(table, at('PreToolUse', 0, 0, GUARD, 'Bash'), { matcher: 'Read' })).toEqual({ g: 2, i: 0 })
    expect(table.PreToolUse).toEqual([
      { matcher: 'Bash', hooks: [SECOND] },
      { matcher: 'Edit|Write', hooks: [EDIT] },
      { matcher: 'Read', hooks: [GUARD] },
    ])
    // to no matcher
    table = hooksTable()
    expect(updateAt(table, at('PreToolUse', 0, 0, GUARD, 'Bash'), { matcher: '' })).toEqual({ g: 2, i: 0 })
    expect(table.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [SECOND] }, { matcher: 'Edit|Write', hooks: [EDIT] }, { hooks: [GUARD] }])
    // the same matcher: nothing moves
    table = hooksTable()
    expect(updateAt(table, at('PreToolUse', 0, 1, SECOND, 'Bash'), { matcher: 'Bash' })).toEqual({ g: 0, i: 1 })
    expect(table).toEqual(hooksTable())
  })

  test('updateAt: a hook alone in its group keeps its place, the group takes the new matcher', () => {
    let table = hooksTable()
    expect(updateAt(table, at('PreToolUse', 1, 0, EDIT, 'Edit|Write'), { matcher: 'Write' })).toEqual({ g: 1, i: 0 })
    expect(table.PreToolUse).toEqual([
      { matcher: 'Bash', hooks: [GUARD, SECOND] },
      { matcher: 'Write', hooks: [EDIT] },
    ])
    table = hooksTable()
    updateAt(table, at('PreToolUse', 1, 0, EDIT, 'Edit|Write'), { matcher: '' })
    expect(Object.keys((table.PreToolUse as Group[])[1] ?? {})).toEqual(['hooks'])
    table = hooksTable()
    updateAt(table, at('Stop', 0, 0, DONE, ''), { matcher: 'x' })
    expect(table.Stop).toEqual([{ matcher: 'x', hooks: [DONE] }])
  })

  test('draftHook: a command hook from what was typed; refuses no command, no event, a bad timeout', () => {
    const d = { file: USER_SETTINGS, event: 'Stop', matcher: '', command: 'say hi', timeout: '' }
    expect(draftHook(d)).toEqual({ type: 'command', command: 'say hi' })
    expect(draftHook({ ...d, timeout: '12' })).toEqual({ type: 'command', command: 'say hi', timeout: 12 })
    for (const bad of [{ command: '' }, { command: '  \n ' }, { timeout: 'abc' }, { timeout: '-1' }, { timeout: '0' }, { event: '' }]) {
      expect(() => draftHook({ ...d, ...bad }), JSON.stringify(bad)).toThrow()
    }
  })

  test('scriptPath finds the script a command names', () => {
    expect(scriptPath('bash ~/.claude/hooks/guard.sh', HOME, CWD)).toBe(`${HOME}/.claude/hooks/guard.sh`)
    expect(scriptPath('python3 $HOME/bin/check.py --fast', HOME, CWD)).toBe(`${HOME}/bin/check.py`)
    expect(scriptPath('node "${HOME}/bin/check.mjs"', HOME, CWD)).toBe(`${HOME}/bin/check.mjs`)
    expect(scriptPath('$CLAUDE_PROJECT_DIR/.claude/hooks/lint.sh', HOME, CWD)).toBe(`${CWD}/.claude/hooks/lint.sh`)
    expect(scriptPath('"${CLAUDE_PROJECT_DIR}/.claude/hooks/lint.sh" || true', HOME, CWD)).toBe(`${CWD}/.claude/hooks/lint.sh`)
    expect(scriptPath('X=1 /usr/local/bin/notify.rb; echo ok', HOME, CWD)).toBe('/usr/local/bin/notify.rb')
    expect(scriptPath('say done', HOME, CWD)).toBeNull()
    expect(scriptPath('cat /etc/hosts', HOME, CWD)).toBeNull()
    expect(scriptPath('node scripts/relative.js', HOME, CWD)).toBeNull()
    expect(scriptPath('', HOME, CWD)).toBeNull()
  })

  test('scriptPath: the quoted "$CLAUDE_PROJECT_DIR"/… form names a file in the project', () => {
    // the spelling Claude Code's own hook examples use
    expect(scriptPath('"$CLAUDE_PROJECT_DIR"/.claude/hooks/check-style.sh', HOME, CWD)).toBe(`${CWD}/.claude/hooks/check-style.sh`)
  })
})

// ---------- a world beneath the plugin ----------

function index(): unknown {
  return {
    version: 2,
    generatedAtMs: 1_760_000_000_000,
    elapsedMs: 1200,
    claudeDir: CD,
    home: HOME,
    warnings: [],
    globalClaudeMd: { path: `${CD}/CLAUDE.md`, exists: false, lines: 0, bytes: 0 },
    projects: [],
    customMemory: [],
    sessions: [],
    skills: [],
    health: [],
  }
}

// a Windows session, as the engine spells it there
const WIN_HOME = 'C:\\Users\\t'
const WIN_CWD = 'E:\\work\\proj'

type WorldOptions = {
  files?: Record<string, string>
  store?: Record<string, unknown>
  /** What the engine composes; SECTIONS when not given. */
  sections?: readonly Section[]
  /**
   * The engine at prompt.compose asks prompt.section for each section (on this
   * `$`, the test's own), as a session's assembly does, so the list it answers
   * already shows what the hooks did to each section.
   */
  askSections?: Engine
  /** Files that are there but whose read is refused. */
  unreadable?: readonly string[]
  /** The engine's answer to `$.ui.open`; placed when not given. */
  open?: { isPlaced: false; reason: string }
  /** A Windows session: USERPROFILE and OS in the environment, the project on another drive, backslashes from the engine. */
  win?: boolean
  /** What `$.fs.list` answers for a folder: its entries' names (all taken for folders). */
  listed?: Record<string, string[]>
}

type World = {
  /** The last value the plugin wrote under each of its state keys. */
  state: Record<string, unknown>
  switches: () => AtlasSwitches | undefined
  /** Every `$.ui.close` the plugin made. */
  closed: unknown[]
  /** Every command line the plugin ran. */
  runs: string[][]
  store: Map<string, unknown>
  fs: Map<string, string>
  reads: string[]
  writes: { path: string; text: string }[]
  toasts: string[]
  clock: MockClock
  /** How often the engine was asked to compose the prompt. */
  composes: () => number
  /** What the plugin asked the engine to drop its cached answers for, in order. */
  invalidated: string[]
  /** Set to refuse every `$.store.set` / `$.store.get` from then on. */
  flags: { storeFails: boolean; storeReadFails: boolean }
}

const ok = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

function world(on: On, opts: WorldOptions = {}): World {
  const fs = new Map(Object.entries(opts.files ?? {}))
  const store = new Map<string, unknown>(Object.entries(clone(opts.store ?? {})))
  const reads: string[] = []
  const writes: { path: string; text: string }[] = []
  const toasts: string[] = []
  const state: Record<string, unknown> = {}
  const flags = { storeFails: false, storeReadFails: false }
  const invalidated: string[] = []
  let composes = 0
  const isDir = (p: string) => [...fs.keys()].some(k => k.startsWith(p.replace(/\/$/, '') + '/'))
  on('state.set', ($, e, next) => {
    if (e.plugin === 'atlas') state[e.key] = e.value
    return next(e)
  })
  const clock = mock.clock(on, { now: 1_760_000_200_000 })
  mock.env(on, opts.win ? { USERPROFILE: WIN_HOME, OS: 'Windows_NT' } : { HOME })
  // $.store, kept here so a test can read what was stored (JSON, as the engine keeps it)
  on('store.get', ($, e) => {
    if (flags.storeReadFails) return { deny: 'the store could not be read' }
    return { value: store.has(e.key) ? clone(store.get(e.key)) : undefined }
  })
  on('store.set', ($, e) => {
    if (flags.storeFails) return { deny: 'the store is over 4 MiB' }
    store.set(e.key, clone(e.value))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.root', () => ({ value: opts.win ? WIN_CWD : CWD }))
  on('session.id', () => ({ value: 'current-session' }))
  on('session.cwd', () => ({ value: opts.win ? WIN_CWD : CWD }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  const closed: unknown[] = []
  const runs: string[][] = []
  on('ui.open', () => ({ value: opts.open ?? { isPlaced: true as const } }))
  on('ui.close', (_, e) => {
    closed.push(e)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', () => ({ value: { isCopied: true as const } }))
  on('ui.focus', () => ({}))
  on('ui.message', () => ({}))
  // a redraw is the kit's to answer; a cached-answer event is the engine's, noted here
  on('ui.invalidate', ($, e, next) => {
    if (e.event === 'ui.render') return next(e)
    invalidated.push(e.event)
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    const isPython = argv[0] === '/usr/bin/python3' || argv[0] === 'python'
    if (argv[0] === '/bin/date') return { value: ok('+0800\n') }
    if (isPython && argv[3] === 'index') return { value: ok(JSON.stringify(index())) }
    if (isPython && argv[3] === 'purge') return { value: ok(JSON.stringify({ purged: [], keptCount: 0, freedBytes: 0, dryRun: false, refused: [] })) }
    if (isPython && (argv[3] === 'reveal' || argv[3] === 'open' || argv[3] === 'move' || argv[3] === 'os-trash')) return { value: ok(JSON.stringify({ ok: true })) }
    return { value: ok('') }
  })
  // On this Mac the engine takes a drive path for a relative one and puts its own folder in front
  // before a path reaches these hooks. On Windows it would arrive as written: read it that way.
  const at = (path: string) => (opts.win ? path.replace(/^.*?(?=[A-Za-z]:\/)/, '') : path)
  on('fs.read', ($, e) => {
    const path = at(e.path)
    reads.push(path)
    if (opts.unreadable?.includes(path)) return { deny: `EACCES: permission denied, open '${path}'` }
    return fs.has(path) ? { value: fs.get(path) ?? '' } : { deny: `ENOENT ${path}` }
  })
  on('fs.write', ($, e) => {
    writes.push({ path: at(e.path), text: e.text })
    fs.set(at(e.path), e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: fs.has(at(e.path)) || isDir(at(e.path)) }))
  on('fs.stat', ($, e) => {
    const path = at(e.path)
    if (fs.has(path)) return { value: { kind: 'file' as const, size: (fs.get(path) ?? '').length, mtimeMs: 1_760_000_000_000, isLink: false, realPath: path } }
    if (isDir(path)) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false, realPath: path } }
    return { deny: `ENOENT ${path}` }
  })
  on('fs.list', ($, e) => ({ value: (opts.listed?.[at(e.path).replace(/\/$/, '')] ?? []).map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }))
  on('tool.call', () => ({ result: 'ran' }))
  // the engine's own answers: a section's text as core computed it, the prompt as composed
  on('prompt.section', ($, e) => ({ text: e.text }))
  on('prompt.compose', async () => {
    composes++
    const core = opts.sections ?? SECTIONS
    if (!opts.askSections) return { sections: core }
    const sections: Section[] = []
    for (const s of core) {
      const answer = await opts.askSections.prompt.section({ name: s.id, text: s.text })
      if (answer.text !== null) sections.push({ ...s, text: answer.text })
    }
    return { sections }
  })
  return { state, switches: () => state.switches as AtlasSwitches | undefined, closed, runs, store, fs, reads, writes, toasts, clock, composes: () => composes, invalidated, flags }
}

async function start($: Engine, w: World, cwd: string = CWD): Promise<void> {
  await $.session.start({ cwd, surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'atlas', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(r.text).toContain('已打开')
  await w.clock.settle()
}

const PANE_PROPS = {
  title: 'Atlas',
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

type Ui = Awaited<ReturnType<typeof mountPane>>

/** One test per surface, each with a fresh plugin and world. */
function both(name: string, body: ($: Engine, on: On, surface: Surface) => Promise<void>, timeoutMs = 15_000): void {
  for (const surface of SURFACES) test(`${name} (${surface})`, { timeoutMs }, ($, on) => body($, on, surface))
}

/** The keys of the Buttons drawn whose key starts with `prefix`, in order. */
/** Which of a few choices is taken: the highlighted button on the desktop, the Select's value in the terminal. */
async function chosen(ui: Ui, surface: Surface, key: string): Promise<string | undefined> {
  if (surface !== 'desktop') return (await value(ui, key)) as string | undefined
  for (const v of ['session', 'project', 'global', 'later', 'now', 'auto', 'pin', 'defer', 'off']) {
    const button = await ui.find({ key: `${key}:${v}` })
    if (button?.props.variant === 'primary') return v
  }
  return undefined
}

/** Picks one of a few choices: a button per choice on the desktop, a Select in the terminal. */
async function pick(ui: Ui, surface: Surface, key: string, value: string): Promise<void> {
  if (surface === 'desktop') await ui.press({ key: `${key}:${value}` })
  else await ui.select({ key, value })
}

async function buttonKeys(ui: Ui, prefix: string): Promise<string[]> {
  return (await ui.findAll({ type: 'Button' })).map(b => b.key ?? '').filter(k => k.startsWith(prefix))
}

async function value(ui: Ui, key: string): Promise<unknown> {
  return (await ui.find({ key }))?.props.value
}

async function label(ui: Ui, key: string): Promise<unknown> {
  return (await ui.find({ key }))?.props.label
}

/** The system prompt as the engine composes it, through every plugin's hook. */
async function compose($: Engine): Promise<readonly { id: string; text: string; scope: string }[]> {
  const out = await $.prompt.compose({ model: 'claude-test', promptModel: 'claude-test', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  return out.sections
}

type StoredPrefs = { prompt?: { global?: AtlasPromptEdits; byProject?: Record<string, AtlasPromptEdits> }; hooksOff?: AtlasParkedHook[] }

/** The default prompt edits as `$.store` holds them under `prefs`. */
function storedPrompt(w: World): { global: AtlasPromptEdits; byProject: Record<string, AtlasPromptEdits> } {
  const p = (w.store.get('prefs') as StoredPrefs | undefined)?.prompt
  return { global: p?.global ?? NONE, byProject: p?.byProject ?? {} }
}

/** The parked hooks as `$.store` holds them under `prefs.hooksOff`. */
function parked(w: World): AtlasParkedHook[] {
  return (w.store.get('prefs') as StoredPrefs | undefined)?.hooksOff ?? []
}

async function openPrompt($: Engine, on: On, surface: Surface, opts: WorldOptions = {}): Promise<{ w: World; ui: Ui }> {
  const w = world(on, opts)
  await start($, w)
  const ui = await mountPane($, surface)
  await ui.press({ key: 'tab:prompt' })
  return { w, ui }
}

function hookFiles(): Record<string, string> {
  return { [USER_SETTINGS]: USER_TEXT, [PROJECT_SETTINGS]: PROJECT_TEXT }
}

async function openHooks($: Engine, on: On, surface: Surface, opts: WorldOptions = {}): Promise<{ w: World; ui: Ui }> {
  const w = world(on, { files: hookFiles(), ...opts })
  await start($, w)
  const ui = await mountPane($, surface)
  await ui.press({ key: 'tab:hooks' })
  return { w, ui }
}

// ---------- 提示词: the page ----------

both('提示词: opening the tab composes the prompt and lists every section; a row opens its page', async ($, on, surface) => {
  const w = world(on)
  await start($, w)
  const ui = await mountPane($, surface)
  const before = w.composes()
  await ui.press({ key: 'tab:prompt' })
  expect(w.composes()).toBeGreaterThan(before)
  expect(await buttonKeys(ui, 'sec:')).toEqual(['sec:intro', 'sec:tone', 'sec:env_info_simple'])
  expect(await chosen(ui, surface, 'scope:prompt')).toBe('session')
  expect(await chosen(ui, surface, 'p-now')).toBe('later')
  await ui.press({ key: 'sec:tone' })
  expect(await ui.find({ key: 's-toggle' })).toBeDefined()
  expect(await ui.find({ key: 's-rewrite' })).toBeDefined()
  expect(await ui.find({ key: 's-restore' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: TONE })).toBeDefined()
  await ui.press({ key: 'back' })
  expect(await buttonKeys(ui, 'sec:')).toEqual(['sec:intro', 'sec:tone', 'sec:env_info_simple'])
  // looking changed nothing
  expect(w.switches()?.prompt).toEqual(NONE)
  expect(storedPrompt(w)).toEqual({ global: NONE, byProject: {} })
  expect(await compose($)).toEqual(SECTIONS)
  await ui.unmount()
})

both('提示词: s-toggle switches a section off for this session, and on again', async ($, on, surface) => {
  const { w, ui } = await openPrompt($, on, surface)
  await ui.press({ key: 'sec:tone' })
  const asked = w.invalidated.length
  await ui.press({ key: 's-toggle' })
  expect(w.switches()?.prompt).toEqual({ off: ['tone'], rewrite: {}, extra: [] })
  // the engine caches a section's answer: it is told to ask again
  expect(w.invalidated.slice(asked)).toContain('prompt.section')
  expect(await $.prompt.section({ name: 'tone', text: TONE })).toEqual({ text: null })
  expect(await $.prompt.section({ name: 'intro', text: INTRO })).toEqual({ text: INTRO })
  expect(await compose($)).toEqual([SECTIONS[0], SECTIONS[2]])
  // a session edit is no default: nothing went to the store
  expect(storedPrompt(w)).toEqual({ global: NONE, byProject: {} })
  // the section stays on the list, marked, so it can be switched on again
  await ui.press({ key: 'back' })
  expect(await buttonKeys(ui, 'sec:')).toContain('sec:tone')
  expect(await ui.find({ type: 'Text', text: /已关闭/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /共发出 32 字符/ })).toBeDefined()
  await ui.press({ key: 'sec:tone' })
  await ui.press({ key: 's-toggle' })
  expect(w.switches()?.prompt).toEqual(NONE)
  expect(await $.prompt.section({ name: 'tone', text: TONE })).toEqual({ text: TONE })
  expect(await compose($)).toEqual(SECTIONS)
  await ui.unmount()
})

both('提示词: s-rewrite starts from the original, s-rw saves the new text, s-restore takes it back', async ($, on, surface) => {
  const { w, ui } = await openPrompt($, on, surface)
  await ui.press({ key: 'sec:tone' })
  await ui.press({ key: 's-rewrite' })
  expect(w.switches()?.prompt).toEqual({ off: [], rewrite: { tone: TONE }, extra: [] })
  expect(await value(ui, 's-rw')).toBe(TONE)
  const mine = 'Be terse.\nNo emoji.'
  const asked = w.invalidated.length
  await ui.input({ key: 's-rw', text: mine })
  expect(w.switches()?.prompt).toEqual({ off: [], rewrite: { tone: mine }, extra: [] })
  expect(w.invalidated.slice(asked)).toContain('prompt.section')
  expect(await value(ui, 's-rw')).toBe(mine)
  expect(await $.prompt.section({ name: 'tone', text: TONE })).toEqual({ text: mine })
  expect(await $.prompt.section({ name: 'intro', text: INTRO })).toEqual({ text: INTRO })
  expect(await compose($)).toEqual([SECTIONS[0], { id: 'tone', text: mine, scope: 'shared' }, SECTIONS[2]])
  // the engine's own text is still what the page calls the original
  expect(await ui.find({ type: 'Text', text: TONE })).toBeDefined()
  expect(await ui.find({ key: 's-rewrite' })).toBeUndefined()
  expect(storedPrompt(w)).toEqual({ global: NONE, byProject: {} })
  await ui.press({ key: 's-restore' })
  expect(w.switches()?.prompt).toEqual(NONE)
  expect(await ui.find({ key: 's-rw' })).toBeUndefined()
  expect(await $.prompt.section({ name: 'tone', text: TONE })).toEqual({ text: TONE })
  expect(await compose($)).toEqual(SECTIONS)
  // a second rewrite starts from the engine's text again, not from the old rewrite
  await ui.press({ key: 's-rewrite' })
  expect(await value(ui, 's-rw')).toBe(TONE)
  await ui.unmount()
})

both('提示词: with an engine that composes from prompt.section, an off section stays listed and a rewritten one keeps its original', async ($, on, surface) => {
  const { w, ui } = await openPrompt($, on, surface, { askSections: $ })
  expect(await buttonKeys(ui, 'sec:')).toEqual(['sec:intro', 'sec:tone', 'sec:env_info_simple'])
  await ui.press({ key: 'sec:tone' })
  await ui.press({ key: 's-toggle' })
  expect(await compose($)).toEqual([SECTIONS[0], SECTIONS[2]])
  // the engine no longer composes it; the page still has it, with its text
  expect(await label(ui, 's-toggle')).toBe('重新开启')
  expect(await ui.find({ type: 'Text', text: TONE })).toBeDefined()
  await ui.press({ key: 'back' })
  await ui.press({ key: 'p-reload' })
  expect((await buttonKeys(ui, 'sec:')).sort()).toEqual(['sec:env_info_simple', 'sec:intro', 'sec:tone'])
  await ui.press({ key: 'sec:tone' })
  await ui.press({ key: 's-toggle' })
  expect(w.switches()?.prompt).toEqual(NONE)
  expect(await compose($)).toEqual(SECTIONS)
  // rewritten: the engine now composes the rewrite, the page keeps the engine's own text as the original
  await ui.press({ key: 's-rewrite' })
  expect(await value(ui, 's-rw')).toBe(TONE)
  await ui.input({ key: 's-rw', text: 'Be terse.' })
  expect(await compose($)).toEqual([SECTIONS[0], { id: 'tone', text: 'Be terse.', scope: 'shared' }, SECTIONS[2]])
  await ui.press({ key: 'back' })
  await ui.press({ key: 'p-reload' })
  await ui.press({ key: 'sec:tone' })
  expect(await value(ui, 's-rw')).toBe('Be terse.')
  expect(await ui.find({ type: 'Text', text: TONE })).toBeDefined()
  await ui.press({ key: 's-restore' })
  expect(await compose($)).toEqual(SECTIONS)
  await ui.press({ key: 's-rewrite' })
  expect(await value(ui, 's-rw')).toBe(TONE)
  await ui.unmount()
})

both('提示词: an own section is made, written, switched, renamed and deleted', async ($, on, surface) => {
  const { w, ui } = await openPrompt($, on, surface)
  // a name of spaces makes nothing
  await ui.input({ key: 'px-new', text: '   ' })
  expect(w.switches()?.prompt).toEqual(NONE)
  await ui.input({ key: 'px-new', text: '  Speak Style ' })
  const id = 'atlas:speak-style'
  expect(w.switches()?.prompt?.extra).toEqual([{ id, name: 'Speak Style', text: '', off: false }])
  // it opened the new section; with no text yet nothing is sent
  expect(await value(ui, 'px-text')).toBe('')
  expect(await compose($)).toEqual(SECTIONS)
  await ui.input({ key: 'px-text', text: 'Answer in haiku.' })
  expect(w.switches()?.prompt?.extra).toEqual([{ id, name: 'Speak Style', text: 'Answer in haiku.', off: false }])
  expect(await compose($)).toEqual([...SECTIONS, { id, text: 'Answer in haiku.', scope: 'session' }])
  // on the list, and reachable from it
  await ui.press({ key: 'back' })
  expect(await buttonKeys(ui, 'sec:')).toEqual(['sec:intro', 'sec:tone', 'sec:env_info_simple', `sec:${id}`])
  await ui.press({ key: `sec:${id}` })
  expect(await value(ui, 'px-text')).toBe('Answer in haiku.')
  await ui.press({ key: 'px-toggle' })
  expect(w.switches()?.prompt?.extra).toEqual([{ id, name: 'Speak Style', text: 'Answer in haiku.', off: true }])
  expect(await compose($)).toEqual(SECTIONS)
  await ui.press({ key: 'px-toggle' })
  expect(w.switches()?.prompt?.extra).toEqual([{ id, name: 'Speak Style', text: 'Answer in haiku.', off: false }])
  expect(await compose($)).toEqual([...SECTIONS, { id, text: 'Answer in haiku.', scope: 'session' }])
  await ui.input({ key: 'px-rename', text: 'Voice' })
  expect(w.switches()?.prompt?.extra).toEqual([{ id, name: 'Voice', text: 'Answer in haiku.', off: false }])
  // an engine section's hooks are not touched by any of this
  expect(await $.prompt.section({ name: 'tone', text: TONE })).toEqual({ text: TONE })
  expect(storedPrompt(w)).toEqual({ global: NONE, byProject: {} })
  // delete: the first press only asks
  await ui.press({ key: 'px-del' })
  expect(w.switches()?.prompt?.extra).toHaveLength(1)
  expect(await ui.find({ key: 'px-delok' })).toBeDefined()
  await ui.press({ key: 'px-delok' })
  expect(w.switches()?.prompt).toEqual(NONE)
  expect(await compose($)).toEqual(SECTIONS)
  expect(await buttonKeys(ui, 'sec:')).toEqual(['sec:intro', 'sec:tone', 'sec:env_info_simple'])
  expect(await ui.find({ key: 'px-new' })).toBeDefined()
  await ui.unmount()
})

both('提示词: two own sections of one name get two ids, sent in the order made', async ($, on, surface) => {
  const { w, ui } = await openPrompt($, on, surface)
  await ui.input({ key: 'px-new', text: 'Notes' })
  await ui.input({ key: 'px-text', text: 'first' })
  await ui.press({ key: 'back' })
  await ui.input({ key: 'px-new', text: 'notes' })
  await ui.input({ key: 'px-text', text: 'second' })
  expect(w.switches()?.prompt?.extra).toEqual([
    { id: 'atlas:notes', name: 'Notes', text: 'first', off: false },
    { id: 'atlas:notes-2', name: 'notes', text: 'second', off: false },
  ])
  expect(await compose($)).toEqual([...SECTIONS, { id: 'atlas:notes', text: 'first', scope: 'session' }, { id: 'atlas:notes-2', text: 'second', scope: 'session' }])
  await ui.unmount()
})

both('提示词: at 全局默认 / 本项目默认 an edit goes to the store and this session does not change', async ($, on, surface) => {
  const { w, ui } = await openPrompt($, on, surface)
  await pick(ui, surface, 'scope:prompt', 'global')
  await ui.press({ key: 'sec:tone' })
  expect(await chosen(ui, surface, 'scope:section')).toBe('global')
  await ui.press({ key: 's-toggle' })
  expect(storedPrompt(w)).toEqual({ global: { off: ['tone'], rewrite: {}, extra: [] }, byProject: {} })
  expect(await label(ui, 's-toggle')).toBe('重新开启')
  // the project's default, chosen on the section page itself
  await pick(ui, surface, 'scope:section', 'project')
  await ui.press({ key: 's-rewrite' })
  await ui.input({ key: 's-rw', text: 'Project tone.' })
  expect(storedPrompt(w)).toEqual({
    global: { off: ['tone'], rewrite: {}, extra: [] },
    byProject: { [CWD]: { off: [], rewrite: { tone: 'Project tone.' }, extra: [] } },
  })
  // an own section at the project's level
  await ui.press({ key: 'back' })
  expect(await chosen(ui, surface, 'scope:prompt')).toBe('project')
  await ui.input({ key: 'px-new', text: 'House rules' })
  await ui.input({ key: 'px-text', text: 'Tabs, not spaces.' })
  expect(storedPrompt(w).byProject).toEqual({
    [CWD]: { off: [], rewrite: { tone: 'Project tone.' }, extra: [{ id: 'atlas:house-rules', name: 'House rules', text: 'Tabs, not spaces.', off: false }] },
  })
  await ui.press({ key: 'px-toggle' })
  expect(storedPrompt(w).byProject[CWD]?.extra).toEqual([{ id: 'atlas:house-rules', name: 'House rules', text: 'Tabs, not spaces.', off: true }])
  await ui.press({ key: 'px-del' })
  await ui.press({ key: 'px-delok' })
  expect(storedPrompt(w).byProject[CWD]?.extra).toEqual([])
  expect(storedPrompt(w).global).toEqual({ off: ['tone'], rewrite: {}, extra: [] })
  // through all of it: this session's switches and its hooks are as they were
  expect(w.switches()?.prompt).toEqual(NONE)
  expect(await $.prompt.section({ name: 'tone', text: TONE })).toEqual({ text: TONE })
  expect(await compose($)).toEqual(SECTIONS)
  // and back at 本会话 the same press writes the session, not the store
  await pick(ui, surface, 'scope:prompt', 'session')
  await ui.press({ key: 'sec:intro' })
  await ui.press({ key: 's-toggle' })
  expect(w.switches()?.prompt).toEqual({ off: ['intro'], rewrite: {}, extra: [] })
  expect(storedPrompt(w).global).toEqual({ off: ['tone'], rewrite: {}, extra: [] })
  expect(await $.prompt.section({ name: 'intro', text: INTRO })).toEqual({ text: null })
  await ui.unmount()
})

const DEFAULTS = {
  prefs: {
    prompt: {
      global: {
        off: ['tone'],
        rewrite: { intro: 'Global intro.', env_info_simple: 'Global env.', output_style: 'Rewritten style.' },
        extra: [extra('atlas:a', 'global a', false, 'A'), extra('atlas:g', 'global g', false, 'G'), extra('atlas:quiet', 'off by default', true, 'Quiet')],
      },
      byProject: {
        [CWD]: { off: ['pronouns'], rewrite: { intro: 'Project intro.' }, extra: [extra('atlas:p', 'project p', false, 'P'), extra('atlas:a', 'project a', false, 'A')] },
        '/work/other': { off: ['intro'], rewrite: { tone: 'another project' }, extra: [extra('atlas:o', 'other', false, 'O')] },
      },
    },
  },
}

test('提示词: session.start seeds the session from the global default merged with the project\'s, and the hooks enforce it', async ($, on) => {
  const w = world(on, { store: DEFAULTS })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  expect(w.switches()?.prompt).toEqual({
    off: ['tone', 'pronouns'],
    rewrite: { intro: 'Project intro.', env_info_simple: 'Global env.', output_style: 'Rewritten style.' },
    extra: [extra('atlas:p', 'project p', false, 'P'), extra('atlas:a', 'project a', false, 'A'), extra('atlas:g', 'global g', false, 'G'), extra('atlas:quiet', 'off by default', true, 'Quiet')],
  })
  expect(w.switches()?.promptNow).toBe(false)
  // no pane was opened: the hooks alone
  expect(await $.prompt.section({ name: 'tone', text: TONE })).toEqual({ text: null })
  expect(await $.prompt.section({ name: 'pronouns', text: 'they' })).toEqual({ text: null })
  expect(await $.prompt.section({ name: 'intro', text: INTRO })).toEqual({ text: 'Project intro.' })
  expect(await $.prompt.section({ name: 'env_info_simple', text: ENV })).toEqual({ text: 'Global env.' })
  expect(await $.prompt.section({ name: 'doing_tasks', text: 'core text' })).toEqual({ text: 'core text' })
  // a rewrite never brings in a section core leaves out
  expect(await $.prompt.section({ name: 'output_style', text: null })).toEqual({ text: null })
  expect(await $.prompt.section({ name: 'output_style', text: 'core style' })).toEqual({ text: 'Rewritten style.' })
  expect(await compose($)).toEqual([
    { id: 'intro', text: 'Project intro.', scope: 'shared' },
    { id: 'env_info_simple', text: 'Global env.', scope: 'session' },
    { id: 'atlas:p', text: 'project p', scope: 'session' },
    { id: 'atlas:a', text: 'project a', scope: 'session' },
    { id: 'atlas:g', text: 'global g', scope: 'session' },
  ])
  // seeding wrote no default back
  expect(w.store.get('prefs')).toEqual(DEFAULTS.prefs)
})

test('提示词: with no edits the hooks hand back exactly what the engine gave', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  expect(w.switches()?.prompt).toEqual(NONE)
  expect(await $.prompt.section({ name: 'tone', text: TONE })).toEqual({ text: TONE })
  expect(await $.prompt.section({ name: 'left_out', text: null })).toEqual({ text: null })
  expect(await compose($)).toEqual(SECTIONS)
  const bare = await $.prompt.compose({ model: 'claude-test', promptModel: 'claude-test', surfaces: [], tools: [], outputStyle: null, traits: ['bare'] })
  expect(bare.sections).toEqual(SECTIONS)
})

test('提示词: the hooks pass the engine\'s answer through when the switches cannot be read', async ($, on) => {
  world(on, { store: DEFAULTS })
  on('state.get', { plugin: 'atlas', key: 'switches' }, () => ({ deny: 'state unavailable' }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  expect(await $.prompt.section({ name: 'tone', text: TONE })).toEqual({ text: TONE })
  expect(await compose($)).toEqual(SECTIONS)
})

both('提示词: with 生效 at 下一轮 every prompt.section answer carries breakPromptCache', async ($, on, surface) => {
  const { w, ui } = await openPrompt($, on, surface, { store: DEFAULTS })
  // the default: a changed section waits for a new thread
  expect(await $.prompt.section({ name: 'tone', text: TONE })).toEqual({ text: null })
  expect(await $.prompt.section({ name: 'intro', text: INTRO })).toEqual({ text: 'Project intro.' })
  expect(await $.prompt.section({ name: 'doing_tasks', text: 'core text' })).toEqual({ text: 'core text' })
  const asked = w.invalidated.length
  await pick(ui, surface, 'p-now', 'now')
  expect(w.switches()?.promptNow).toBe(true)
  expect(await chosen(ui, surface, 'p-now')).toBe('now')
  expect(w.invalidated.slice(asked)).toContain('prompt.section')
  expect(await $.prompt.section({ name: 'tone', text: TONE })).toEqual({ text: null, breakPromptCache: true })
  expect(await $.prompt.section({ name: 'intro', text: INTRO })).toEqual({ text: 'Project intro.', breakPromptCache: true })
  expect(await $.prompt.section({ name: 'doing_tasks', text: 'core text' })).toEqual({ text: 'core text', breakPromptCache: true })
  expect(await $.prompt.section({ name: 'output_style', text: null })).toEqual({ text: null, breakPromptCache: true })
  // the edits themselves are untouched by the Select
  expect(w.switches()?.prompt?.off).toEqual(['tone', 'pronouns'])
  await pick(ui, surface, 'p-now', 'later')
  expect(w.switches()?.promptNow).toBe(false)
  expect(await $.prompt.section({ name: 'tone', text: TONE })).toEqual({ text: null })
  expect(await $.prompt.section({ name: 'doing_tasks', text: 'core text' })).toEqual({ text: 'core text' })
  await ui.unmount()
})

both('提示词: 下一轮 marks the memory section too', async ($, on, surface) => {
  const { ui } = await openPrompt($, on, surface)
  expect(await $.prompt.section({ name: 'memory', text: 'memory rules' })).toEqual({ text: 'memory rules' })
  await pick(ui, surface, 'p-now', 'now')
  expect(await $.prompt.section({ name: 'memory', text: 'memory rules' })).toEqual({ text: 'memory rules', breakPromptCache: true })
  await ui.unmount()
})

both('提示词: 下一轮 marks the memory section also when the 记忆 board has switched this project\'s memory off', async ($, on, surface) => {
  // this session's own memory group, off by a stored default (the 记忆 board's switch)
  const memoryOff = { skillsOff: { global: [], byProject: {} }, skillDirs: {}, groups: [], memory: { defaults: { global: { 'project:-work-proj': 'off' }, byProject: {} } } }
  const { w, ui } = await openPrompt($, on, surface, { store: { prefs: memoryOff } })
  expect(w.switches()?.memory).toEqual({ 'project:-work-proj': 'off' })
  expect(await $.prompt.section({ name: 'memory', text: 'memory rules' })).toEqual({ text: null })
  await pick(ui, surface, 'p-now', 'now')
  expect(await $.prompt.section({ name: 'tone', text: TONE })).toEqual({ text: TONE, breakPromptCache: true })
  expect(await $.prompt.section({ name: 'memory', text: 'memory rules' })).toEqual({ text: null, breakPromptCache: true })
  await ui.unmount()
})

// ---------- Hooks: the page ----------

both('Hooks: the tab reads the three settings files through $.fs.read and lists every hook', async ($, on, surface) => {
  const w = world(on, { files: hookFiles() })
  await start($, w)
  const ui = await mountPane($, surface)
  const before = w.reads.length
  await ui.press({ key: 'tab:hooks' })
  const read = w.reads.slice(before)
  for (const path of [USER_SETTINGS, PROJECT_SETTINGS, LOCAL_SETTINGS]) expect(read).toContain(path)
  expect(await buttonKeys(ui, 'hook:')).toEqual([
    'hook:user:PreToolUse:0:0',
    'hook:user:PreToolUse:0:1',
    'hook:user:PreToolUse:1:0',
    'hook:user:Stop:0:0',
    'hook:project:UserPromptSubmit:0:0',
  ])
  expect(await label(ui, 'hook:user:PreToolUse:1:0')).toBe('PreToolUse（Edit|Write）')
  expect(await label(ui, 'hook:user:Stop:0:0')).toBe('Stop')
  await ui.press({ key: 'hook:user:PreToolUse:0:0' })
  expect(await label(ui, 'hk-toggle')).toBe('关闭')
  expect(await value(ui, 'hk-matcher')).toBe('Bash')
  expect(await value(ui, 'hk-body')).toBe('bash ~/.claude/hooks/guard.sh')
  expect(await value(ui, 'hk-timeout')).toBe('5')
  await ui.press({ key: 'back' })
  await ui.press({ key: 'hook:project:UserPromptSubmit:0:0' })
  expect(await value(ui, 'hk-matcher')).toBe('')
  expect(await value(ui, 'hk-body')).toBe('echo prompt')
  expect(await value(ui, 'hk-timeout')).toBe('')
  // looking wrote nothing, anywhere
  expect(w.writes).toEqual([])
  expect(w.store.get('prefs')).toBeUndefined()
  // 重新读取 shows what the files hold now
  await ui.press({ key: 'back' })
  w.fs.set(LOCAL_SETTINGS, pretty({ hooks: { Stop: [{ hooks: [DONE] }] } }))
  w.fs.delete(PROJECT_SETTINGS)
  await ui.press({ key: 'h-reload' })
  expect(await buttonKeys(ui, 'hook:')).toEqual(['hook:user:PreToolUse:0:0', 'hook:user:PreToolUse:0:1', 'hook:user:PreToolUse:1:0', 'hook:user:Stop:0:0', 'hook:local:Stop:0:0'])
  expect(w.writes).toEqual([])
  await ui.unmount()
})

both('Hooks: hk-toggle parks an enabled hook, then puts it back in the same file, event and matcher group', async ($, on, surface) => {
  const { w, ui } = await openHooks($, on, surface)
  await ui.press({ key: 'hook:user:PreToolUse:0:0' })
  await ui.press({ key: 'hk-toggle' })
  // out of its file; the rest of the group, and of the file, as it was
  expect(w.fs.get(USER_SETTINGS)).toBe(userText(d => group(d, 'PreToolUse', 0).hooks.splice(0, 1)))
  expect(w.fs.get(PROJECT_SETTINGS)).toBe(PROJECT_TEXT)
  expect(w.writes.map(x => x.path)).toEqual([USER_SETTINGS])
  // kept in the store
  const kept = parked(w)
  expect(kept).toEqual([{ id: expect.stringMatching(/^off:/), file: USER_SETTINGS, event: 'PreToolUse', matcher: 'Bash', json: JSON.stringify(GUARD) }])
  const id = kept[0]?.id ?? ''
  // the page follows it: shown as off, with nothing to edit
  expect(await label(ui, 'hk-toggle')).toBe('开启')
  expect(await ui.find({ type: 'Text', text: 'bash ~/.claude/hooks/guard.sh' })).toBeDefined()
  for (const key of ['hk-matcher', 'hk-body', 'hk-timeout']) expect(await ui.find({ key }), key).toBeUndefined()
  await ui.press({ key: 'back' })
  expect(await buttonKeys(ui, 'hook:')).toEqual(['hook:user:PreToolUse:0:0', 'hook:user:PreToolUse:1:0', 'hook:user:Stop:0:0', `hook:${id}`, 'hook:project:UserPromptSubmit:0:0'])
  // back on: into the Bash group of PreToolUse, whole (its timeout too)
  await ui.press({ key: `hook:${id}` })
  await ui.press({ key: 'hk-toggle' })
  expect(w.fs.get(USER_SETTINGS)).toBe(userText(d => (group(d, 'PreToolUse', 0).hooks = [SECOND, GUARD])))
  expect(parked(w)).toEqual([])
  expect(w.fs.get(PROJECT_SETTINGS)).toBe(PROJECT_TEXT)
  // the page follows it back
  expect(await label(ui, 'hk-toggle')).toBe('关闭')
  expect(await value(ui, 'hk-body')).toBe('bash ~/.claude/hooks/guard.sh')
  expect(await value(ui, 'hk-matcher')).toBe('Bash')
  expect(await value(ui, 'hk-timeout')).toBe('5')
  await ui.press({ key: 'back' })
  expect(await buttonKeys(ui, 'hook:')).toEqual([
    'hook:user:PreToolUse:0:0',
    'hook:user:PreToolUse:0:1',
    'hook:user:PreToolUse:1:0',
    'hook:user:Stop:0:0',
    'hook:project:UserPromptSubmit:0:0',
  ])
  await ui.unmount()
})

both('Hooks: parking the last hook of a group removes the group, of an event the event; switching on brings both back', async ($, on, surface) => {
  const { w, ui } = await openHooks($, on, surface)
  await ui.press({ key: 'hook:user:PreToolUse:1:0' })
  await ui.press({ key: 'hk-toggle' })
  expect(w.fs.get(USER_SETTINGS)).toBe(userText(d => d.hooks.PreToolUse?.splice(1, 1)))
  await ui.press({ key: 'back' })
  await ui.press({ key: 'hook:user:Stop:0:0' })
  await ui.press({ key: 'hk-toggle' })
  expect(w.fs.get(USER_SETTINGS)).toBe(
    userText(d => {
      d.hooks.PreToolUse?.splice(1, 1)
      delete d.hooks.Stop
    }),
  )
  const kept = parked(w)
  expect(kept.map(p => [p.event, p.matcher, p.json])).toEqual([
    ['PreToolUse', 'Edit|Write', JSON.stringify(EDIT)],
    ['Stop', '', JSON.stringify(DONE)],
  ])
  expect(new Set(kept.map(p => p.id)).size).toBe(2)
  // Stop first (the page is on it), then the Edit|Write one from the list
  await ui.press({ key: 'hk-toggle' })
  expect(w.fs.get(USER_SETTINGS)).toBe(userText(d => d.hooks.PreToolUse?.splice(1, 1)))
  expect(parked(w).map(p => p.event)).toEqual(['PreToolUse'])
  await ui.press({ key: 'back' })
  await ui.press({ key: `hook:${kept[0]?.id ?? ''}` })
  await ui.press({ key: 'hk-toggle' })
  // each went back under its own event and matcher: the file reads as it did at the start
  expect(w.fs.get(USER_SETTINGS)).toBe(USER_TEXT)
  expect(parked(w)).toEqual([])
  await ui.unmount()
})

both('Hooks: a write keeps every other key and turns out 2-space JSON with a final newline, whatever the file looked like', async ($, on, surface) => {
  // 4 spaces, no final newline
  const original = JSON.stringify(settings(), null, 4)
  const { w, ui } = await openHooks($, on, surface, { files: { [USER_SETTINGS]: original } })
  await ui.press({ key: 'hook:user:Stop:0:0' })
  await ui.press({ key: 'hk-toggle' })
  const after = w.fs.get(USER_SETTINGS) ?? ''
  expect(after).toBe(userText(d => delete d.hooks.Stop))
  const doc = JSON.parse(after) as Record<string, unknown>
  const want: Record<string, unknown> = settings()
  expect(Object.keys(doc)).toEqual(Object.keys(want))
  for (const key of Object.keys(want)) if (key !== 'hooks') expect(doc[key], key).toEqual(want[key])
  // undo puts the person's own text back, byte for byte
  await ui.press({ key: 'back' })
  await ui.press({ key: 'h-undo' })
  expect(w.fs.get(USER_SETTINGS)).toBe(original)
  expect(parked(w)).toEqual([])
  await ui.unmount()
})

both('Hooks: hk-body, hk-timeout and hk-matcher edit an enabled hook in place', async ($, on, surface) => {
  const { w, ui } = await openHooks($, on, surface)
  await ui.press({ key: 'hook:user:PreToolUse:1:0' })
  await ui.input({ key: 'hk-body', text: 'echo edited --now' })
  expect(w.fs.get(USER_SETTINGS)).toBe(userText(d => (group(d, 'PreToolUse', 1).hooks = [{ type: 'command', command: 'echo edited --now', async: true }])))
  expect(w.toasts).toContain('已保存')
  expect(await value(ui, 'hk-body')).toBe('echo edited --now')
  await ui.input({ key: 'hk-timeout', text: '30' })
  expect(w.fs.get(USER_SETTINGS)).toBe(userText(d => (group(d, 'PreToolUse', 1).hooks = [{ type: 'command', command: 'echo edited --now', async: true, timeout: 30 }])))
  expect(await value(ui, 'hk-timeout')).toBe('30')
  await ui.input({ key: 'hk-timeout', text: '' })
  expect(w.fs.get(USER_SETTINGS)).toBe(userText(d => (group(d, 'PreToolUse', 1).hooks = [{ type: 'command', command: 'echo edited --now', async: true }])))
  expect(await value(ui, 'hk-timeout')).toBe('')
  // alone in its group: the group takes the new matcher, the hook stays where it is
  await ui.input({ key: 'hk-matcher', text: ' Write ' })
  expect(w.fs.get(USER_SETTINGS)).toBe(
    userText(d => {
      const g = group(d, 'PreToolUse', 1)
      g.matcher = 'Write'
      g.hooks = [{ type: 'command', command: 'echo edited --now', async: true }]
    }),
  )
  expect(await value(ui, 'hk-matcher')).toBe('Write')
  expect(await value(ui, 'hk-body')).toBe('echo edited --now')
  // nothing was parked, nothing else written
  expect(parked(w)).toEqual([])
  expect(new Set(w.writes.map(x => x.path))).toEqual(new Set([USER_SETTINGS]))
  expect(w.fs.get(PROJECT_SETTINGS)).toBe(PROJECT_TEXT)
  await ui.unmount()
})

both('Hooks: a matcher change on a hook that shares its group moves only that hook', async ($, on, surface) => {
  const { w, ui } = await openHooks($, on, surface)
  await ui.press({ key: 'hook:user:PreToolUse:0:1' })
  expect(await value(ui, 'hk-body')).toBe('echo second')
  // to a matcher another group has
  await ui.input({ key: 'hk-matcher', text: 'Edit|Write' })
  expect(w.fs.get(USER_SETTINGS)).toBe(
    userText(d => {
      group(d, 'PreToolUse', 0).hooks = [GUARD]
      group(d, 'PreToolUse', 1).hooks = [EDIT, SECOND]
    }),
  )
  // the page is still on the hook that moved
  expect(await value(ui, 'hk-body')).toBe('echo second')
  expect(await value(ui, 'hk-matcher')).toBe('Edit|Write')
  // to a matcher of its own
  await ui.input({ key: 'hk-matcher', text: 'Read' })
  expect(w.fs.get(USER_SETTINGS)).toBe(
    userText(d => {
      group(d, 'PreToolUse', 0).hooks = [GUARD]
      d.hooks.PreToolUse?.push({ matcher: 'Read', hooks: [SECOND] })
    }),
  )
  expect(await value(ui, 'hk-body')).toBe('echo second')
  expect(await value(ui, 'hk-matcher')).toBe('Read')
  await ui.press({ key: 'back' })
  expect(await buttonKeys(ui, 'hook:user:PreToolUse')).toEqual(['hook:user:PreToolUse:0:0', 'hook:user:PreToolUse:1:0', 'hook:user:PreToolUse:2:0'])
  await ui.unmount()
})

both('Hooks: a bad timeout and an empty command are refused on the hook page, the file untouched', async ($, on, surface) => {
  const { w, ui } = await openHooks($, on, surface)
  await ui.press({ key: 'hook:user:PreToolUse:0:0' })
  for (const bad of ['abc', '-1', '0']) {
    const toasts = w.toasts.length
    await ui.input({ key: 'hk-timeout', text: bad })
    expect(w.toasts.slice(toasts).join('\n'), bad).toContain('timeout')
    expect(w.toasts.slice(toasts), bad).not.toContain('已保存')
  }
  for (const bad of ['', '   ', '\n']) {
    const toasts = w.toasts.length
    await ui.input({ key: 'hk-body', text: bad })
    expect(w.toasts.slice(toasts).join('\n'), JSON.stringify(bad)).toContain('没有完成')
    expect(w.toasts.slice(toasts), JSON.stringify(bad)).not.toContain('已保存')
  }
  expect(w.writes).toEqual([])
  expect(w.fs.get(USER_SETTINGS)).toBe(USER_TEXT)
  // the page still shows the hook as the file has it
  expect(await value(ui, 'hk-body')).toBe('bash ~/.claude/hooks/guard.sh')
  expect(await value(ui, 'hk-timeout')).toBe('5')
  await ui.unmount()
})

both('Hooks: hk-del then hk-delok deletes an enabled hook; hk-delno backs out', async ($, on, surface) => {
  const { w, ui } = await openHooks($, on, surface)
  await ui.press({ key: 'hook:user:PreToolUse:1:0' })
  await ui.press({ key: 'hk-del' })
  expect(w.writes).toEqual([])
  expect(await ui.find({ key: 'hk-delok' })).toBeDefined()
  await ui.press({ key: 'hk-delno' })
  expect(await ui.find({ key: 'hk-delok' })).toBeUndefined()
  expect(w.writes).toEqual([])
  await ui.press({ key: 'hk-del' })
  await ui.press({ key: 'hk-delok' })
  // its group went with it; nothing was parked
  expect(w.fs.get(USER_SETTINGS)).toBe(userText(d => d.hooks.PreToolUse?.splice(1, 1)))
  expect(parked(w)).toEqual([])
  expect(w.toasts).toContain('已删除')
  // back on the list, without it
  expect(await buttonKeys(ui, 'hook:')).toEqual(['hook:user:PreToolUse:0:0', 'hook:user:PreToolUse:0:1', 'hook:user:Stop:0:0', 'hook:project:UserPromptSubmit:0:0'])
  // the last hook of an event: the event's key goes
  await ui.press({ key: 'hook:project:UserPromptSubmit:0:0' })
  await ui.press({ key: 'hk-del' })
  await ui.press({ key: 'hk-delok' })
  expect(w.fs.get(PROJECT_SETTINGS)).toBe(pretty({ hooks: {} }))
  await ui.unmount()
})

both('Hooks: hk-del then hk-delok deletes a parked hook from the store, the file as it was', async ($, on, surface) => {
  const { w, ui } = await openHooks($, on, surface)
  await ui.press({ key: 'hook:user:Stop:0:0' })
  await ui.press({ key: 'hk-toggle' })
  const parkedText = userText(d => delete d.hooks.Stop)
  expect(w.fs.get(USER_SETTINGS)).toBe(parkedText)
  expect(parked(w)).toHaveLength(1)
  const writes = w.writes.length
  await ui.press({ key: 'hk-del' })
  expect(parked(w)).toHaveLength(1)
  await ui.press({ key: 'hk-delok' })
  expect(parked(w)).toEqual([])
  expect(w.writes.length).toBe(writes)
  expect(w.fs.get(USER_SETTINGS)).toBe(parkedText)
  expect(await buttonKeys(ui, 'hook:off:')).toEqual([])
  await ui.unmount()
})

both('Hooks: h-undo takes back the last write, once: the file text and the parked list', async ($, on, surface) => {
  const { w, ui } = await openHooks($, on, surface)
  expect(await ui.find({ key: 'h-undo' })).toBeUndefined()
  // two writes: Stop parked, then the Edit|Write hook parked
  await ui.press({ key: 'hook:user:Stop:0:0' })
  await ui.press({ key: 'hk-toggle' })
  const afterFirst = userText(d => delete d.hooks.Stop)
  expect(w.fs.get(USER_SETTINGS)).toBe(afterFirst)
  const first = parked(w)
  expect(first).toHaveLength(1)
  await ui.press({ key: 'back' })
  await ui.press({ key: 'hook:user:PreToolUse:1:0' })
  await ui.press({ key: 'hk-toggle' })
  expect(parked(w)).toHaveLength(2)
  await ui.press({ key: 'back' })
  // undo: the last one only
  await ui.press({ key: 'h-undo' })
  expect(w.fs.get(USER_SETTINGS)).toBe(afterFirst)
  expect(parked(w)).toEqual(first)
  expect(w.toasts).toContain('已撤销')
  expect(await ui.find({ key: 'h-undo' })).toBeUndefined()
  expect(await buttonKeys(ui, 'hook:')).toEqual([
    'hook:user:PreToolUse:0:0',
    'hook:user:PreToolUse:0:1',
    'hook:user:PreToolUse:1:0',
    `hook:${first[0]?.id ?? ''}`,
    'hook:project:UserPromptSubmit:0:0',
  ])
  await ui.unmount()
})

both('Hooks: h-undo after switching a parked hook on parks it again; after deleting a parked hook brings it back', async ($, on, surface) => {
  const { w, ui } = await openHooks($, on, surface)
  await ui.press({ key: 'hook:user:Stop:0:0' })
  await ui.press({ key: 'hk-toggle' })
  const parkedText = userText(d => delete d.hooks.Stop)
  const kept = parked(w)
  expect(kept).toHaveLength(1)
  // on again, then undo that
  await ui.press({ key: 'hk-toggle' })
  expect(w.fs.get(USER_SETTINGS)).toBe(USER_TEXT)
  expect(parked(w)).toEqual([])
  await ui.press({ key: 'back' })
  await ui.press({ key: 'h-undo' })
  expect(w.fs.get(USER_SETTINGS)).toBe(parkedText)
  expect(parked(w)).toEqual(kept)
  expect(await ui.find({ key: 'h-undo' })).toBeUndefined()
  // delete the parked hook, then undo that
  await ui.press({ key: `hook:${kept[0]?.id ?? ''}` })
  await ui.press({ key: 'hk-del' })
  await ui.press({ key: 'hk-delok' })
  expect(parked(w)).toEqual([])
  await ui.press({ key: 'h-undo' })
  expect(parked(w)).toEqual(kept)
  expect(w.fs.get(USER_SETTINGS)).toBe(parkedText)
  expect(await ui.find({ key: 'h-undo' })).toBeUndefined()
  await ui.unmount()
})

both('Hooks: h-undo takes back an edit and a delete', async ($, on, surface) => {
  const { w, ui } = await openHooks($, on, surface)
  await ui.press({ key: 'hook:user:PreToolUse:0:0' })
  await ui.input({ key: 'hk-body', text: 'echo changed' })
  expect(w.fs.get(USER_SETTINGS)).not.toBe(USER_TEXT)
  await ui.press({ key: 'back' })
  await ui.press({ key: 'h-undo' })
  expect(w.fs.get(USER_SETTINGS)).toBe(USER_TEXT)
  await ui.press({ key: 'hook:user:PreToolUse:0:0' })
  expect(await value(ui, 'hk-body')).toBe('bash ~/.claude/hooks/guard.sh')
  await ui.press({ key: 'hk-del' })
  await ui.press({ key: 'hk-delok' })
  expect(w.fs.get(USER_SETTINGS)).toBe(userText(d => group(d, 'PreToolUse', 0).hooks.splice(0, 1)))
  await ui.press({ key: 'h-undo' })
  expect(w.fs.get(USER_SETTINGS)).toBe(USER_TEXT)
  expect(parked(w)).toEqual([])
  expect(await ui.find({ key: 'h-undo' })).toBeUndefined()
  await ui.unmount()
})

both('Hooks: + 新 hook writes a hook into the file chosen, making the file when there is none', async ($, on, surface) => {
  const { w, ui } = await openHooks($, on, surface)
  await ui.press({ key: 'hook-new' })
  for (const key of ['hd-file', 'hd-event', 'hd-matcher', 'hd-command', 'hd-timeout', 'hd-add']) expect(await ui.find({ key }), key).toBeDefined()
  await ui.select({ key: 'hd-file', value: LOCAL_SETTINGS })
  await ui.select({ key: 'hd-event', value: 'Notification' })
  await ui.input({ key: 'hd-matcher', text: 'idle_prompt' })
  await ui.input({ key: 'hd-command', text: 'say waiting' })
  await ui.input({ key: 'hd-timeout', text: '10' })
  // filling the form writes nothing
  expect(w.writes).toEqual([])
  await ui.press({ key: 'hd-add' })
  expect(w.fs.get(LOCAL_SETTINGS)).toBe(pretty({ hooks: { Notification: [{ matcher: 'idle_prompt', hooks: [{ type: 'command', command: 'say waiting', timeout: 10 }] }] } }))
  expect(w.fs.get(USER_SETTINGS)).toBe(USER_TEXT)
  expect(w.fs.get(PROJECT_SETTINGS)).toBe(PROJECT_TEXT)
  expect(w.toasts).toContain('已添加')
  // it opened the new hook
  expect(await value(ui, 'hk-body')).toBe('say waiting')
  expect(await value(ui, 'hk-matcher')).toBe('idle_prompt')
  expect(await value(ui, 'hk-timeout')).toBe('10')
  await ui.press({ key: 'back' })
  expect(await buttonKeys(ui, 'hook:local:')).toEqual(['hook:local:Notification:0:0'])
  // undo: no hook is left in the file that was made
  await ui.press({ key: 'h-undo' })
  expect(parseHooks({ source: 'local', path: LOCAL_SETTINGS, text: w.fs.get(LOCAL_SETTINGS) ?? null })).toEqual({ rows: [], error: null })
  expect(await buttonKeys(ui, 'hook:local:')).toEqual([])
  await ui.unmount()
})

both('Hooks: + 新 hook into a file with settings joins the matcher group that is there and keeps every other key', async ($, on, surface) => {
  const { w, ui } = await openHooks($, on, surface)
  await ui.press({ key: 'hook-new' })
  expect(await value(ui, 'hd-file')).toBe(USER_SETTINGS)
  await ui.select({ key: 'hd-event', value: 'PreToolUse' })
  await ui.input({ key: 'hd-matcher', text: ' Bash ' })
  await ui.input({ key: 'hd-command', text: 'echo third' })
  await ui.press({ key: 'hd-add' })
  const third: Hook = { type: 'command', command: 'echo third' }
  expect(w.fs.get(USER_SETTINGS)).toBe(userText(d => group(d, 'PreToolUse', 0).hooks.push(third)))
  expect(await value(ui, 'hk-body')).toBe('echo third')
  await ui.press({ key: 'back' })
  expect(await buttonKeys(ui, 'hook:user:PreToolUse:0:')).toEqual(['hook:user:PreToolUse:0:0', 'hook:user:PreToolUse:0:1', 'hook:user:PreToolUse:0:2'])
  // a second one: a new event, no matcher; the form started empty again
  await ui.press({ key: 'hook-new' })
  expect(await value(ui, 'hd-command')).toBe('')
  expect(await value(ui, 'hd-matcher')).toBe('')
  await ui.select({ key: 'hd-event', value: 'SessionEnd' })
  await ui.input({ key: 'hd-command', text: 'echo bye' })
  await ui.press({ key: 'hd-add' })
  expect(w.fs.get(USER_SETTINGS)).toBe(
    userText(d => {
      group(d, 'PreToolUse', 0).hooks.push(third)
      d.hooks.SessionEnd = [{ hooks: [{ type: 'command', command: 'echo bye' }] }]
    }),
  )
  expect(parked(w)).toEqual([])
  await ui.unmount()
})

both('Hooks: on the 新 hook page an empty command and a bad timeout are refused, nothing written', async ($, on, surface) => {
  const { w, ui } = await openHooks($, on, surface)
  await ui.press({ key: 'hook-new' })
  const refused = async (why: string, said: string) => {
    const toasts = w.toasts.length
    await ui.press({ key: 'hd-add' })
    expect(w.toasts.slice(toasts).join('\n'), why).toContain(said)
    expect(w.toasts.slice(toasts), why).not.toContain('已添加')
    expect(w.writes, why).toEqual([])
    // still on the form, what was typed still there
    expect(await ui.find({ key: 'hd-add' }), why).toBeDefined()
  }
  await refused('no command', 'command')
  await ui.input({ key: 'hd-command', text: '   ' })
  await refused('a command of spaces', 'command')
  await ui.input({ key: 'hd-command', text: 'echo ok' })
  for (const bad of ['abc', '-1', '0']) {
    await ui.input({ key: 'hd-timeout', text: bad })
    await refused(`timeout ${bad}`, 'timeout')
  }
  expect(await value(ui, 'hd-command')).toBe('echo ok')
  expect(w.fs.get(USER_SETTINGS)).toBe(USER_TEXT)
  await ui.input({ key: 'hd-timeout', text: '' })
  await ui.press({ key: 'hd-add' })
  expect(w.fs.get(USER_SETTINGS)).toBe(userText(d => (d.hooks.PostToolUse = [{ hooks: [{ type: 'command', command: 'echo ok' }] }])))
  await ui.unmount()
})

// ---------- Hooks: files it must not write ----------

const PARKED_SEED: AtlasParkedHook = { id: 'off:seed', file: USER_SETTINGS, event: 'Stop', matcher: '', json: JSON.stringify({ type: 'command', command: 'say parked' }) }

const UNREADABLE: [string, string][] = [
  ['a comment in it', '{\n  "model": "opus",\n  // my hooks\n  "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "say done" } ] } ] }\n}\n'],
  ['cut short', '{\n  "model": "opus",\n  "hooks": { "Stop": [ { "hooks": [ { "type": "command", "comm'],
  ['a list at the top', '[ { "hooks": {} } ]\n'],
  ['"hooks" a list', '{\n\t"model": "opus",\n\t"hooks": [ "Stop" ]\n}'],
]

for (const [what, text] of UNREADABLE) {
  both(`Hooks: a settings file that is not a settings object (${what}) is never written`, async ($, on, surface) => {
    const { w, ui } = await openHooks($, on, surface, { files: { [USER_SETTINGS]: text, [PROJECT_SETTINGS]: PROJECT_TEXT }, store: { prefs: { hooksOff: [PARKED_SEED] } } })
    // the page says it cannot read the file, and lists no hook of its
    const said = await ui.find({ type: 'Text', text: /读不懂这个文件/ })
    expect(said?.props.color).toBe('error')
    expect(await buttonKeys(ui, 'hook:user:')).toEqual([])
    expect(await buttonKeys(ui, 'hook:')).toEqual(['hook:off:seed', 'hook:project:UserPromptSubmit:0:0'])
    // a new hook for that file
    await ui.press({ key: 'hook-new' })
    expect(await value(ui, 'hd-file')).toBe(USER_SETTINGS)
    await ui.input({ key: 'hd-command', text: 'echo new' })
    let toasts = w.toasts.length
    await ui.press({ key: 'hd-add' })
    expect(w.toasts.slice(toasts).join('\n')).toContain('没有完成')
    expect(w.toasts.slice(toasts)).not.toContain('已添加')
    expect(w.fs.get(USER_SETTINGS)).toBe(text)
    // a parked hook that came from that file, switched on
    await ui.press({ key: 'back' })
    await ui.press({ key: 'hook:off:seed' })
    toasts = w.toasts.length
    await ui.press({ key: 'hk-toggle' })
    expect(w.toasts.slice(toasts).join('\n')).toContain('没有完成')
    expect(w.fs.get(USER_SETTINGS)).toBe(text)
    // still parked: it was not dropped for a file it could not go back to
    expect(parked(w)).toEqual([PARKED_SEED])
    expect(w.writes).toEqual([])
    expect(await ui.find({ key: 'h-undo' })).toBeUndefined()
    await ui.unmount()
  })
}

both('Hooks: a settings file that is there but cannot be read is never written over', async ($, on, surface) => {
  // $.fs.read rejects for more than a missing file: over 4 MiB, a refusal from above
  const { w, ui } = await openHooks($, on, surface, { unreadable: [USER_SETTINGS] })
  expect(await buttonKeys(ui, 'hook:user:')).toEqual([])
  await ui.press({ key: 'hook-new' })
  expect(await value(ui, 'hd-file')).toBe(USER_SETTINGS)
  await ui.input({ key: 'hd-command', text: 'echo new' })
  await ui.press({ key: 'hd-add' })
  expect(w.writes.filter(x => x.path === USER_SETTINGS)).toEqual([])
  expect(w.fs.get(USER_SETTINGS)).toBe(USER_TEXT)
  await ui.unmount()
})

both('Hooks: a file changed on disk after the page read it is not overwritten by hk-toggle; the page reads it again', async ($, on, surface) => {
  const { w, ui } = await openHooks($, on, surface)
  await ui.press({ key: 'hook:user:Stop:0:0' })
  // someone else saves the file: another key changed, and this very hook's command
  const changed = userText(d => {
    d.model = 'sonnet'
    d.hooks.Stop = [{ hooks: [{ type: 'command', command: 'say all done' }] }]
  })
  w.fs.set(USER_SETTINGS, changed)
  await ui.press({ key: 'hk-toggle' })
  expect(w.fs.get(USER_SETTINGS)).toBe(changed)
  expect(w.writes).toEqual([])
  expect(parked(w)).toEqual([])
  expect(w.toasts.join('\n')).toContain('没有完成')
  expect(w.toasts.join('\n')).not.toContain('已关闭')
  // the page now shows what is on disk
  expect(await value(ui, 'hk-body')).toBe('say all done')
  // and the same press, on what it now read, goes through, keeping the other change
  await ui.press({ key: 'hk-toggle' })
  expect(w.fs.get(USER_SETTINGS)).toBe(
    userText(d => {
      d.model = 'sonnet'
      delete d.hooks.Stop
    }),
  )
  expect(parked(w).map(p => p.json)).toEqual([JSON.stringify({ type: 'command', command: 'say all done' })])
  await ui.unmount()
})

both('Hooks: a file changed on disk is not overwritten when only another key changed, by an edit or a delete', async ($, on, surface) => {
  const { w, ui } = await openHooks($, on, surface)
  await ui.press({ key: 'hook:user:PreToolUse:0:0' })
  // the hook stands where it stood, word for word: only the stale check can tell
  const changed = userText(d => (d.model = 'sonnet'))
  w.fs.set(USER_SETTINGS, changed)
  await ui.input({ key: 'hk-body', text: 'echo mine' })
  expect(w.fs.get(USER_SETTINGS)).toBe(changed)
  expect(w.toasts).not.toContain('已保存')
  w.fs.set(USER_SETTINGS, USER_TEXT)
  await ui.input({ key: 'hk-timeout', text: '9' })
  expect(w.fs.get(USER_SETTINGS)).toBe(USER_TEXT)
  w.fs.set(USER_SETTINGS, changed)
  await ui.input({ key: 'hk-matcher', text: 'Read' })
  expect(w.fs.get(USER_SETTINGS)).toBe(changed)
  w.fs.set(USER_SETTINGS, USER_TEXT)
  await ui.press({ key: 'hk-del' })
  await ui.press({ key: 'hk-delok' })
  expect(w.fs.get(USER_SETTINGS)).toBe(USER_TEXT)
  expect(w.toasts).not.toContain('已删除')
  expect(w.writes).toEqual([])
  expect(parked(w)).toEqual([])
  expect(w.toasts.filter(t => t.includes('没有完成'))).toHaveLength(4)
  await ui.unmount()
})

both('Hooks: a file that appeared, vanished or changed since the page read it is not written by + 新 hook', async ($, on, surface) => {
  const { w, ui } = await openHooks($, on, surface)
  await ui.press({ key: 'hook-new' })
  await ui.input({ key: 'hd-command', text: 'echo new' })
  // changed
  const changed = userText(d => (d.model = 'sonnet'))
  w.fs.set(USER_SETTINGS, changed)
  await ui.press({ key: 'hd-add' })
  expect(w.fs.get(USER_SETTINGS)).toBe(changed)
  expect(w.toasts).not.toContain('已添加')
  // appeared: the page read "no file" for the local settings
  await ui.select({ key: 'hd-file', value: LOCAL_SETTINGS })
  const appeared = pretty({ permissions: { allow: ['Bash(git status)'] } })
  w.fs.set(LOCAL_SETTINGS, appeared)
  await ui.press({ key: 'hd-add' })
  expect(w.fs.get(LOCAL_SETTINGS)).toBe(appeared)
  // vanished
  await ui.select({ key: 'hd-file', value: PROJECT_SETTINGS })
  w.fs.delete(PROJECT_SETTINGS)
  await ui.press({ key: 'hd-add' })
  expect(w.fs.has(PROJECT_SETTINGS)).toBe(false)
  expect(w.writes).toEqual([])
  expect(w.toasts).not.toContain('已添加')
  // each refusal read the files again, so the next press works on what is there now
  await ui.select({ key: 'hd-file', value: LOCAL_SETTINGS })
  await ui.press({ key: 'hd-add' })
  expect(w.fs.get(LOCAL_SETTINGS)).toBe(pretty({ permissions: { allow: ['Bash(git status)'] }, hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'echo new' }] }] } }))
  expect(w.toasts).toContain('已添加')
  await ui.unmount()
})

both('Hooks: a parked hook is not put back into a file that changed since the page read it; h-undo is refused the same way', async ($, on, surface) => {
  const { w, ui } = await openHooks($, on, surface)
  await ui.press({ key: 'hook:user:Stop:0:0' })
  await ui.press({ key: 'hk-toggle' })
  const kept = parked(w)
  expect(kept).toHaveLength(1)
  const writes = w.writes.length
  // someone else saves the file after Atlas's write
  const changed = userText(d => {
    d.model = 'sonnet'
    delete d.hooks.Stop
  })
  w.fs.set(USER_SETTINGS, changed)
  // undo would put back a text that is no longer what was replaced
  await ui.press({ key: 'back' })
  await ui.press({ key: 'h-undo' })
  expect(w.fs.get(USER_SETTINGS)).toBe(changed)
  expect(parked(w)).toEqual(kept)
  expect(w.toasts).not.toContain('已撤销')
  // that refusal read the file again; change it once more, then try to switch the hook on
  const again = userText(d => {
    d.model = 'haiku'
    delete d.hooks.Stop
  })
  w.fs.set(USER_SETTINGS, again)
  await ui.press({ key: `hook:${kept[0]?.id ?? ''}` })
  await ui.press({ key: 'hk-toggle' })
  expect(w.fs.get(USER_SETTINGS)).toBe(again)
  expect(parked(w)).toEqual(kept)
  expect(w.toasts).not.toContain('已开启：放回 settings 了')
  expect(w.writes.length).toBe(writes)
  await ui.unmount()
})

both('Hooks: when the parked list cannot be saved, the hook is not left in neither place', async ($, on, surface) => {
  // $.store.set rejects a store over 4 MiB; hk-toggle writes the file first, the store second
  const { w, ui } = await openHooks($, on, surface)
  await ui.press({ key: 'hook:user:Stop:0:0' })
  w.flags.storeFails = true
  await ui.press({ key: 'hk-toggle' })
  expect(w.toasts.join('\n')).toContain('没有完成')
  const inFile = (w.fs.get(USER_SETTINGS) ?? '').includes('say done')
  const isParked = parked(w).some(p => p.json.includes('say done'))
  expect(inFile || isParked, 'the hook is still in its settings file, or in the parked list').toBe(true)
  await ui.unmount()
})

both('Hooks: a failed read of the store costs nothing else that is kept there', async ($, on, surface) => {
  // a parked hook exists nowhere but in the store, beside every other default Atlas keeps
  const kept = {
    skillsOff: { global: ['autodoc'], byProject: {} },
    skillDirs: {},
    memory: { defaults: { global: { 'shared-memory': 'mount' }, byProject: {} } },
    groups: [],
    archived: { sessions: [], projects: [] },
    prompt: { global: { off: ['tone'], rewrite: {}, extra: [] }, byProject: {} },
    hooksOff: [PARKED_SEED],
  }
  const { w, ui } = await openHooks($, on, surface, { store: { prefs: kept } })
  await ui.press({ key: 'hook:user:PreToolUse:1:0' })
  w.flags.storeReadFails = true
  await ui.press({ key: 'hk-toggle' })
  w.flags.storeReadFails = false
  const now = (w.store.get('prefs') ?? {}) as Partial<typeof kept>
  expect(now.hooksOff ?? [], 'the hook parked earlier').toContainEqual(PARKED_SEED)
  expect(now.skillsOff, 'the skills switched off by default').toEqual(kept.skillsOff)
  expect(now.memory, 'the memory defaults').toEqual(kept.memory)
  expect(now.prompt, 'the prompt defaults').toEqual(kept.prompt)
  await ui.unmount()
})

both('Hooks: two presses of hk-toggle that overlap keep the hook exactly once', async ($, on, surface) => {
  // a second press that lands before the first has finished: nothing holds it back
  const { w, ui } = await openHooks($, on, surface)
  await ui.press({ key: 'hook:user:Stop:0:0' })
  await Promise.all([ui.press({ key: 'hk-toggle' }), ui.press({ key: 'hk-toggle' })])
  const inFile = (w.fs.get(USER_SETTINGS) ?? '').split('"say done"').length - 1
  const kept = parked(w).filter(p => p.json === JSON.stringify(DONE)).length
  expect(inFile + kept, `in the settings file ${inFile} time(s), in the stored parked list ${kept} time(s)`).toBe(1)
  await ui.unmount()
})

both('Hooks: a hook parked from another project is listed, and switched on goes back into its own file', async ($, on, surface) => {
  const stray: AtlasParkedHook = { id: 'off:stray', file: OTHER_SETTINGS, event: 'Stop', matcher: '', json: JSON.stringify({ type: 'command', command: 'say elsewhere' }) }
  const otherText = pretty({ model: 'haiku', hooks: { Stop: [{ hooks: [DONE] }] } })
  const { w, ui } = await openHooks($, on, surface, { files: { ...hookFiles(), [OTHER_SETTINGS]: otherText }, store: { prefs: { hooksOff: [stray] } } })
  expect(await buttonKeys(ui, 'hook:off:')).toEqual(['hook:off:stray'])
  await ui.press({ key: 'hook:off:stray' })
  expect(await label(ui, 'hk-toggle')).toBe('开启')
  await ui.press({ key: 'hk-toggle' })
  expect(w.fs.get(OTHER_SETTINGS)).toBe(pretty({ model: 'haiku', hooks: { Stop: [{ hooks: [DONE, { type: 'command', command: 'say elsewhere' }] }] } }))
  expect(parked(w)).toEqual([])
  // this session's own files were not touched
  expect(w.fs.get(USER_SETTINGS)).toBe(USER_TEXT)
  expect(w.fs.get(PROJECT_SETTINGS)).toBe(PROJECT_TEXT)
  expect(w.writes.map(x => x.path)).toEqual([OTHER_SETTINGS])
  await ui.unmount()
})

// ---------- classic.*: counting ----------

test('classic.*: counting an event never changes what it was given or what it answers', async ($, on) => {
  const w = world(on, { files: hookFiles() })
  const seen: Record<string, unknown>[] = []
  const stop = { block: 'not yet: the tests have not run', additionalContext: ['from a settings hook', 'and another'] }
  const submit = { additionalContext: ['today is Thursday'], sessionTitle: 'A title', suppressOriginalPrompt: true as const }
  const end = { preventContinuation: true as const, stopReason: 'enough' }
  on('classic.Stop', ($, e) => {
    seen.push({ ...e })
    return stop
  })
  on('classic.UserPromptSubmit', ($, e) => {
    seen.push({ ...e })
    return submit
  })
  on('classic.SessionEnd', () => end)
  on('classic.Notification', () => ({}))
  await start($, w)
  expect(await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done' })).toEqual(stop)
  expect(await $.classic.Stop({ stop_hook_active: true })).toEqual(stop)
  expect(await $.classic.UserPromptSubmit({ prompt: 'hello there', source: 'user' })).toEqual(submit)
  expect(await $.classic.SessionEnd({ reason: 'other' })).toEqual(end)
  expect(await $.classic.Notification({ message: 'm', notification_type: 'idle_prompt' })).toEqual({})
  expect(seen.map(e => [e.hook_event_name, e.stop_hook_active, e.last_assistant_message, e.prompt, e.source])).toEqual([
    ['Stop', false, 'done', undefined, undefined],
    ['Stop', true, undefined, undefined, undefined],
    ['UserPromptSubmit', undefined, undefined, 'hello there', 'user'],
  ])
  // PreToolUse rides the tool call: counted, the call's result as the engine gave it
  expect(await $.tool.call({ tool: 'Bash', command: 'ls' })).toEqual({ result: 'ran' })
  // the count is what the Hooks page shows beside the hooks of that event
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'tab:hooks' })
  const tails = (await ui.findAll({ type: 'Text', text: /本会话触发/ })).map(t => t.text)
  expect(tails).toEqual([
    expect.stringContaining('guard.sh · 本会话触发 1 次'),
    expect.stringContaining('echo second · 本会话触发 1 次'),
    expect.stringContaining('echo edit · 本会话触发 1 次'),
    expect.stringContaining('say done · 本会话触发 2 次'),
    expect.stringContaining('echo prompt · 本会话触发 1 次'),
  ])
  // nothing was written for any of it
  expect(w.writes).toEqual([])
  await ui.unmount()
})

test('classic.*: a count starts at nothing in a session where the event has not fired', async ($, on) => {
  const w = world(on, { files: hookFiles() })
  await start($, w)
  const ui = await mountPane($, 'desktop')
  await ui.press({ key: 'tab:hooks' })
  expect(await ui.findAll({ type: 'Text', text: /本会话触发/ })).toEqual([])
  await ui.unmount()
})

// ---------- which level an edit lives at ----------

describe('manage.ts 提示词 > levels', () => {
  const CWD_L = '/work/proj'
  const none: AtlasPromptEdits = { off: [], rewrite: {}, extra: [] }
  const prefs = normalizePrefs({
    prompt: {
      global: { off: ['tone'], rewrite: { intro: 'g intro' }, extra: [{ id: 'atlas:voice', name: 'voice', text: 'hi', off: false }] },
      byProject: { [CWD_L]: { off: [], rewrite: { tone: 'p tone' }, extra: [] } },
    },
  })
  const sw: AtlasSwitches = { skillsOff: [], skillDirs: {}, memory: {}, files: {}, prompt: { off: ['tone', 'actions'], rewrite: {}, extra: [] } }

  test('levelEdits sets the three levels side by side, a project with none as no edits', () => {
    const all = levelEdits(prefs, CWD_L, sw)
    expect(all.session.off).toEqual(['tone', 'actions'])
    expect(all.project.rewrite).toEqual({ tone: 'p tone' })
    expect(all.global.off).toEqual(['tone'])
    expect(levelEdits(prefs, '/elsewhere', sw).project).toEqual(none)
  })

  test('a store or a session from before the page has no edits at any level', () => {
    const old: AtlasSwitches = { skillsOff: [], skillDirs: {}, memory: {}, files: {} }
    const all = levelEdits(normalizePrefs(undefined), CWD_L, old)
    expect(all).toEqual({ session: none, project: none, global: none })
    expect(sectionLevelsText(all, 'tone')).toBe('')
  })

  test('sectionLevelsText names every level that edits the section, session first', () => {
    const all = levelEdits(prefs, CWD_L, sw)
    expect(sectionLevelsText(all, 'tone')).toBe('已关闭（本会话、全局） · 已改写（本项目）')
    expect(sectionLevelsText(all, 'actions')).toBe('已关闭（本会话）')
    expect(sectionLevelsText(all, 'intro')).toBe('已改写（全局）')
    expect(sectionLevelsText(all, 'system')).toBe('')
  })

  test('levelState: off wins over a rewrite, and no edit is 没改', () => {
    expect(levelState({ off: ['a'], rewrite: { a: 'x' }, extra: [] }, 'a')).toBe('已关闭')
    expect(levelState({ off: [], rewrite: { a: 'x' }, extra: [] }, 'a')).toBe('已改写')
    expect(levelState(none, 'a')).toBe('没改')
  })

  test('levelsWhere and levelsText say where an own section is kept', () => {
    const all = levelEdits(prefs, CWD_L, sw)
    const at = levelsWhere(all, e => e.extra.some(x => x.id === 'atlas:voice'))
    expect(at).toEqual(['global'])
    expect(levelsText(at)).toBe('全局')
    expect(levelsText(['session', 'project', 'global'])).toBe('本会话、本项目、全局')
  })
})

// ---------- 提示词: what the engine injects into the conversation ----------

describe('manage.ts 提示词 > injections', () => {
  const none: AtlasPromptEdits = { off: [], rewrite: {}, extra: [] }

  test('setInjectOff adds a kind once, and leaves no empty list behind', () => {
    const one = setInjectOff(none, 'date', true)
    expect(one).toEqual({ off: [], rewrite: {}, extra: [], injectOff: ['date'] })
    expect(setInjectOff(one, 'date', true).injectOff).toEqual(['date'])
    expect(setInjectOff(one, 'model', true).injectOff).toEqual(['date', 'model'])
    expect(setInjectOff(one, 'date', false)).toEqual(none)
    expect(injectOffOf(none)).toEqual([])
    expect(injectOffOf(undefined)).toEqual([])
  })

  test('the other edits keep the injected kinds that are off', () => {
    const one = setInjectOff(none, 'date', true)
    expect(setOff(one, 'tone', true).injectOff).toEqual(['date'])
    expect(setRewrite(one, 'tone', 'x').injectOff).toEqual(['date'])
    expect(putExtra(one, { id: 'atlas:a', name: 'a', text: 't', off: false }).injectOff).toEqual(['date'])
  })

  test('normalizeEdits keeps the list only when it holds something; mergeEdits unites the levels', () => {
    expect(normalizeEdits({ injectOff: ['date', 'date', 3] })).toEqual({ off: [], rewrite: {}, extra: [], injectOff: ['date'] })
    expect(normalizeEdits({ injectOff: [] })).toEqual(none)
    expect(normalizeEdits({})).toEqual(none)
    const merged = mergeEdits({ ...none, injectOff: ['date'] }, { ...none, injectOff: ['model', 'date'] })
    expect(merged.injectOff).toEqual(['date', 'model'])
    expect(mergeEdits(none, none)).toEqual(none)
  })

  test('recordInject counts what was sent and what was held back apart, and keeps the latest text', () => {
    heldM.injects.clear()
    recordInject('date', 'today', 'engine', 1)
    recordInject('date', 'tomorrow', 'engine', 2)
    recordInject('date', 'held', 'engine', 3, true)
    expect(heldM.injects.get('date')).toEqual({ count: 2, blocked: 1, chars: 13, lastText: 'held', origin: 'engine', lastMs: 3 })
    recordInject('big', 'x'.repeat(70_000), 'hook', 4)
    expect(heldM.injects.get('big')?.lastText.length).toBe(60_000)
    expect(heldM.injects.get('big')?.chars).toBe(70_000)
    heldM.injects.clear()
  })

  test('names, cautions and the levels a kind is off at', () => {
    expect(injectName('skill_listing')).toBe('Skills 列表')
    expect(injectName('something_new')).toBe('something_new')
    expect(injectCaution('instructions')).toContain('记忆')
    expect(injectCaution('deferred_tools_delta')).not.toBe('')
    expect(injectCaution('date')).toBe('')
    const prefs = normalizePrefs({ prompt: { global: { injectOff: ['date'] }, byProject: {} } })
    const sw: AtlasSwitches = { skillsOff: [], skillDirs: {}, memory: {}, files: {}, prompt: { ...none, injectOff: ['date', 'model'] } }
    const all = levelEdits(prefs, '/work/proj', sw)
    expect(injectLevelsText(all, 'date')).toBe('已关闭（本会话、全局）')
    expect(injectLevelsText(all, 'model')).toBe('已关闭（本会话）')
    expect(injectLevelsText(all, 'environment')).toBe('')
  })
})

const ENGINE = { kind: 'engine' } as const

both('提示词: an injected kind is listed once seen, and switched off for the session it is held back', async ($, on, surface) => {
  on('prompt.attachment', (_, e) => ({ text: e.text }))
  const { w, ui } = await openPrompt($, on, surface)
  expect(await $.prompt.attachment({ type: 'date', text: "Today's date is 2026-11-12.", origin: ENGINE })).toEqual({ text: "Today's date is 2026-11-12." })
  expect(await $.prompt.attachment({ type: 'model', text: 'You are powered by a model.', origin: ENGINE })).toEqual({ text: 'You are powered by a model.' })
  expect(await buttonKeys(ui, 'inj:')).toEqual(['inj:date', 'inj:model'])
  await ui.press({ key: 'inj:date' })
  expect((await ui.find({ type: 'Text', text: /本会话：/ }))?.text).toContain('照常注入')
  const asked = w.invalidated.length
  await ui.press({ key: 'inj-toggle' })
  expect(w.invalidated.slice(asked)).toContain('prompt.attachment')
  expect(injectOffOf(w.switches()?.prompt)).toEqual(['date'])
  expect(await $.prompt.attachment({ type: 'date', text: "Today's date is 2026-11-12.", origin: ENGINE })).toEqual({ text: null })
  expect(await $.prompt.attachment({ type: 'model', text: 'You are powered by a model.', origin: ENGINE })).toEqual({ text: 'You are powered by a model.' })
  expect((await ui.find({ type: 'Text', text: /本会话：/ }))?.text).toContain('已关闭')
  await ui.press({ key: 'inj-toggle' })
  expect(injectOffOf(w.switches()?.prompt)).toEqual([])
  expect(await $.prompt.attachment({ type: 'date', text: "Today's date is 2026-11-12.", origin: ENGINE })).toEqual({ text: "Today's date is 2026-11-12." })
  await ui.unmount()
})

both('提示词: an injected kind switched off as the global default is stored, and this session keeps getting it', async ($, on, surface) => {
  on('prompt.attachment', (_, e) => ({ text: e.text }))
  const { w, ui } = await openPrompt($, on, surface)
  await $.prompt.attachment({ type: 'date', text: 'today', origin: ENGINE })
  await pick(ui, surface, 'scope:prompt', 'global')
  await ui.press({ key: 'inj:date' })
  await ui.press({ key: 'inj-toggle' })
  const stored = normalizePrefs(w.store.get('prefs'))
  expect(injectOffOf(stored.prompt?.global)).toEqual(['date'])
  expect(injectOffOf(w.switches()?.prompt)).toEqual([])
  expect(await $.prompt.attachment({ type: 'date', text: 'today', origin: ENGINE })).toEqual({ text: 'today' })
  await ui.unmount()
})

both('提示词: a new session starts with the injected kinds its defaults switch off', async ($, on, surface) => {
  on('prompt.attachment', (_, e) => ({ text: e.text }))
  const prefs = { prompt: { global: { injectOff: ['date'] }, byProject: { '/work/proj': { injectOff: ['model'] } } } }
  const { w, ui } = await openPrompt($, on, surface, { store: { prefs } })
  expect(injectOffOf(w.switches()?.prompt)).toEqual(['date', 'model'])
  expect(await $.prompt.attachment({ type: 'date', text: 'today', origin: ENGINE })).toEqual({ text: null })
  expect(await $.prompt.attachment({ type: 'environment', text: 'env', origin: ENGINE })).toEqual({ text: 'env' })
  await ui.unmount()
})

// ---------- 手帐: the illustration over a page ----------

test('kilo writes a count the way a note has room for', () => {
  expect(kilo(0)).toBe('0')
  expect(kilo(950)).toBe('950')
  expect(kilo(9800)).toBe('9.8k')
  expect(kilo(13008)).toBe('13k')
  expect(kilo(Number.NaN)).toBe('0')
  expect(kilo(-5)).toBe('0')
})

/** The 手帐 illustration over a page, told from the paper pieces by what it says. */
async function journalPic(ui: Ui) {
  return (await ui.findAll({ type: 'Svg' })).find(p => /^手帐插图/.test(String(p.props.alt)))
}

both('手帐: the desktop draws the illustration over a page and folds it away; the terminal draws none', async ($, on, surface) => {
  const { ui } = await openPrompt($, on, surface)
  if (surface === 'terminal') {
    expect(await journalPic(ui)).toBeUndefined()
    expect(await ui.find({ key: 'journal-hide' })).toBeUndefined()
    await ui.unmount()
    return
  }
  expect(await journalPic(ui)).toBeDefined()
  await ui.press({ key: 'journal-hide' })
  expect(await journalPic(ui)).toBeUndefined()
  // folded stays folded on another page
  await ui.press({ key: 'tab:hooks' })
  expect(await journalPic(ui)).toBeUndefined()
  await ui.press({ key: 'journal-show' })
  expect(await journalPic(ui)).toBeDefined()
  // an opened item has the page to itself
  await ui.press({ key: 'tab:prompt' })
  await ui.press({ key: 'sec:tone' })
  expect(await journalPic(ui)).toBeUndefined()
  await ui.unmount()
})

// ---------- 提示词: the name that stands where the instructions say "the user" ----------

describe('manage.ts 提示词 > the name for "the user"', () => {
  const none: AtlasPromptEdits = { off: [], rewrite: {}, extra: [] }

  test('renameUser writes the name for the person, at a sentence start and inside one, and counts', () => {
    const r = renameUser('The user will ask. Tell the user plainly; never surprise the user.', 'Robin')
    expect(r.text).toBe('Robin will ask. Tell Robin plainly; never surprise Robin.')
    expect(r.count).toBe(3)
  })

  test('a possessive keeps its ending, straight or curly', () => {
    expect(renameUser("the user's request and the user’s files", 'Robin').text).toBe("Robin's request and Robin’s files")
  })

  test('words where "user" is no person are left as they are', () => {
    const kept = [
      'Assume users can read this.',
      'a user-facing string and the user-facing text',
      'the user message, the user messages, the user prompt, the user turn and the user role',
      'the user settings, the user scope, the user tier, the user config and the user directory',
      'the user interface, the user type, the user memory, the user id and the user email',
      'userEmail, UserPromptSubmit, AskUserQuestion, user_id',
      'THE USER in capitals, your user, a user, user alone',
    ]
    for (const text of kept) expect(renameUser(text, 'Robin'), text).toEqual({ text, count: 0 })
  })

  test('a verb after it is still the person', () => {
    expect(renameUser('when the user provided a file, or the user typed and the user requested it', 'Robin').text).toBe(
      'when Robin provided a file, or Robin typed and Robin requested it',
    )
  })

  test('the name is written as it is, whatever it holds, and an empty one changes nothing', () => {
    expect(renameUser('ask the user', '$& $1 \\ 某人').text).toBe('ask $& $1 \\ 某人')
    expect(renameUser('ask the user', '')).toEqual({ text: 'ask the user', count: 0 })
    expect(renameUser('ask the user', '   ')).toEqual({ text: 'ask the user', count: 0 })
    expect(renameUser('', 'Robin')).toEqual({ text: '', count: 0 })
    // run twice: nothing is left to change, and the name is not doubled
    const once = renameUser('ask the user', 'Robin').text
    expect(renameUser(once, 'Robin')).toEqual({ text: 'ask Robin', count: 0 })
  })

  test('cleanName keeps one trimmed line of 40 characters at most', () => {
    expect(cleanName('  Robin \n Sea\t ')).toBe('Robin Sea')
    expect(cleanName('x'.repeat(60)).length).toBe(40)
  })

  test('setRename, normalizeEdits and mergeEdits carry the name, and no empty one', () => {
    const one = setRename(none, ' Robin ')
    expect(one).toEqual({ off: [], rewrite: {}, extra: [], rename: 'Robin' })
    expect(setRename(one, '')).toEqual(none)
    expect(renameOf(one)).toBe('Robin')
    expect(renameOf(none)).toBe('')
    expect(renameOf(undefined)).toBe('')
    expect(normalizeEdits({ rename: ' Robin ' }).rename).toBe('Robin')
    expect(normalizeEdits({ rename: 7 })).toEqual(none)
    expect(normalizeEdits({ rename: '' })).toEqual(none)
    expect(mergeEdits({ ...none, rename: 'A' }, none).rename).toBe('A')
    expect(mergeEdits({ ...none, rename: 'A' }, { ...none, rename: 'B' }).rename).toBe('B')
    expect(mergeEdits(none, none)).toEqual(none)
  })

  test('the other edits keep the name', () => {
    const one = setRename(none, 'Robin')
    expect(setOff(one, 'tone', true).rename).toBe('Robin')
    expect(setRewrite(one, 'tone', 'x').rename).toBe('Robin')
    expect(setInjectOff(one, 'date', true).rename).toBe('Robin')
    expect(setInjectOff(setInjectOff(one, 'date', true), 'date', false)).toEqual(one)
    expect(setRename(setInjectOff(none, 'date', true), 'Robin').injectOff).toEqual(['date'])
  })

  test('renameLevelsText says which levels name someone', () => {
    const prefs = normalizePrefs({ prompt: { global: { rename: 'Robin' }, byProject: {} } })
    const sw: AtlasSwitches = { skillsOff: [], skillDirs: {}, memory: {}, files: {}, prompt: { ...none, rename: 'Sea' } }
    expect(renameLevelsText(levelEdits(prefs, '/work/proj', sw))).toBe('本会话：Sea · 全局：Robin')
    expect(renameLevelsText(levelEdits(normalizePrefs(undefined), '/work/proj', { ...sw, prompt: none }))).toBe('')
  })
})

both('提示词: a name set for the session is written into the sections, the injections and the tool descriptions', async ($, on, surface) => {
  on('prompt.attachment', (_, e) => ({ text: e.text }))
  on('tool.describe', (_, e) => ({ description: e.description }))
  const { w, ui } = await openPrompt($, on, surface)
  const tool = { tool: 'Ask', description: 'Asks the user a question. The user answers.', provider: { plugin: 'core', tier: 'core' } } as const
  expect(await $.prompt.section({ name: 'tone', text: 'Tell the user.' })).toEqual({ text: 'Tell the user.' })
  expect((await $.tool.describe(tool)).description).toBe('Asks the user a question. The user answers.')
  const asked = w.invalidated.length
  await ui.input({ key: 'rn-name', text: 'Robin' })
  expect(w.switches()?.prompt?.rename).toBe('Robin')
  for (const event of ['prompt.section', 'prompt.attachment', 'tool.describe']) expect(w.invalidated.slice(asked)).toContain(event)
  expect(await $.prompt.section({ name: 'tone', text: 'Tell the user. Not the user message.' })).toEqual({ text: 'Tell Robin. Not the user message.' })
  expect(await $.prompt.section({ name: 'gone', text: null })).toEqual({ text: null })
  expect(await $.prompt.attachment({ type: 'date', text: 'Remind the user of the date.', origin: ENGINE })).toEqual({ text: 'Remind Robin of the date.' })
  expect((await $.tool.describe(tool)).description).toBe('Asks Robin a question. Robin answers.')
  expect((await $.tool.describe({ ...tool, description: 'Lists files.' })).description).toBe('Lists files.')
  const composed = await $.prompt.compose({ model: 'claude-test', promptModel: 'claude-test', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  for (const s of composed.sections) expect(s.text).not.toMatch(/\b[Tt]he user\b(?![-\w])(?! message)/)
  // taking the name back leaves the instructions as they were
  await ui.input({ key: 'rn-name', text: '' })
  expect(w.switches()?.prompt?.rename).toBeUndefined()
  expect(await $.prompt.section({ name: 'tone', text: 'Tell the user.' })).toEqual({ text: 'Tell the user.' })
  await ui.unmount()
})

both('提示词: a name set as the global default is stored, and reaches the next session, not this one', async ($, on, surface) => {
  const { w, ui } = await openPrompt($, on, surface)
  await pick(ui, surface, 'scope:prompt', 'global')
  await ui.input({ key: 'rn-name', text: 'Robin' })
  expect(normalizePrefs(w.store.get('prefs')).prompt?.global.rename).toBe('Robin')
  expect(w.switches()?.prompt?.rename).toBeUndefined()
  expect(await $.prompt.section({ name: 'tone', text: 'Tell the user.' })).toEqual({ text: 'Tell the user.' })
  await ui.unmount()
})

both('提示词: a session starts with the name its defaults give, a rewritten section included', async ($, on, surface) => {
  const prefs = { prompt: { global: { rename: 'Robin', rewrite: { tone: 'Greet the user warmly.' } }, byProject: {} } }
  const { w, ui } = await openPrompt($, on, surface, { store: { prefs } })
  expect(w.switches()?.prompt?.rename).toBe('Robin')
  expect(await $.prompt.section({ name: 'tone', text: 'Tell the user.' })).toEqual({ text: 'Greet Robin warmly.' })
  await ui.unmount()
})

// ---------- the desktop's readable layout ----------

both('排版: on the desktop a section row reads in plain words with its states marked; the terminal keeps its one line', async ($, on, surface) => {
  const { ui } = await openPrompt($, on, surface)
  await ui.press({ key: 'sec:tone' })
  await ui.press({ key: 's-toggle' })
  await ui.press({ key: 'back' })
  const row = await ui.find({ key: 'sec:tone' })
  const marks = await ui.find({ type: 'Text', text: /已关闭（本会话）/ })
  expect(marks).toBeDefined()
  if (surface === 'desktop') {
    expect(row?.text).toBe('语气和格式')
    // the state is a mark of its own, and the small print under the name says which section it is
    expect(marks?.text.trim()).toBe('已关闭（本会话）')
    expect(await ui.find({ type: 'Text', text: /^tone\b.*字符/ })).toBeDefined()
  } else {
    expect(row?.props.label).toBe('tone')
    expect(marks?.text).toContain('·')
  }
  await ui.unmount()
})

both('排版: the levels are laid out as buttons on the desktop, each with what it means; a note wraps instead of being cut', async ($, on, surface) => {
  const { ui } = await openPrompt($, on, surface)
  if (surface !== 'desktop') {
    expect(await ui.find({ key: 'scope:prompt:global' })).toBeUndefined()
    await ui.unmount()
    return
  }
  expect(await ui.find({ key: 'scope:prompt' })).toBeUndefined()
  expect((await ui.find({ key: 'scope:prompt:session' }))?.props.variant).toBe('primary')
  expect((await ui.find({ type: 'Text', text: /只影响现在这个会话/ }))?.text).toBe('只影响现在这个会话，关掉会话就没了。')
  await ui.press({ key: 'scope:prompt:global' })
  expect((await ui.find({ key: 'scope:prompt:global' }))?.props.variant).toBe('primary')
  expect((await ui.find({ key: 'scope:prompt:session' }))?.props.variant).toBe('secondary')
  expect(await ui.find({ type: 'Text', text: /以后任何项目里新开的会话都带上/ })).toBeDefined()
  // a long note is there whole, set to wrap
  const note = await ui.find({ type: 'Text', text: /系统提示词在一条对话开始时就定下了/ })
  expect(note?.text.endsWith('丢掉模型之前的思考。')).toBe(true)
  expect(note?.props.wrap).toBe('wrap')
  await ui.unmount()
})

// ---------- /atlas where nothing draws the pane yet ----------

test('notPlacedText says why in plain words and keeps the engine\'s own', () => {
  expect(notPlacedText('no-surface: nothing attached draws')).toContain('界面还没接上来')
  expect(notPlacedText('no attached surface places panes (phone-1): placed when a surface that does attaches')).toContain('不显示面板')
  expect(notPlacedText('unasked below 144 columns (90 now)')).toContain('窗口太窄')
  expect(notPlacedText('something new')).toContain('引擎说现在放不了')
  expect(notPlacedText('something new')).toContain('something new')
  expect(notPlacedText('')).toContain('没有说明')
})

test('/atlas where no surface draws yet keeps the pane open and says why', async ($, on) => {
  const w = world(on, { open: { isPlaced: false, reason: 'no-surface: nothing attached draws' } })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'atlas', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  const said = JSON.stringify(r)
  expect(said).toContain('面板还没画出来')
  expect(said).toContain('界面还没接上来')
  expect(said).toContain('no-surface: nothing attached draws')
  expect(said).toContain('个 skills')
  await w.clock.settle()
  expect(w.closed).toEqual([])
})

both('排版: on the desktop each list row is a strip of its own colour, the next one a different colour', async ($, on, surface) => {
  const { ui } = await openPrompt($, on, surface)
  const strips = (await ui.findAll({ type: 'Box' })).filter(b => typeof b.key === 'string' && b.key.startsWith('strip:sec:'))
  const tints = strips.map(b => b.props.backgroundColor)
  if (surface !== 'desktop') {
    expect(tints.every(t => t === undefined)).toBe(true)
    await ui.unmount()
    return
  }
  expect(strips.length).toBeGreaterThan(1)
  expect(tints.every(t => typeof t === 'string' && /^#[0-9A-F]{6}$/.test(t))).toBe(true)
  for (let i = 1; i < tints.length; i++) expect(tints[i], `row ${i}`).not.toBe(tints[i - 1])
  // each strip has an edge of its own: a border in a deeper shade than its fill
  for (const b of strips) {
    expect(b.props.borderStyle).toBe('round')
    expect(String(b.props.borderColor)).toMatch(/^#[0-9A-F]{6}$/)
    expect(b.props.borderColor).not.toBe(b.props.backgroundColor)
  }
  await ui.unmount()
})

both('排版: on the desktop an ordinary button is a small mint label, the chosen one stays the surface\'s own; it presses as before', async ($, on, surface) => {
  const { ui } = await openPrompt($, on, surface)
  const pillsNow = async () => (await ui.findAll({ type: 'Box' })).filter(b => typeof b.key === 'string' && b.key.startsWith('pill:tab:'))
  const pills = await pillsNow()
  if (surface !== 'desktop') {
    expect(pills).toEqual([])
    await ui.unmount()
    return
  }
  expect(pills.length).toBeGreaterThan(4)
  // the open page's tab has no label round it: it is the surface's primary button
  expect(pills.some(b => b.key === 'pill:tab:prompt')).toBe(false)
  expect((await ui.find({ key: 'tab:prompt' }))?.props.variant).toBe('primary')
  const tints = new Set(pills.map(b => b.props.backgroundColor))
  expect(tints.size).toBe(1)
  expect(String([...tints][0])).toMatch(/^#[0-9A-F]{6}$/)
  // a label is no taller than its button: it brings no padding of its own down the page
  for (const b of pills) expect(b.props.paddingY, String(b.key)).toBe(0)
  // the real Button inside keeps its key, its words and its press
  expect((await ui.find({ key: 'tab:hooks' }))?.text).toBe('Hooks')
  await ui.press({ key: 'tab:hooks' })
  const after = await pillsNow()
  expect(after.some(b => b.key === 'pill:tab:hooks')).toBe(false)
  expect(after.some(b => b.key === 'pill:tab:prompt')).toBe(true)
  // a row's name is a plain button: no label is drawn round it
  expect((await ui.findAll({ type: 'Box' })).some(b => typeof b.key === 'string' && b.key.startsWith('pill:hook:'))).toBe(false)
  await ui.unmount()
})

// ---------- Windows: drive paths, and the commands that stand in for the Mac's ----------

describe('text.ts paths > Windows', () => {
  test('slashes turns every backslash, and leaves a path that has none as it is', () => {
    expect(slashes('C:\\Users\\t\\.claude')).toBe('C:/Users/t/.claude')
    expect(slashes('/home/t/.claude')).toBe('/home/t/.claude')
  })

  test('a drive path is absolute, and normalizes with its drive kept', () => {
    expect(isAbsolutePath('C:/Users/t')).toBe(true)
    expect(isAbsolutePath('/home/t')).toBe(true)
    expect(isAbsolutePath('notes/a.md')).toBe(false)
    expect(normalizePath('C:\\Users\\t\\.claude\\..\\x\\.\\a.md', 'E:/work/proj', 'C:/Users/t')).toBe('C:/Users/t/x/a.md')
    expect(normalizePath('notes\\a.md', 'E:/work/proj', 'C:/Users/t')).toBe('E:/work/proj/notes/a.md')
    expect(normalizePath('~/.claude/CLAUDE.md', 'E:/work/proj', 'C:/Users/t')).toBe('C:/Users/t/.claude/CLAUDE.md')
    expect(normalizePath('..\\..\\..\\a.md', 'E:/work/proj', 'C:/Users/t')).toBe('E:/a.md')
    // a Mac's paths come out as they always did
    expect(normalizePath('notes/../a.md', '/work/proj', '/home/t')).toBe('/work/proj/a.md')
    expect(normalizePath('~/x', '/work/proj', '/home/t')).toBe('/home/t/x')
  })

  test('inside a folder: a drive path compares without regard to case, a Mac path exactly', () => {
    expect(isInside('c:/users/T/.claude/skills/a', 'C:/Users/t/.claude')).toBe(true)
    expect(isInside('C:/Users/t/.claudex', 'C:/Users/t/.claude')).toBe(false)
    expect(isInside('E:/work/proj', 'C:/Users/t')).toBe(false)
    expect(isInside('/Home/t/x', '/home/t')).toBe(false)
    expect(isInside('/home/t/x', '/home/t/')).toBe(true)
  })

  test('the pieces of a drive path', () => {
    expect(basename('C:/Users/t/.claude/settings.json')).toBe('settings.json')
    expect(dirname('C:/Users/t/.claude/settings.json')).toBe('C:/Users/t/.claude')
    expect(dirname('C:/x')).toBe('C:/')
    expect(dirname('C:/')).toBe('C:/')
    expect(dirname('/x')).toBe('/')
    expect(shortPath('C:/Users/t/.claude/x.md', 'C:/Users/t')).toBe('~/.claude/x.md')
    expect(shortPath('c:/users/t/.claude/x.md', 'C:/Users/t')).toBe('~/.claude/x.md')
    expect(shortPath('E:/work/proj/a.md', 'C:/Users/t')).toBe('E:/work/proj/a.md')
    // the folder Claude Code keeps a project's transcripts under, either spelling
    expect(slugify('E:\\claude-code\\projects\\foo')).toBe('E--claude-code-projects-foo')
    expect(slugify('E:/claude-code/projects/foo')).toBe('E--claude-code-projects-foo')
  })
})

both('Windows: the session keeps its places with forward slashes and runs atlas.py with python from PATH', async ($, on, surface) => {
  const settings = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node C:/Users/t/.claude/hooks/done.mjs' }] }] } }, null, 2) + '\n'
  const w = world(on, { win: true, files: { 'C:/Users/t/.claude/settings.json': settings } })
  await start($, w, WIN_CWD)
  const ctx = w.state.ctx as { home: string; claudeDir: string; cwd: string; win?: boolean }
  expect(ctx).toMatchObject({ home: 'C:/Users/t', claudeDir: 'C:/Users/t/.claude', cwd: 'E:/work/proj', win: true })
  // no Mac command is run there: not date, not the system Python
  expect(w.runs.some(r => r[0] === '/bin/date' || r[0] === '/usr/bin/python3')).toBe(false)
  const scan = w.runs.find(r => r[3] === 'index')
  expect(scan?.[0]).toBe('python')
  expect(scan?.[2]).not.toContain('\\')
  const ui = await mountPane($, surface)
  await ui.press({ key: 'tab:hooks' })
  // the settings files are looked for where Windows keeps them
  for (const path of ['C:/Users/t/.claude/settings.json', 'E:/work/proj/.claude/settings.json', 'E:/work/proj/.claude/settings.local.json']) expect(w.reads).toContain(path)
  expect(await buttonKeys(ui, 'hook:')).toEqual(['hook:user:Stop:0:0'])
  // showing a file goes through atlas.py, which knows the system's own way
  await ui.press({ key: 'open:hf:user' })
  await w.clock.settle()
  expect(w.runs.some(r => r[0] === 'python' && r[3] === 'reveal' && r[4] === 'C:/Users/t/.claude/settings.json')).toBe(true)
  expect(w.runs.some(r => r[0] === '/usr/bin/open')).toBe(false)
  await ui.unmount()
})

both('a Mac session is as before: the system Python, and the Mac\'s own commands', async ($, on, surface) => {
  const { w, ui } = await openHooks($, on, surface)
  expect((w.state.ctx as { win?: boolean }).win).toBe(false)
  expect(w.runs.find(r => r[3] === 'index')?.[0]).toBe('/usr/bin/python3')
  await ui.press({ key: 'open:hf:user' })
  await w.clock.settle()
  expect(w.runs).toContainEqual(['/usr/bin/open', '-R', USER_SETTINGS])
  await ui.unmount()
})

both('Windows: atlas.py runs under the newest real interpreter uv has installed, not the launcher on PATH', async ($, on, surface) => {
  const root = 'C:/Users/t/.local/share/uv/python'
  const files: Record<string, string> = {}
  for (const v of ['cpython-3.10.22-windows-x86_64-none', 'cpython-3.12.15-windows-x86_64-none', 'cpython-3.8.20-windows-x86_64-none']) files[`${root}/${v}/python.exe`] = ''
  // a folder with no interpreter in it, newer than the rest: passed over
  files[`${root}/cpython-3.13.16-windows-x86_64-none/README`] = ''
  const w = world(on, { win: true, files, listed: { [root]: ['cpython-3.8.20-windows-x86_64-none', 'cpython-3.13.16-windows-x86_64-none', 'cpython-3.10.22-windows-x86_64-none', 'cpython-3.12.15-windows-x86_64-none', 'notes'] } })
  await start($, w, WIN_CWD)
  expect(w.runs.find(r => r[3] === 'index')?.[0]).toBe(`${root}/cpython-3.12.15-windows-x86_64-none/python.exe`)
  expect(surface).toBeDefined()
})

// ---------- the make of a button follows what it does ----------

describe('views.tsx > buttonKind', () => {
  test('one of a set is a pick, whatever it says', () => {
    for (const label of ['记忆', '本会话', '下一轮', '删除']) expect(buttonKind(label, true), label).toBe('pick')
  })

  test('every button of the pane falls in the kind its job belongs to', () => {
    const kinds: Record<string, string[]> = {
      look: ['刷新', '重新扫描', '重新读取', '重新载入', '打开', '复制路径', '复制内容', '复制原文', '复制 ID', '复制最近一次的内容', '在 Finder 显示', '用编辑器打开', '上一页', '下一页', '更多（还有 370 条）', '← 返回', '在整理看板里看', '打开第 201 行'],
      make: ['+ 新 hook', '+ 加一行', '+', '添加', '写入 frontmatter', '补 frontmatter', '生成 MEMORY.md', '加入索引', '应用', '改写这一段', '改写说明'],
      switch: ['关闭', '开启', '关闭这一段', '重新开启', '开启这一段', '关闭这一种', '恢复原文', '恢复', '归档（只是从列表里收起，不动文件）', '取消归档', '阅读', '编辑'],
      remove: ['删除', '确认删除（不进回收站）', '确认删除（7 天后自动清空）', '立即清空', '确认永久删除', '删掉这条链接', '清空重写', '放弃', '×'],
      back: ['取消', '撤销', '撤销上次修改', '知道了'],
    }
    for (const [kind, labels] of Object.entries(kinds)) for (const label of labels) expect(buttonKind(label, false), label).toBe(kind)
  })
})

both('排版: on the desktop buttons of one job share a make, and jobs differ; a delete has a dashed edge', async ($, on, surface) => {
  const { ui } = await openHooks($, on, surface)
  const pill = async (key: string) => (await ui.findAll({ type: 'Box' })).find(b => b.key === `pill:${key}`)
  if (surface !== 'desktop') {
    expect(await pill('h-reload')).toBeUndefined()
    await ui.unmount()
    return
  }
  const reload = await pill('h-reload')
  const open = await pill('open:hf:user')
  const fresh = await pill('hook-new')
  const tab = await pill('tab:memory')
  // looking (reload, open) is one make; making (new) another; a page's tab a third
  expect(reload?.props.backgroundColor).toBe(open?.props.backgroundColor)
  expect(new Set([reload?.props.backgroundColor, fresh?.props.backgroundColor, tab?.props.backgroundColor]).size).toBe(3)
  await ui.press({ key: 'hook:user:PreToolUse:0:0' })
  const del = await pill('hk-del')
  const copy = await pill('hk-copy')
  expect(del?.props.borderStyle).toBe('dashed')
  expect(copy?.props.borderStyle).toBe('round')
  expect(del?.props.backgroundColor).not.toBe(copy?.props.backgroundColor)
  // the page's main action stays the surface's own primary button
  expect(await pill('hk-toggle')).toBeUndefined()
  expect((await ui.find({ key: 'hk-toggle' }))?.props.variant).toBe('primary')
  await ui.unmount()
})

// ---------- skins ----------

describe('skins.ts', () => {
  test('手帐 is the first skin and the one an unknown id falls back to', () => {
    expect(SKINS[0]).toBe(JOURNAL)
    expect(skinOf(undefined)).toBe(JOURNAL)
    expect(skinOf('no-such-skin')).toBe(JOURNAL)
    // 原版 was a skin until 2026-11-13: a machine that kept it wears 手帐
    expect(skinOf('plain')).toBe(JOURNAL)
    expect(skinOf('folio')).toBe(ARCHIVE)
    expect(skinOf('riviera')).toBe(RIVIERA_SKIN)
    expect(skinOf('porto')).toBe(PORTO_SKIN)
    expect(SKINS.map(s => s.name)).toEqual(['手帐', '档案', '地中海', '海岸小镇'])
    expect(new Set(SKINS.map(s => s.id)).size).toBe(SKINS.length)
    expect(new Set(SKINS.map(s => s.name)).size).toBe(SKINS.length)
  })

  test('the 手帐 skin holds the look as it was settled: five strips, six makes of button, paper', () => {
    expect(JOURNAL.paper).toBe('washi')
    expect(JOURNAL.sheets.map(s => s.head)).toEqual(['#A9DBC2', '#F2D98A', '#EDB4C6', '#A9C8EC', '#BDB5EA'])
    expect(JOURNAL.rows.map(r => r.tint)).toEqual(['#FFF4CC', '#FCE4EC', '#DFF3E9', '#E1EEFB', '#ECE9FB'])
    expect(Object.keys(JOURNAL.buttons ?? {}).sort()).toEqual(['back', 'look', 'make', 'pick', 'remove', 'switch'])
    expect(JOURNAL.buttons?.remove.border).toBe('dashed')
    expect(JOURNAL.card).toEqual({ fill: '#FBF6EA', edge: '#E6DCC6', border: 'round' })
    // every fill a skin names comes with ink of its own, so it reads on a light and a dark theme
    for (const skin of SKINS) {
      for (const chip of Object.values(skin.chips)) expect(chip.fg).toMatch(/^#[0-9A-F]{6}$/)
      if (skin.rows.length) expect(skin.ink).not.toBeNull()
      if (skin.buttons) for (const make of Object.values(skin.buttons)) expect(make.ink).toMatch(/^#[0-9A-F]{6}$/)
    }
  })

  test('the 档案 skin is a look of its own: its own hand for the paper, five Morandi strips and sheets, six makes of button', () => {
    expect(ARCHIVE.paper).toBe('folio')
    expect(ARCHIVE.pageName).toBe('档案页')
    expect(ARCHIVE.rows.length).toBe(5)
    expect(ARCHIVE.sheets.length).toBe(5)
    expect(Object.keys(ARCHIVE.buttons ?? {}).sort()).toEqual(['back', 'look', 'make', 'pick', 'remove', 'switch'])
    expect(ARCHIVE.buttons?.remove.border).toBe('dashed')
    expect(ARCHIVE.card?.border).toBe('double')
    // it shares no fill with 手帐: neither a strip nor a button's
    const fills = (skin: typeof ARCHIVE) => [...skin.rows.map(r => r.tint), ...Object.values(skin.buttons ?? {}).map(b => b.fill)]
    expect(fills(ARCHIVE).filter(f => fills(JOURNAL).includes(f))).toEqual([])
    // each job's button differs from the others in fill, so a make is told at a glance
    expect(new Set(Object.values(ARCHIVE.buttons ?? {}).map(b => b.fill)).size).toBe(6)
  })

  test('the 地中海 skin is a look of its own: the hand of a magazine, five strips from white to periwinkle, a square-cornered card', () => {
    expect(RIVIERA_SKIN.paper).toBe('riviera')
    expect(RIVIERA_SKIN.pageName).toBe('封面')
    expect(RIVIERA_SKIN.pageTitle).toBe('Atlas')
    expect(RIVIERA_SKIN.rows.length).toBe(5)
    expect(RIVIERA_SKIN.rows[0]?.tint).toBe('#FFFFFF')
    expect(RIVIERA_SKIN.sheets.length).toBe(5)
    expect(Object.keys(RIVIERA_SKIN.buttons ?? {}).sort()).toEqual(['back', 'look', 'make', 'pick', 'remove', 'switch'])
    expect(RIVIERA_SKIN.buttons?.remove.border).toBe('dashed')
    expect(RIVIERA_SKIN.card?.border).toBe('single')
    expect(new Set(Object.values(RIVIERA_SKIN.buttons ?? {}).map(b => b.fill)).size).toBe(6)
    // white apart, it shares no strip and no button's fill with the other skins
    const fills = (skin: typeof ARCHIVE) => [...skin.rows.map(r => r.tint), ...Object.values(skin.buttons ?? {}).map(b => b.fill)].filter(f => f !== '#FFFFFF')
    for (const other of [JOURNAL, ARCHIVE]) expect(fills(RIVIERA_SKIN).filter(f => fills(other).includes(f)), other.id).toEqual([])
    // every skin has paper, a name for its page, sheets and all six makes: the pane has no skinless look to fall to
    for (const skin of SKINS) {
      expect(skin.paper, skin.id).not.toBeNull()
      expect(skin.pageName.length, skin.id).toBeGreaterThan(0)
      expect(skin.sheets.length, skin.id).toBeGreaterThan(0)
      expect(skin.buttons, skin.id).not.toBeNull()
      expect(skin.card, skin.id).not.toBeNull()
    }
  })

  test('the 海岸小镇 skin is a look of its own: the hand of a postcard, five pale walls for strips, a quiet mark for off', () => {
    expect(PORTO_SKIN.paper).toBe('porto')
    expect(PORTO_SKIN.pageName).toBe('明信片')
    expect(PORTO_SKIN.pageTitle).toBe('Atlas')
    expect(PORTO_SKIN.rows.length).toBe(5)
    expect(PORTO_SKIN.sheets.length).toBe(5)
    expect(new Set(PORTO_SKIN.rows.map(r => r.tint)).size).toBe(5)
    expect(Object.keys(PORTO_SKIN.buttons ?? {}).sort()).toEqual(['back', 'look', 'make', 'pick', 'remove', 'switch'])
    expect(PORTO_SKIN.buttons?.remove.border).toBe('dashed')
    expect(new Set(Object.values(PORTO_SKIN.buttons ?? {}).map(b => b.fill)).size).toBe(6)
    // no button's fill is a strip's: a button stands out on whichever row it is on
    const tints = PORTO_SKIN.rows.map(r => r.tint)
    expect(Object.values(PORTO_SKIN.buttons ?? {}).filter(b => tints.includes(b.fill))).toEqual([])
    // white apart, it shares no strip and no button's fill with the other skins
    const fills = (skin: typeof ARCHIVE) => [...skin.rows.map(r => r.tint), ...Object.values(skin.buttons ?? {}).map(b => b.fill)].filter(f => f !== '#FFFFFF')
    for (const other of [JOURNAL, ARCHIVE, RIVIERA_SKIN]) expect(fills(PORTO_SKIN).filter(f => fills(other).includes(f)), other.id).toEqual([])
  })

  test('whatever a skin writes reads on what it is written on: 4.5 to 1 at least', () => {
    const light = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
    }
    const ratio = (a: string, b: string) => (Math.max(light(a), light(b)) + 0.05) / (Math.min(light(a), light(b)) + 0.05)
    for (const skin of SKINS) {
      const pairs: [string, string, string][] = []
      for (const [tone, chip] of Object.entries(skin.chips)) pairs.push([`chip ${tone}`, chip.fg, chip.bg])
      for (const [kind, make] of Object.entries(skin.buttons ?? {})) pairs.push([`button ${kind}`, make.ink, make.fill])
      if (skin.ink && skin.inkSoft) {
        for (const [i, row] of skin.rows.entries()) pairs.push([`row ${i}`, skin.ink, row.tint], [`row ${i} note`, skin.inkSoft, row.tint])
        for (const [i, sheet] of skin.sheets.entries()) pairs.push([`sheet ${i} head`, skin.ink, sheet.head], [`sheet ${i}`, skin.ink, sheet.body], [`sheet ${i} tail`, skin.inkSoft, sheet.body])
        if (skin.card) pairs.push(['card', skin.ink, skin.card.fill], ['card note', skin.inkSoft, skin.card.fill])
      }
      for (const [what, ink, fill] of pairs) expect(ratio(ink, fill), `${skin.id}: ${what} (${ink} on ${fill})`).toBeGreaterThanOrEqual(4.5)
    }
  })
})

both('皮肤: the desktop pane wears 手帐 by default; the pick is one menu in the refresh row, and is remembered', async ($, on, surface) => {
  const { w, ui } = await openPrompt($, on, surface)
  const boxes = async (prefix: string) => (await ui.findAll({ type: 'Box' })).filter(b => typeof b.key === 'string' && b.key.startsWith(prefix))
  if (surface !== 'desktop') {
    // a skin is a matter of the desktop: the terminal has no picker
    expect(await ui.find({ key: 'skin' })).toBeUndefined()
    await ui.unmount()
    return
  }
  // the picker is one menu, folded, the last thing in the row the refresh button is in
  const picker = await ui.find({ key: 'skin' })
  expect(picker?.type).toBe('Select')
  expect(picker?.props.value).toBe('journal')
  expect((picker?.props.options as { value: string; label: string }[]).map(o => o.label)).toEqual(SKINS.map(s => s.name))
  const head = await ui.find({ type: 'Box', key: 'head' })
  const inHead = (head?.children ?? []).filter((c): c is { type: string } => typeof c === 'object' && c !== null && 'type' in c).map(c => c.type)
  expect(inHead).toEqual(['Box', 'Select'])
  expect(head?.props.justifyContent).toBe('space-between')
  expect(await ui.find({ type: 'Box', key: 'skins' })).toBeUndefined()
  expect((await boxes('pill:')).length).toBeGreaterThan(4)
  expect((await ui.findAll({ type: 'Svg' })).length).toBeGreaterThan(1)
  expect((await boxes('strip:sec:')).every(b => typeof b.props.backgroundColor === 'string')).toBe(true)

  // 原版 is no longer offered
  expect((picker?.props.options as { value: string }[]).map(o => o.value)).toEqual(['journal', 'folio', 'riviera', 'porto'])
  const journalTints = JOURNAL.rows.map(r => r.tint)
  expect((await boxes('strip:sec:')).every(b => journalTints.includes(String(b.props.backgroundColor)))).toBe(true)

  await ui.select({ key: 'skin', value: 'folio' })
  expect(normalizePrefs(w.store.get('prefs')).skin).toBe('folio')
  expect(await value(ui, 'skin')).toBe('folio')
  const strips = await boxes('strip:sec:')
  expect(strips.length).toBeGreaterThan(1)
  expect(strips.some(b => journalTints.includes(String(b.props.backgroundColor)))).toBe(false)
  // the layout is the same under any skin: a section is still found and opened by its row
  await ui.press({ key: 'sec:tone' })
  await ui.press({ key: 'back' })

  await ui.select({ key: 'skin', value: 'journal' })
  expect(normalizePrefs(w.store.get('prefs')).skin).toBe('journal')
  expect((await boxes('strip:sec:')).every(b => journalTints.includes(String(b.props.backgroundColor)))).toBe(true)
  expect((await ui.findAll({ type: 'Svg' })).length).toBeGreaterThan(1)
  await ui.unmount()
})

both('皮肤: 档案 draws the page in its own hand: numbered headings, its strips and marks, a double-ruled card, its board', async ($, on, surface) => {
  const { w, ui } = await openPrompt($, on, surface)
  if (surface !== 'desktop') {
    expect(await ui.find({ key: 'skin' })).toBeUndefined()
    await ui.unmount()
    return
  }
  const boxes = async (prefix: string) => (await ui.findAll({ type: 'Box' })).filter(b => typeof b.key === 'string' && b.key.startsWith(prefix))
  const pictures = async () => (await ui.findAll({ type: 'Svg' })).map(p => ({ alt: String(p.props.alt), source: String(p.props.source) }))
  await ui.select({ key: 'skin', value: 'folio' })
  expect(normalizePrefs(w.store.get('prefs')).skin).toBe('folio')
  expect(await value(ui, 'skin')).toBe('folio')

  // the illustration is the archive page, and its fold button says so
  const drawn = await pictures()
  expect(drawn.some(p => /^档案页插图「Atlas 档案」/.test(p.alt))).toBe(true)
  expect(drawn.some(p => /^手帐插图/.test(p.alt))).toBe(false)
  expect((await ui.find({ key: 'journal-hide' }))?.props.label).toBe('收起档案页')
  // no piece of the other hand is left on the page: no dot grid, no tape
  expect(drawn.length).toBeGreaterThan(2)
  expect(drawn.filter(p => p.source.includes('<pattern')).map(p => p.alt)).toEqual([])
  expect(drawn.some(p => p.alt.startsWith('象牙纸'))).toBe(true)
  expect(drawn.some(p => p.source.includes('>01</text>'))).toBe(true)

  // the strips take the skin's colours in turn
  const strips = await boxes('strip:sec:')
  expect(strips.length).toBeGreaterThan(1)
  const tints = ARCHIVE.rows.map(r => r.tint)
  expect(strips.every(b => tints.includes(String(b.props.backgroundColor)))).toBe(true)
  expect(strips[0]?.props.backgroundColor).not.toBe(strips[1]?.props.backgroundColor)
  // and every button its make
  const fills = Object.values(ARCHIVE.buttons ?? {}).map(b => b.fill)
  const pills = await boxes('pill:')
  expect(pills.length).toBeGreaterThan(4)
  expect(pills.every(b => fills.includes(String(b.props.backgroundColor)))).toBe(true)

  // a set of choices sits in a double-ruled card
  await ui.press({ key: 'sec:tone' })
  const cards = await boxes('card:')
  expect(cards.length).toBeGreaterThan(0)
  expect(cards.every(b => b.props.borderStyle === 'double' && b.props.backgroundColor === ARCHIVE.card?.fill)).toBe(true)
  await ui.press({ key: 'back' })

  // the board's columns are the skin's sheets
  await ui.press({ key: 'tab:skills' })
  const board = await ui.find({ type: 'Client', key: 'board:skills' })
  if (board) expect((board.props.props as { paper?: { sheets: unknown; ink: string } }).paper).toEqual({ sheets: ARCHIVE.sheets, ink: ARCHIVE.ink, inkSoft: ARCHIVE.inkSoft })

  await ui.press({ key: 'journal-hide' })
  expect((await ui.find({ key: 'journal-show' }))?.props.label).toBe('展开档案页')
  await ui.unmount()
})

both('皮肤: a session starts in the skin this machine keeps', async ($, on, surface) => {
  const { ui } = await openPrompt($, on, surface, { store: { prefs: { skin: 'folio' } } })
  if (surface === 'desktop') {
    expect(await value(ui, 'skin')).toBe('folio')
    const tints = ARCHIVE.rows.map(r => r.tint)
    const strips = (await ui.findAll({ type: 'Box' })).filter(b => typeof b.key === 'string' && b.key.startsWith('strip:sec:'))
    expect(strips.length).toBeGreaterThan(1)
    expect(strips.every(b => tints.includes(String(b.props.backgroundColor)))).toBe(true)
  }
  await ui.unmount()
})

both('皮肤: a machine that kept 原版, which is no longer a skin, wears 手帐', async ($, on, surface) => {
  const { ui } = await openPrompt($, on, surface, { store: { prefs: { skin: 'plain' } } })
  if (surface === 'desktop') {
    expect(await value(ui, 'skin')).toBe('journal')
    expect((await ui.findAll({ type: 'Box' })).some(b => typeof b.key === 'string' && b.key.startsWith('pill:'))).toBe(true)
    expect((await ui.findAll({ type: 'Svg' })).some(p => /^手帐插图/.test(String(p.props.alt)))).toBe(true)
  }
  await ui.unmount()
})

both('皮肤: 地中海 draws the page as a magazine: its cover, numbered headings under a thick rule, its strips, a square card, its board', async ($, on, surface) => {
  const { w, ui } = await openPrompt($, on, surface)
  if (surface !== 'desktop') {
    await ui.unmount()
    return
  }
  const boxes = async (prefix: string) => (await ui.findAll({ type: 'Box' })).filter(b => typeof b.key === 'string' && b.key.startsWith(prefix))
  const pictures = async () => (await ui.findAll({ type: 'Svg' })).map(p => ({ alt: String(p.props.alt), source: String(p.props.source) }))
  await ui.select({ key: 'skin', value: 'riviera' })
  expect(normalizePrefs(w.store.get('prefs')).skin).toBe('riviera')
  expect(await value(ui, 'skin')).toBe('riviera')

  const drawn = await pictures()
  expect(drawn.some(p => /^杂志页插图「Atlas」/.test(p.alt))).toBe(true)
  expect(drawn.some(p => /^(手帐|档案页)插图/.test(p.alt))).toBe(false)
  expect((await ui.find({ key: 'journal-hide' }))?.props.label).toBe('收起封面')
  // nothing of the other hands: no dot-grid paper, no ivory paper (the cover's own awning and tiles are repeats of its own)
  expect(drawn.filter(p => /点阵纸|atlas-journal-/.test(p.alt + p.source)).map(p => p.alt)).toEqual([])
  expect(drawn.filter(p => p.source.includes('<pattern')).every(p => /^杂志页插图/.test(p.alt) && /id="atlas-riviera-/.test(p.source))).toBe(true)
  expect(drawn.some(p => p.alt.startsWith('象牙纸'))).toBe(false)
  expect(drawn.some(p => p.alt.startsWith('白纸'))).toBe(true)
  expect(drawn.some(p => p.source.includes('font-style="italic"') && p.source.includes('>01</text>'))).toBe(true)

  const strips = await boxes('strip:sec:')
  expect(strips.length).toBeGreaterThan(1)
  const tints = RIVIERA_SKIN.rows.map(r => r.tint)
  expect(strips.every(b => tints.includes(String(b.props.backgroundColor)))).toBe(true)
  const fills = Object.values(RIVIERA_SKIN.buttons ?? {}).map(b => b.fill)
  const pills = await boxes('pill:')
  expect(pills.length).toBeGreaterThan(4)
  expect(pills.every(b => fills.includes(String(b.props.backgroundColor)))).toBe(true)

  await ui.press({ key: 'sec:tone' })
  const cards = await boxes('card:')
  expect(cards.length).toBeGreaterThan(0)
  expect(cards.every(b => b.props.borderStyle === 'single' && b.props.backgroundColor === RIVIERA_SKIN.card?.fill)).toBe(true)
  await ui.press({ key: 'back' })

  await ui.press({ key: 'tab:skills' })
  const board = await ui.find({ type: 'Client', key: 'board:skills' })
  if (board) expect((board.props.props as { paper?: unknown }).paper).toEqual({ sheets: RIVIERA_SKIN.sheets, ink: RIVIERA_SKIN.ink, inkSoft: RIVIERA_SKIN.inkSoft })
  await ui.unmount()
})

both('皮肤: 海岸小镇 draws the page as a postcard: its view of the town, a house by each heading, pale walls for strips, its board', async ($, on, surface) => {
  const { w, ui } = await openPrompt($, on, surface)
  if (surface !== 'desktop') {
    await ui.unmount()
    return
  }
  const boxes = async (prefix: string) => (await ui.findAll({ type: 'Box' })).filter(b => typeof b.key === 'string' && b.key.startsWith(prefix))
  const pictures = async () => (await ui.findAll({ type: 'Svg' })).map(p => ({ alt: String(p.props.alt), source: String(p.props.source) }))
  await ui.select({ key: 'skin', value: 'porto' })
  expect(normalizePrefs(w.store.get('prefs')).skin).toBe('porto')
  expect(await value(ui, 'skin')).toBe('porto')

  const drawn = await pictures()
  expect(drawn.some(p => /^明信片插图「Atlas」/.test(p.alt))).toBe(true)
  expect(drawn.some(p => /^(手帐|档案页|杂志页)插图/.test(p.alt))).toBe(false)
  expect((await ui.find({ key: 'journal-hide' }))?.props.label).toBe('收起明信片')
  // nothing of the other hands' paper
  expect(drawn.filter(p => /^(点阵纸|象牙纸|白纸)/.test(p.alt)).map(p => p.alt)).toEqual([])
  expect(drawn.some(p => p.alt.startsWith('奶油色的纸'))).toBe(true)

  const strips = await boxes('strip:sec:')
  expect(strips.length).toBeGreaterThan(1)
  const tints = PORTO_SKIN.rows.map(r => r.tint)
  expect(strips.every(b => tints.includes(String(b.props.backgroundColor)))).toBe(true)
  const fills = Object.values(PORTO_SKIN.buttons ?? {}).map(b => b.fill)
  const pills = await boxes('pill:')
  expect(pills.length).toBeGreaterThan(4)
  expect(pills.every(b => fills.includes(String(b.props.backgroundColor)))).toBe(true)

  await ui.press({ key: 'sec:tone' })
  const cards = await boxes('card:')
  expect(cards.length).toBeGreaterThan(0)
  expect(cards.every(b => b.props.borderStyle === 'round' && b.props.backgroundColor === PORTO_SKIN.card?.fill)).toBe(true)
  await ui.press({ key: 'back' })

  await ui.press({ key: 'tab:skills' })
  const board = await ui.find({ type: 'Client', key: 'board:skills' })
  if (board) expect((board.props.props as { paper?: unknown }).paper).toEqual({ sheets: PORTO_SKIN.sheets, ink: PORTO_SKIN.ink, inkSoft: PORTO_SKIN.inkSoft })
  await ui.unmount()
})

// ---------- 工具: the pure half ----------

describe('manage.ts 工具', () => {
  const none: AtlasPromptEdits = { off: [], rewrite: {}, extra: [] }
  // names every object answers to: none of them may be read off the prototype, or written to it
  const ODD_NAMES = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']

  const seen = new Map<string, ToolSeen>([
    ['Bash', { text: 'Runs a shell command.', isDeferred: false, provider: 'engine', lastMs: 1 }],
    ['WebFetch', { text: 'Fetches a page.', isDeferred: true, provider: 'engine', lastMs: 1 }],
    ['mcp__reader__book_read', { text: 'Reads a book.', isDeferred: true, provider: 'mcp:reader', lastMs: 1 }],
    ['mcp__plots__chart', { text: 'Draws a chart.', isDeferred: true, provider: 'plots', lastMs: 1 }],
  ])
  const listed: ToolListed[] = [
    { name: 'Bash', mcp: false },
    { name: 'Read', mcp: false },
    { name: 'WebFetch', mcp: false },
    { name: 'mcp__reader__book_read', mcp: true },
    { name: 'mcp__reader__book_toc', mcp: true },
    { name: 'mcp__plots__chart', mcp: true },
  ]

  test('normalizeEdits keeps well-formed placements and rewrites, and no empty record', () => {
    const got = normalizeEdits({
      toolPlace: { Bash: 'off', Read: 'pin', WebFetch: 'defer', Glob: 'on', Grep: 3, Edit: null },
      toolRewrite: { Bash: 'Runs it.', Read: '', Glob: '   ', Grep: 7 },
    })
    expect(got).toEqual({ off: [], rewrite: {}, extra: [], toolPlace: { Bash: 'off', Read: 'pin', WebFetch: 'defer' }, toolRewrite: { Bash: 'Runs it.' } })
    expect(normalizeEdits({ toolPlace: {}, toolRewrite: {} })).toEqual(none)
    expect(normalizeEdits({ toolPlace: ['off'], toolRewrite: 'x' })).toEqual(none)
    expect(normalizeEdits({ toolPlace: { Bash: 'on' }, toolRewrite: { Bash: ' ' } })).toEqual(none)
  })

  test('edits stored before the 工具 page have neither field, and read as no change to any tool', () => {
    const stored = { off: ['tone'], rewrite: { intro: 'x' }, extra: [], injectOff: ['date'], rename: 'Robin' }
    const old = normalizeEdits(stored)
    expect(old).toEqual(stored)
    expect('toolPlace' in old).toBe(false)
    expect('toolRewrite' in old).toBe(false)
    expect(toolPlaceOf(old, 'Bash')).toBeUndefined()
    expect(toolRewriteOf(old, 'Bash')).toBeUndefined()
    expect(toolPlaceOf(undefined, 'Bash')).toBeUndefined()
    expect(toolRewriteOf(undefined, 'Bash')).toBeUndefined()
    expect(toolNamesIn(old)).toEqual([])
    expect(toolNamesIn(undefined)).toEqual([])
    const base = { description: 'Runs a command.' }
    expect(toolAnswer(old, 'Bash', base)).toBe(base)
    expect(mergeEdits(old, none)).toEqual(old)
    // the prefs and the switches an earlier version stored
    const prefs = normalizePrefs({ prompt: { global: stored, byProject: { '/work/proj': { off: ['intro'], rewrite: {}, extra: [] } } } })
    const sw: AtlasSwitches = { skillsOff: [], skillDirs: {}, memory: {}, files: {}, prompt: { off: ['tone'], rewrite: {}, extra: [] } }
    const all = levelEdits(prefs, '/work/proj', sw)
    expect(toolLevelsText(all, 'Bash')).toBe('')
    expect(toolRows(null, new Map(), all.session, [...toolNamesIn(all.project), ...toolNamesIn(all.global)])).toEqual([])
  })

  test('mergeEdits: the project\'s placement and rewrite stand over the global ones, tool by tool', () => {
    const global: AtlasPromptEdits = { ...none, toolPlace: { Bash: 'off', WebFetch: 'pin' }, toolRewrite: { Bash: 'global bash', Read: 'global read' } }
    const project: AtlasPromptEdits = { ...none, toolPlace: { Bash: 'defer', Read: 'off' }, toolRewrite: { Bash: 'project bash' } }
    const merged = mergeEdits(global, project)
    expect(merged.toolPlace).toEqual({ Bash: 'defer', WebFetch: 'pin', Read: 'off' })
    expect(merged.toolRewrite).toEqual({ Bash: 'project bash', Read: 'global read' })
    expect(mergeEdits(global, undefined)).toBe(global)
    expect(mergeEdits(global, none).toolPlace).toEqual({ Bash: 'off', WebFetch: 'pin' })
    expect(mergeEdits(none, project).toolRewrite).toEqual({ Bash: 'project bash' })
    expect(mergeEdits(none, none)).toEqual(none)
    // neither level was touched by the merge
    expect(global.toolPlace).toEqual({ Bash: 'off', WebFetch: 'pin' })
    expect(project.toolRewrite).toEqual({ Bash: 'project bash' })
  })

  test('setToolPlace and setToolRewrite set, replace and take back, leaving no empty record behind', () => {
    const one = setToolPlace(none, 'Bash', 'off')
    expect(one).toEqual({ off: [], rewrite: {}, extra: [], toolPlace: { Bash: 'off' } })
    expect(none).toEqual({ off: [], rewrite: {}, extra: [] })
    expect(setToolPlace(one, 'Bash', 'pin').toolPlace).toEqual({ Bash: 'pin' })
    expect(setToolPlace(one, 'Read', 'defer').toolPlace).toEqual({ Bash: 'off', Read: 'defer' })
    expect(one.toolPlace).toEqual({ Bash: 'off' })
    expect(setToolPlace(one, 'Bash', null)).toEqual(none)
    expect(setToolPlace(none, 'Bash', null)).toEqual(none)
    const two = setToolRewrite(one, 'Bash', 'Runs it.')
    expect(two).toEqual({ off: [], rewrite: {}, extra: [], toolPlace: { Bash: 'off' }, toolRewrite: { Bash: 'Runs it.' } })
    expect(setToolRewrite(two, 'Bash', 'Again.').toolRewrite).toEqual({ Bash: 'Again.' })
    expect(setToolRewrite(two, 'Bash', null)).toEqual(one)
    expect(toolNamesIn(setToolRewrite(one, 'Read', 'r'))).toEqual(['Bash', 'Read'])
    // the other edits keep both, and these keep the others
    expect(setOff(two, 'tone', true).toolPlace).toEqual({ Bash: 'off' })
    expect(setRewrite(two, 'tone', 'x').toolRewrite).toEqual({ Bash: 'Runs it.' })
    expect(setRename(setInjectOff(two, 'date', true), 'Robin').toolPlace).toEqual({ Bash: 'off' })
    const full = setToolPlace(setRename(setInjectOff(setOff(none, 'tone', true), 'date', true), 'Robin'), 'Bash', 'off')
    expect(full).toEqual({ off: ['tone'], rewrite: {}, extra: [], injectOff: ['date'], rename: 'Robin', toolPlace: { Bash: 'off' } })
    // a section's rewrite and a tool's are two things, even under one name
    expect(setRewrite(none, 'Bash', 'section').toolRewrite).toBeUndefined()
    expect(setToolRewrite(none, 'tone', 'tool').rewrite).toEqual({})
  })

  test('ToolSearch is never placed: no placement is stored for it, and a stored one is not read', () => {
    expect(setToolPlace(none, 'ToolSearch', 'off')).toEqual(none)
    expect(setToolPlace(none, 'ToolSearch', 'defer')).toEqual(none)
    const stored = normalizeEdits({ toolPlace: { ToolSearch: 'off', Bash: 'off' }, toolRewrite: { ToolSearch: 'Find tools.' } })
    expect(toolPlaceOf(stored, 'ToolSearch')).toBeUndefined()
    expect(toolPlaceOf(stored, 'Bash')).toBe('off')
    // its description may be rewritten like any other
    expect(toolAnswer(stored, 'ToolSearch', { description: 'Loads tools.' })).toEqual({ description: 'Find tools.' })
    expect(toolRow('ToolSearch', null, new Map(), stored).place).toBeUndefined()
    expect(toolMarks({ session: stored, project: none, global: none }, 'ToolSearch').map(m => m.what)).toEqual(['rewritten'])
    // a press on its page takes the stored one out
    expect(setToolPlace(stored, 'ToolSearch', 'pin').toolPlace).toEqual({ Bash: 'off' })
  })

  test('a tool named like something every object has is a name like any other', () => {
    const base = { description: 'own text' }
    const empty: AtlasPromptEdits = { ...none, toolPlace: {}, toolRewrite: {} }
    for (const name of ODD_NAMES) {
      // nothing is set: nothing is read off the prototype
      expect(toolPlaceOf(none, name), name).toBeUndefined()
      expect(toolRewriteOf(none, name), name).toBeUndefined()
      expect(toolPlaceOf(empty, name), name).toBeUndefined()
      expect(toolRewriteOf(empty, name), name).toBeUndefined()
      expect(toolAnswer(empty, name, base), name).toBe(base)
      expect(toolRow(name, null, new Map(), empty).where, name).toBe('unknown')
      // set, it is kept under its own name and read back
      const set = setToolRewrite(setToolPlace(none, name, 'off'), name, 'mine')
      expect(toolPlaceOf(set, name), name).toBe('off')
      expect(toolRewriteOf(set, name), name).toBe('mine')
      expect(Object.keys(set.toolPlace ?? {}), name).toEqual([name])
      expect(toolNamesIn(set), name).toEqual([name])
      expect(toolAnswer(set, name, base), name).toEqual({ description: 'mine', isDeferred: true })
      expect(toolRows(null, new Map(), set).map(x => [x.name, x.where]), name).toEqual([[name, 'off']])
      // no other tool is touched by it
      expect(toolPlaceOf(set, 'Bash'), name).toBeUndefined()
      for (const other of ODD_NAMES) if (other !== name) expect(toolPlaceOf(set, other), `${name} / ${other}`).toBeUndefined()
      // it comes back from the store's JSON, and through a merge of two levels
      const back = normalizeEdits(JSON.parse(JSON.stringify(set)) as unknown)
      expect(toolPlaceOf(back, name), name).toBe('off')
      expect(toolRewriteOf(back, name), name).toBe('mine')
      expect(toolRewriteOf(mergeEdits(none, back), name), name).toBe('mine')
      expect(toolPlaceOf(mergeEdits(back, setToolPlace(none, name, 'pin')), name), name).toBe('pin')
      expect(setToolPlace(setToolRewrite(back, name, null), name, null), name).toEqual(none)
    }
    // and no object anywhere gained a thing
    const fresh: Record<string, unknown> = {}
    expect(Object.getPrototypeOf(fresh)).toBe(Object.prototype)
    expect(fresh.off).toBeUndefined()
    expect(fresh.mine).toBeUndefined()
    expect(Object.keys(Object.prototype)).toEqual([])
    expect(typeof fresh.toString).toBe('function')
  })

  test('toolAnswer: a rewrite replaces the text, a placement says where the tool waits, anything else passes as it came', () => {
    const inList = { description: 'Runs a command.' }
    const behind = { description: 'Fetches a page.', isDeferred: true }
    expect(toolAnswer(none, 'Bash', inList)).toBe(inList)
    expect(toolAnswer(none, 'WebFetch', behind)).toBe(behind)
    // 一直带着: into the prompt's list, wherever the engine had it
    expect(toolAnswer({ ...none, toolPlace: { Bash: 'pin' } }, 'Bash', inList)).toEqual({ description: 'Runs a command.', isDeferred: false })
    expect(toolAnswer({ ...none, toolPlace: { WebFetch: 'pin' } }, 'WebFetch', behind)).toEqual({ description: 'Fetches a page.', isDeferred: false })
    // 用到再加载 and 关掉: behind ToolSearch
    expect(toolAnswer({ ...none, toolPlace: { Bash: 'defer' } }, 'Bash', inList)).toEqual({ description: 'Runs a command.', isDeferred: true })
    expect(toolAnswer({ ...none, toolPlace: { Bash: 'off' } }, 'Bash', inList)).toEqual({ description: 'Runs a command.', isDeferred: true })
    // a rewrite alone keeps the placement beneath
    expect(toolAnswer({ ...none, toolRewrite: { Bash: 'Mine.' } }, 'Bash', inList)).toEqual({ description: 'Mine.' })
    expect(toolAnswer({ ...none, toolRewrite: { WebFetch: 'Mine.' } }, 'WebFetch', behind)).toEqual({ description: 'Mine.', isDeferred: true })
    expect(toolAnswer({ ...none, toolPlace: { Bash: 'off' }, toolRewrite: { Bash: 'Mine.' } }, 'Bash', inList)).toEqual({ description: 'Mine.', isDeferred: true })
    // another tool's edits are not this one's, and whatever else the answer carried stays
    expect(toolAnswer({ ...none, toolPlace: { Read: 'off' }, toolRewrite: { Read: 'x' } }, 'Bash', inList)).toBe(inList)
    expect(toolAnswer({ ...none, toolPlace: { Bash: 'pin' } }, 'Bash', { description: 'd', breakPromptCache: true })).toEqual({ description: 'd', isDeferred: false, breakPromptCache: true })
  })

  test('the refusal names the tool and tells the model what to do, in English, with no "the user" for a rename to catch', () => {
    const text = toolOffDeny('WebFetch')
    expect(text).toContain('The tool WebFetch is switched off in Atlas')
    expect(text).toContain("the person's own setting")
    expect(text).toContain('Do not call it again')
    expect(text).toContain('If the task needs this tool, say so')
    expect(renameUser(text, 'Robin').count).toBe(0)
  })

  test('mcpParts takes an MCP tool\'s name apart: the server, then the tool', () => {
    expect(mcpParts('mcp__reader__book_read')).toEqual({ server: 'reader', tool: 'book_read' })
    expect(mcpParts('mcp__ccd_session__mark_chapter')).toEqual({ server: 'ccd_session', tool: 'mark_chapter' })
    expect(mcpParts('mcp__claude-in-chrome__tabs_context_mcp')).toEqual({ server: 'claude-in-chrome', tool: 'tabs_context_mcp' })
    for (const name of ['Bash', 'mcp__', 'mcp__x', 'mcp____y', 'constructor', '']) expect(mcpParts(name), name).toBeNull()
  })

  test('recordTool keeps the latest the engine gave for each tool, and says whether anything changed', () => {
    heldM.tools.clear()
    expect(recordTool('Bash', 'Runs.', false, 'engine', 1)).toBe(true)
    expect(recordTool('Bash', 'Runs.', false, 'engine', 2)).toBe(false)
    expect(heldM.tools.get('Bash')).toEqual({ text: 'Runs.', isDeferred: false, provider: 'engine', lastMs: 2 })
    expect(recordTool('Bash', 'Runs.', true, 'engine', 3)).toBe(true)
    // an MCP tool behind ToolSearch is described twice: a short text, then the whole one
    expect(recordTool('mcp__g__read', 'Reads.', true, 'mcp:g', 4)).toBe(true)
    expect(recordTool('mcp__g__read', 'Reads a book, chapter by chapter.', true, 'mcp:g', 5)).toBe(true)
    expect(heldM.tools.get('mcp__g__read')?.text).toBe('Reads a book, chapter by chapter.')
    expect(recordTool('constructor', 'Builds.', false, 'engine', 6)).toBe(true)
    expect([...heldM.tools.keys()]).toEqual(['Bash', 'mcp__g__read', 'constructor'])
    heldM.tools.clear()
  })

  test('toolRows: where each tool stands by the engine\'s word, who it comes from, and the one not described yet', () => {
    const rows = toolRows(listed, seen, none)
    expect(rows.map(x => [x.name, x.where, x.kind, x.from, x.server, x.short])).toEqual([
      ['Bash', 'carried', 'engine', '', '', 'Bash'],
      ['Read', 'unknown', 'unknown', '', '', 'Read'],
      ['WebFetch', 'deferred', 'engine', '', '', 'WebFetch'],
      ['mcp__reader__book_read', 'deferred', 'mcp', 'reader', 'reader', 'book_read'],
      // not described yet: an MCP server's by its name, its place unknown
      ['mcp__reader__book_toc', 'unknown', 'mcp', 'reader', 'reader', 'book_toc'],
      // a plugin's own tool is no MCP server's, whatever its name looks like: a row of its own
      ['mcp__plots__chart', 'deferred', 'plugin', 'plots', '', 'mcp__plots__chart'],
    ])
    expect(rows.map(toolOrigin)).toEqual(['引擎自带', '', '引擎自带', 'MCP：reader', 'MCP：reader', '插件：plots'])
    expect(rows[0]).toMatchObject({ engineDeferred: false, original: 'Runs a shell command.', sent: 'Runs a shell command.', isMissing: false })
    expect(rows[0]?.place).toBeUndefined()
    expect(rows[0]?.rewrite).toBeUndefined()
    expect(rows[1]).toMatchObject({ engineDeferred: null, original: null, sent: null, isMissing: false })
    // the engine did not say who provides it: told from its name
    const unsaid = new Map<string, ToolSeen>([['mcp__x__y', { text: 't', isDeferred: true, provider: '', lastMs: 1 }], ['Odd', { text: 't', isDeferred: false, provider: '', lastMs: 1 }]])
    expect(toolRows(null, unsaid, none).map(x => [x.kind, x.from, x.where])).toEqual([['mcp', 'x', 'deferred'], ['unknown', '', 'carried']])
  })

  test('toolRows: a level\'s placement decides the group and its rewrite what is sent; a tool only a level names is listed too', () => {
    const edits: AtlasPromptEdits = {
      ...none,
      toolPlace: { Bash: 'defer', WebFetch: 'pin', mcp__reader__book_read: 'off', Read: 'pin', Gone: 'off' },
      toolRewrite: { Bash: 'Mine.', Other: 'Text.' },
    }
    const rows = toolRows(listed, seen, edits, ['Elsewhere', 'Bash'])
    const by = (name: string) => rows.find(x => x.name === name)
    expect(rows.map(x => x.name)).toEqual([...listed.map(t => t.name), 'Gone', 'Other', 'Elsewhere'])
    expect(by('Bash')).toMatchObject({ where: 'deferred', place: 'defer', engineDeferred: false, rewrite: 'Mine.', sent: 'Mine.', original: 'Runs a shell command.' })
    expect(by('WebFetch')).toMatchObject({ where: 'carried', place: 'pin', engineDeferred: true })
    expect(by('mcp__reader__book_read')).toMatchObject({ where: 'off', place: 'off' })
    // pinned before it was ever described: carried, with no size yet
    expect(by('Read')).toMatchObject({ where: 'carried', sent: null, isMissing: false })
    // named by a level, and no tool of this session
    expect(by('Gone')).toMatchObject({ where: 'off', isMissing: true, kind: 'unknown' })
    expect(by('Other')).toMatchObject({ where: 'unknown', isMissing: true, sent: 'Text.', original: null })
    expect(by('Elsewhere')).toMatchObject({ where: 'unknown', isMissing: true, sent: null })
    // with the list never asked for, nothing is called missing
    expect(toolRows(null, seen, edits).find(x => x.name === 'Gone')?.isMissing).toBe(false)
    expect(toolRows(null, new Map(), none)).toEqual([])
    expect(toolRow('Bash', listed, seen, edits)).toEqual(by('Bash'))
    expect(toolRow('Nowhere', null, new Map(), none)).toMatchObject({ name: 'Nowhere', where: 'unknown', isMissing: false })
  })

  test('toolMarks, toolLevelsText and toolLevelState say what each level does to a tool', () => {
    const prefs = normalizePrefs({
      prompt: {
        global: { toolPlace: { Bash: 'off', WebFetch: 'pin' }, toolRewrite: { Read: 'g' } },
        byProject: { '/work/proj': { toolPlace: { Read: 'defer' }, toolRewrite: { Read: 'p' } } },
      },
    })
    const sw: AtlasSwitches = { skillsOff: [], skillDirs: {}, memory: {}, files: {}, prompt: { ...none, toolPlace: { Bash: 'off', WebFetch: 'pin' }, toolRewrite: { Read: 'p' } } }
    const all = levelEdits(prefs, '/work/proj', sw)
    expect(toolLevelsText(all, 'Bash')).toBe('已关闭（本会话、全局）')
    expect(toolLevelsText(all, 'WebFetch')).toBe('固定（本会话、全局）')
    expect(toolLevelsText(all, 'Read')).toBe('已改写（本会话、本项目、全局） · 改成用到再加载（本项目）')
    expect(toolLevelsText(all, 'Glob')).toBe('')
    expect(toolMarks(all, 'Read')).toEqual([
      { what: 'rewritten', text: '已改写（本会话、本项目、全局）' },
      { what: 'defer', text: '改成用到再加载（本项目）' },
    ])
    expect(toolLevelState(all.session, 'Bash')).toBe('已关闭')
    expect(toolLevelState(all.project, 'Read')).toBe('用到再加载，说明已改写')
    expect(toolLevelState(all.global, 'Read')).toBe('说明已改写')
    expect(toolLevelState(all.global, 'WebFetch')).toBe('一直带着')
    expect(toolLevelState(all.session, 'Glob')).toBe('没改')
  })
})

// ---------- 工具: the hooks and the page ----------

type ToolFix = { tool: string; description: string; isDeferred?: true; provider: { plugin: string; tier: 'core' | 'user' } }

const CORE = { plugin: 'engine', tier: 'core' } as const
const READER = { plugin: 'mcp:reader', tier: 'user' } as const
const BASH: ToolFix = { tool: 'Bash', description: `Runs a shell command for the user. ${'Take care with what it deletes. '.repeat(20)}`.trim(), provider: CORE }
const READ: ToolFix = { tool: 'Read', description: 'Reads a file the user names.', provider: CORE }
const SEARCH: ToolFix = { tool: 'ToolSearch', description: 'Loads a deferred tool.', provider: CORE }
const FETCH: ToolFix = { tool: 'WebFetch', description: 'Fetches a web page.', isDeferred: true, provider: CORE }
const CHART: ToolFix = { tool: 'mcp__plots__chart', description: 'Draws a chart.', isDeferred: true, provider: { plugin: 'plots', tier: 'user' } }
const BOOK_READ: ToolFix = { tool: 'mcp__reader__book_read', description: 'Reads a chapter of a book.', isDeferred: true, provider: READER }
const BOOK_TOC: ToolFix = { tool: 'mcp__reader__book_toc', description: 'Lists the chapters.', isDeferred: true, provider: READER }
const TOOLS: readonly ToolFix[] = [READ, BASH, SEARCH, FETCH, CHART, BOOK_READ, BOOK_TOC]
const A_FILE = '/work/proj/a.md'

/**
 * The engine's side of the tools: what `$.tool.list()` answers (every
 * description cut short, as the engine cuts it), and `tool.describe` with
 * nothing changed (the placement it was asked with stands in its answer).
 */
function toolEngine(on: On, tools: readonly ToolFix[] = TOOLS): { lists: () => number } {
  let lists = 0
  on('tool.list', () => {
    lists++
    return { value: tools.map(t => ({ name: t.tool, description: t.description.slice(0, 300), mcp: t.tool.startsWith('mcp__') })) }
  })
  on('tool.describe', (_, e) => ({ description: e.description }))
  return { lists: () => lists }
}

/** The engine renders every tool's schema once, as it does when a session's first turn starts. */
async function describeAll($: Engine, tools: readonly ToolFix[] = TOOLS): Promise<void> {
  for (const t of tools) await $.tool.describe(t)
}

/** A call to any tool by its name: the engine's types know the arguments of the tools it ships, and no other name. */
function call($: Engine, tool: string, args: Record<string, unknown> = {}) {
  return $.tool.call({ tool, ...args } as unknown as Parameters<Engine['tool']['call']>[0])
}

type ToolsOptions = WorldOptions & { tools?: readonly ToolFix[]; isUnseen?: boolean }

async function openTools($: Engine, on: On, surface: Surface, opts: ToolsOptions = {}): Promise<{ w: World; ui: Ui; lists: () => number }> {
  const engine = toolEngine(on, opts.tools)
  const w = world(on, opts)
  await start($, w)
  if (!opts.isUnseen) await describeAll($, opts.tools)
  const ui = await mountPane($, surface)
  await ui.press({ key: 'tab:tools' })
  return { w, ui, lists: engine.lists }
}

/** A row's name as drawn: the Button's own words on the desktop, its label in the terminal. */
async function rowName(ui: Ui, surface: Surface, key: string): Promise<unknown> {
  const row = await ui.find({ key })
  return surface === 'desktop' ? row?.text : row?.props.label
}

const tokensOf = (t: ToolFix) => approxTokens(t.description)

both('工具: the tab lists every tool in three groups, the longest description first, an MCP server folded into one row', async ($, on, surface) => {
  const { w, ui, lists } = await openTools($, on, surface)
  // opening the page read the list once, asked the engine to describe nothing again, and changed nothing
  expect(lists()).toBe(1)
  expect(w.invalidated).not.toContain('tool.describe')
  expect(w.switches()?.prompt).toEqual(NONE)
  expect(await chosen(ui, surface, 'scope:tools')).toBe('session')
  expect(await ui.find({ type: 'Text', text: /^下面几组是按/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /大小只算每个工具的说明文字，参数表不算在内/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /还没见到说明的工具先不显示大小：发一条消息之后就有了/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '每次都带着 · 3 个' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '用到才加载 · 4 个' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '关掉的 · 0 个' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /还没见到说明的 · / })).toBeUndefined()
  // in the prompt: Bash's long description before Read's and ToolSearch's; behind ToolSearch: a built-in and a
  // plugin's tool on rows of their own, the MCP server's two folded into one
  expect(await buttonKeys(ui, 'tool:')).toEqual(['tool:Bash', 'tool:Read', 'tool:ToolSearch', 'tool:WebFetch', 'tool:mcp__plots__chart'])
  expect(await buttonKeys(ui, 'tsrv')).toEqual(['tsrv:reader'])
  expect(await rowName(ui, surface, 'tsrv:reader')).toBe('reader（2 个工具）')
  expect(await rowName(ui, surface, 'tool:Bash')).toBe('Bash')
  expect(await ui.find({ type: 'Text', text: new RegExp(`说明约 ${tokensOf(BASH)} tokens · 引擎自带`) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: new RegExp(`说明约 ${tokensOf(CHART)} tokens · 插件：plots`) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: new RegExp(`说明共约 ${tokensOf(BASH) + tokensOf(READ) + tokensOf(SEARCH)} tokens`) })).toBeDefined()

  // the server's row opens its tools, each with where it waits
  await ui.press({ key: 'tsrv:reader' })
  expect(await ui.find({ type: 'Text', text: 'reader（2 个工具）' })).toBeDefined()
  expect(await buttonKeys(ui, 'tool:')).toEqual(['tool:mcp__reader__book_read', 'tool:mcp__reader__book_toc'])
  expect(await rowName(ui, surface, 'tool:mcp__reader__book_read')).toBe(surface === 'desktop' ? 'book_read' : 'mcp__reader__book_read')
  expect(await ui.find({ type: 'Text', text: new RegExp(`用到才加载 · 说明约 ${tokensOf(BOOK_READ)} tokens`) })).toBeDefined()

  // one of them switched off leaves the fold for a row of its own under 关掉的
  await ui.press({ key: 'tool:mcp__reader__book_read' })
  expect(await ui.find({ type: 'Text', text: /MCP：reader/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /按这个会话现在的设置：用到才加载（引擎默认）/ })).toBeDefined()
  // an MCP tool behind ToolSearch may only have shown its short text yet: the page says so before the rewrite button
  expect(await ui.find({ type: 'Text', text: /^要改写它，最好等下面出现完整的说明之后/ })).toBeDefined()
  await pick(ui, surface, 't-place', 'off')
  expect(w.switches()?.prompt).toEqual({ ...NONE, toolPlace: { mcp__reader__book_read: 'off' } })
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: /关掉了 · 说明约/ })).toBeDefined()
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: '用到才加载 · 3 个' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '关掉的 · 1 个' })).toBeDefined()
  expect(await buttonKeys(ui, 'tool:')).toEqual(['tool:Bash', 'tool:Read', 'tool:ToolSearch', 'tool:WebFetch', 'tool:mcp__plots__chart', 'tool:mcp__reader__book_read'])
  expect(await rowName(ui, surface, 'tsrv:reader')).toBe('reader（1 个工具）')
  // marked with the level that says so
  const mark = await ui.find({ type: 'Text', text: /已关闭（本会话）/ })
  expect(mark).toBeDefined()
  if (surface === 'desktop') expect(mark?.text.trim()).toBe('已关闭（本会话）')
  await ui.unmount()
})

both('工具: a tool\'s page says where it comes from and where it stands, and each way of carrying it is what tool.describe answers', async ($, on, surface) => {
  const { w, ui } = await openTools($, on, surface)
  await ui.press({ key: 'tool:Read' })
  expect((await ui.find({ type: 'Text', text: /引擎自带/ }))?.text).toContain(`${READ.description.length} 字符`)
  expect(await ui.find({ type: 'Text', text: /按这个会话现在的设置：每次都带着（引擎默认）/ })).toBeDefined()
  expect(await chosen(ui, surface, 'scope:tool')).toBe('session')
  expect(await chosen(ui, surface, 't-place')).toBe('auto')
  expect((await ui.find({ type: 'Text', text: /^本会话：/ }))?.text).toContain('没改')
  expect(await ui.find({ type: 'Text', text: READ.description })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^要改写它，最好等下面出现完整的说明之后/ })).toBeUndefined()
  // untouched: the engine's own answer, to the letter
  expect(await $.tool.describe(READ)).toEqual({ description: READ.description })
  expect(await $.tool.describe(FETCH)).toEqual({ description: FETCH.description, isDeferred: true })

  // 用到再加载: behind ToolSearch, and still a tool that runs
  const asked = w.invalidated.length
  await pick(ui, surface, 't-place', 'defer')
  expect(w.switches()?.prompt).toEqual({ ...NONE, toolPlace: { Read: 'defer' } })
  expect(w.invalidated.slice(asked)).toContain('tool.describe')
  expect(await chosen(ui, surface, 't-place')).toBe('defer')
  expect(await $.tool.describe(READ)).toEqual({ description: READ.description, isDeferred: true })
  expect(await ui.find({ type: 'Text', text: /按这个会话现在的设置：用到才加载（本会话定的）/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^本会话：/ }))?.text).toContain('用到再加载')
  expect(await $.tool.call({ tool: 'Read', file_path: A_FILE })).toEqual({ result: 'ran' })

  // 关掉: behind ToolSearch, and every call refused in words the model can act on
  await pick(ui, surface, 't-place', 'off')
  expect(w.switches()?.prompt).toEqual({ ...NONE, toolPlace: { Read: 'off' } })
  expect(await $.tool.describe(READ)).toEqual({ description: READ.description, isDeferred: true })
  expect((await $.tool.call({ tool: 'Read', file_path: A_FILE })).deny).toBe(toolOffDeny('Read'))
  expect(await ui.find({ type: 'Text', text: /按这个会话现在的设置：关掉了（本会话定的）/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /每次调用都会被拒绝，并且告诉模型这是你关的/ })).toBeDefined()
  // every other tool runs as before, and is described as before
  expect(await $.tool.call({ tool: 'Bash', command: 'ls' })).toEqual({ result: 'ran' })
  expect((await call($, 'WebFetch', { url: 'https://example.com', prompt: 'read it' })).deny).toBeUndefined()
  expect((await call($, 'mcp__reader__book_read')).deny).toBeUndefined()
  expect(await $.tool.describe(BASH)).toEqual({ description: BASH.description })

  // 一直带着: in the prompt's list, and it runs again
  await pick(ui, surface, 't-place', 'pin')
  expect(await $.tool.describe(READ)).toEqual({ description: READ.description, isDeferred: false })
  expect(await $.tool.call({ tool: 'Read', file_path: A_FILE })).toEqual({ result: 'ran' })
  await ui.press({ key: 'back' })
  await ui.press({ key: 'tool:WebFetch' })
  await pick(ui, surface, 't-place', 'pin')
  expect(await $.tool.describe(FETCH)).toEqual({ description: FETCH.description, isDeferred: false })
  expect(await ui.find({ type: 'Text', text: /按这个会话现在的设置：每次都带着（本会话定的）/ })).toBeDefined()
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: '每次都带着 · 4 个' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /固定（本会话）/ })).toBeDefined()

  // 跟引擎默认: the placement is taken back, and the answer is the engine's own again
  for (const name of ['Read', 'WebFetch']) {
    await ui.press({ key: `tool:${name}` })
    await pick(ui, surface, 't-place', 'auto')
    await ui.press({ key: 'back' })
  }
  expect(w.switches()?.prompt).toEqual(NONE)
  expect(await $.tool.describe(READ)).toEqual({ description: READ.description })
  expect(await $.tool.describe(FETCH)).toEqual({ description: FETCH.description, isDeferred: true })
  // a session edit is no default: nothing went to the store
  expect(storedPrompt(w)).toEqual({ global: NONE, byProject: {} })
  await ui.unmount()
})

both('工具: t-rewrite starts from the tool\'s own description, t-rw saves the new one, t-restore takes it back, at each level', async ($, on, surface) => {
  const { w, ui } = await openTools($, on, surface)
  await ui.press({ key: 'tool:Read' })
  expect(await ui.find({ key: 't-restore' })).toBeUndefined()
  expect(await ui.find({ key: 't-rw' })).toBeUndefined()
  await ui.press({ key: 't-rewrite' })
  expect(w.switches()?.prompt).toEqual({ ...NONE, toolRewrite: { Read: READ.description } })
  expect(await value(ui, 't-rw')).toBe(READ.description)
  const mine = 'Read one file.\nNever a folder.'
  const asked = w.invalidated.length
  await ui.input({ key: 't-rw', text: mine })
  expect(w.switches()?.prompt).toEqual({ ...NONE, toolRewrite: { Read: mine } })
  expect(w.invalidated.slice(asked)).toContain('tool.describe')
  expect(await value(ui, 't-rw')).toBe(mine)
  expect(await $.tool.describe(READ)).toEqual({ description: mine })
  expect(await $.tool.describe(BASH)).toEqual({ description: BASH.description })
  // rewritten is not off: it runs
  expect(await $.tool.call({ tool: 'Read', file_path: A_FILE })).toEqual({ result: 'ran' })
  // the tool's own text is still what the page calls the original
  expect(await ui.find({ type: 'Text', text: READ.description })).toBeDefined()
  expect(await ui.find({ key: 't-rewrite' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^本会话：/ }))?.text).toContain('说明已改写')
  // an empty rewrite is refused, with a word why
  await ui.input({ key: 't-rw', text: '   ' })
  expect(w.switches()?.prompt?.toolRewrite).toEqual({ Read: mine })
  expect(w.toasts.some(t => t.includes('改写不能是空的'))).toBe(true)
  await ui.press({ key: 't-restore' })
  expect(w.switches()?.prompt).toEqual(NONE)
  expect(await ui.find({ key: 't-rw' })).toBeUndefined()
  expect(await $.tool.describe(READ)).toEqual({ description: READ.description })
  // a second rewrite starts from the tool's own text again, not from the old rewrite
  await ui.press({ key: 't-rewrite' })
  expect(await value(ui, 't-rw')).toBe(READ.description)
  await ui.press({ key: 't-restore' })
  expect(storedPrompt(w)).toEqual({ global: NONE, byProject: {} })

  // the global default: stored, and this session's answers and calls do not change
  await pick(ui, surface, 'scope:tool', 'global')
  await ui.press({ key: 't-rewrite' })
  await ui.input({ key: 't-rw', text: 'Global read.' })
  await pick(ui, surface, 't-place', 'off')
  expect(storedPrompt(w)).toEqual({ global: { ...NONE, toolRewrite: { Read: 'Global read.' }, toolPlace: { Read: 'off' } }, byProject: {} })
  expect(w.switches()?.prompt).toEqual(NONE)
  expect(await $.tool.describe(READ)).toEqual({ description: READ.description })
  expect(await $.tool.call({ tool: 'Read', file_path: A_FILE })).toEqual({ result: 'ran' })
  expect((await ui.find({ type: 'Text', text: /^全局默认：/ }))?.text).toContain('已关闭，说明已改写')
  expect((await ui.find({ type: 'Text', text: /^本会话：/ }))?.text).toContain('没改')
  expect(await ui.find({ type: 'Text', text: /按这个会话现在的设置：每次都带着（引擎默认）/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /改的是默认值：从下一个会话起生效，本会话不变/ })).toBeDefined()

  // the project's default, chosen on the tool's own page: it says what the global one already does
  await pick(ui, surface, 'scope:tool', 'project')
  expect(await chosen(ui, surface, 't-place')).toBe('auto')
  expect(await ui.find({ key: 't-rw' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /全局默认给它定了位置（关掉）/ })).toBeDefined()
  await ui.press({ key: 't-rewrite' })
  await ui.input({ key: 't-rw', text: 'Project read.' })
  await pick(ui, surface, 't-place', 'pin')
  expect(storedPrompt(w).byProject).toEqual({ [CWD]: { ...NONE, toolRewrite: { Read: 'Project read.' }, toolPlace: { Read: 'pin' } } })
  expect(storedPrompt(w).global).toEqual({ ...NONE, toolRewrite: { Read: 'Global read.' }, toolPlace: { Read: 'off' } })
  // on the list, at this level, the row carries every level's mark
  await ui.press({ key: 'back' })
  expect(await chosen(ui, surface, 'scope:tools')).toBe('project')
  expect(await ui.find({ type: 'Text', text: /^下面几组是按「本项目默认」这一层的设置排的，不是这个会话现在的样子/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /已关闭（全局）/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /已改写（本项目、全局）/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /固定（本项目）/ })).toBeDefined()
  // taken back at both levels, the store holds no edit of any tool
  await ui.press({ key: 'tool:Read' })
  await ui.press({ key: 't-restore' })
  await pick(ui, surface, 't-place', 'auto')
  expect(storedPrompt(w).byProject).toEqual({ [CWD]: NONE })
  await pick(ui, surface, 'scope:tool', 'global')
  await ui.press({ key: 't-restore' })
  await pick(ui, surface, 't-place', 'auto')
  expect(storedPrompt(w)).toEqual({ global: NONE, byProject: { [CWD]: NONE } })
  expect(w.switches()?.prompt).toEqual(NONE)
  await ui.unmount()
})

both('工具: ToolSearch can be rewritten and nothing else: no way of carrying it is offered, and a stored placement is not obeyed', async ($, on, surface) => {
  const prefs = { prompt: { global: { toolPlace: { ToolSearch: 'off', WebFetch: 'off' } }, byProject: {} } }
  const { w, ui } = await openTools($, on, surface, { store: { prefs } })
  expect(w.switches()?.prompt?.toolPlace).toEqual({ ToolSearch: 'off', WebFetch: 'off' })
  // the hooks: its place is the engine's, and it runs; the other tool the same default names is off
  expect(await $.tool.describe(SEARCH)).toEqual({ description: SEARCH.description })
  expect((await call($, 'ToolSearch', { query: 'select:WebFetch', max_results: 5 })).deny).toBeUndefined()
  expect(await $.tool.describe(FETCH)).toEqual({ description: FETCH.description, isDeferred: true })
  expect((await call($, 'WebFetch', { url: 'https://example.com', prompt: 'read it' })).deny).toBe(toolOffDeny('WebFetch'))
  // the page: it stands where the engine put it, with no mark
  expect(await ui.find({ type: 'Text', text: '关掉的 · 1 个' })).toBeDefined()
  await ui.press({ key: 'tool:ToolSearch' })
  expect(await ui.find({ type: 'Text', text: /按这个会话现在的设置：每次都带着（引擎默认）/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /它不能关，也不能改成「用到再加载」/ })).toBeDefined()
  expect(await ui.find({ key: 't-place' })).toBeUndefined()
  for (const v of ['auto', 'pin', 'defer', 'off']) expect(await ui.find({ key: `t-place:${v}` })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^本会话：/ }))?.text).toContain('没改')
  // its description may still be rewritten
  await ui.press({ key: 't-rewrite' })
  await ui.input({ key: 't-rw', text: 'Find a tool by name.' })
  expect(await $.tool.describe(SEARCH)).toEqual({ description: 'Find a tool by name.' })
  expect((await call($, 'ToolSearch', { query: 'select:WebFetch', max_results: 5 })).deny).toBeUndefined()
  await ui.unmount()
})

test('工具: session.start seeds each tool\'s place and rewrite from the global default with the project\'s over it, and the name is written over a rewrite too', async ($, on) => {
  toolEngine(on)
  const prefs = {
    prompt: {
      global: {
        rename: 'Robin',
        toolPlace: { Bash: 'off', WebFetch: 'pin', Read: 'defer' },
        toolRewrite: { Read: 'Global read for the user.', WebFetch: 'Fetch what the user asks for.' },
      },
      byProject: {
        [CWD]: { toolPlace: { Bash: 'defer', mcp__reader__book_toc: 'off' }, toolRewrite: { Read: 'Read what the user names. Not the user message.' } },
        '/work/other': { toolPlace: { Read: 'off' }, toolRewrite: { Bash: 'another project' } },
      },
    },
  }
  const w = world(on, { store: { prefs } })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  expect(w.switches()?.prompt?.toolPlace).toEqual({ Bash: 'defer', WebFetch: 'pin', Read: 'defer', mcp__reader__book_toc: 'off' })
  expect(w.switches()?.prompt?.toolRewrite).toEqual({ Read: 'Read what the user names. Not the user message.', WebFetch: 'Fetch what the user asks for.' })
  // no pane was opened: the hooks alone. The name goes over a rewrite as over a tool's own words
  expect(BASH.description).toContain('the user')
  expect(await $.tool.describe(BASH)).toEqual({ description: renameUser(BASH.description, 'Robin').text, isDeferred: true })
  expect(await $.tool.describe(FETCH)).toEqual({ description: 'Fetch what Robin asks for.', isDeferred: false })
  expect(await $.tool.describe(READ)).toEqual({ description: 'Read what Robin names. Not the user message.', isDeferred: true })
  expect(await $.tool.describe(BOOK_TOC)).toEqual({ description: BOOK_TOC.description, isDeferred: true })
  expect(await $.tool.describe(BOOK_READ)).toEqual({ description: BOOK_READ.description, isDeferred: true })
  expect(await $.tool.describe(SEARCH)).toEqual({ description: SEARCH.description })
  // the project put Bash behind ToolSearch where the global default had it off: it runs
  expect(await $.tool.call({ tool: 'Bash', command: 'ls' })).toEqual({ result: 'ran' })
  expect(await $.tool.call({ tool: 'Read', file_path: A_FILE })).toEqual({ result: 'ran' })
  expect((await call($, 'mcp__reader__book_toc')).deny).toBe(toolOffDeny('mcp__reader__book_toc'))
  expect((await call($, 'mcp__reader__book_read')).deny).toBeUndefined()
  // seeding wrote no default back
  expect(w.store.get('prefs')).toEqual(prefs)
})

both('工具: a store from before the page loads as nothing changed, and the page then writes beside what was there', async ($, on, surface) => {
  const { w, ui } = await openTools($, on, surface, { store: DEFAULTS })
  expect(Object.keys(w.switches()?.prompt ?? {}).sort()).toEqual(['extra', 'off', 'rewrite'])
  expect(await $.tool.describe(READ)).toEqual({ description: READ.description })
  expect(await $.tool.describe(FETCH)).toEqual({ description: FETCH.description, isDeferred: true })
  expect(await $.tool.call({ tool: 'Read', file_path: A_FILE })).toEqual({ result: 'ran' })
  expect(await buttonKeys(ui, 'tool:')).toEqual(['tool:Bash', 'tool:Read', 'tool:ToolSearch', 'tool:WebFetch', 'tool:mcp__plots__chart'])
  expect(await ui.find({ type: 'Text', text: '关掉的 · 0 个' })).toBeDefined()
  await ui.press({ key: 'tool:Read' })
  expect(await chosen(ui, surface, 't-place')).toBe('auto')
  await pick(ui, surface, 't-place', 'off')
  await pick(ui, surface, 'scope:tool', 'global')
  await pick(ui, surface, 't-place', 'defer')
  // the edits each level already had are still there, the tool's beside them
  expect(w.switches()?.prompt?.toolPlace).toEqual({ Read: 'off' })
  expect(w.switches()?.prompt?.off).toEqual(['tone', 'pronouns'])
  expect(w.switches()?.prompt?.rewrite).toEqual({ intro: 'Project intro.', env_info_simple: 'Global env.', output_style: 'Rewritten style.' })
  expect(storedPrompt(w).global).toEqual({ ...DEFAULTS.prefs.prompt.global, toolPlace: { Read: 'defer' } })
  expect(storedPrompt(w).byProject).toEqual(DEFAULTS.prefs.prompt.byProject)
  expect(await $.prompt.section({ name: 'tone', text: TONE })).toEqual({ text: null })
  await ui.unmount()
})

both('工具: a page state an earlier version stored, with no entry for this page, draws as not read yet, and then reads', async ($, on, surface) => {
  const engine = toolEngine(on)
  // What the state held before this page was made, and a view left on this tab (so drawing it reads nothing
  // first): each is read as it was left until the plugin writes that key.
  const idle = { status: 'idle' as const, error: null, atMs: 0 }
  const wrote = { manage: false, view: false }
  on('state.set', { plugin: 'atlas', key: 'manage' }, ($, e, next) => {
    wrote.manage = true
    return next(e)
  })
  on('state.get', { plugin: 'atlas', key: 'manage' }, ($, e, next) => (wrote.manage ? next(e) : { value: { value: { prompt: idle, hooks: idle, hooksUndo: null }, version: 0 } }))
  on('state.set', { plugin: 'atlas', key: 'view' }, ($, e, next) => {
    wrote.view = true
    return next(e)
  })
  on('state.get', { plugin: 'atlas', key: 'view' }, ($, e, next) => (wrote.view ? next(e) : { value: { value: { ...VIEW0, tab: 'tools' as const }, version: 0 } }))
  const w = world(on)
  await start($, w)
  await describeAll($)
  const ui = await mountPane($, surface)
  expect(wrote).toEqual({ manage: false, view: false })
  expect(await ui.find({ type: 'Text', text: '还没有读取' })).toBeDefined()
  expect(engine.lists()).toBe(0)
  // what the module holds is drawn all the same: the tools the engine has described
  expect(await buttonKeys(ui, 'tool:')).toEqual(['tool:Bash', 'tool:Read', 'tool:ToolSearch', 'tool:WebFetch', 'tool:mcp__plots__chart'])
  expect(await buttonKeys(ui, 'tsrv')).toEqual(['tsrv:reader'])
  await ui.press({ key: 't-reload' })
  expect(engine.lists()).toBe(1)
  // reading writes the page's entry beside the two that were there
  expect(wrote.manage).toBe(true)
  expect(w.state.manage as AtlasManage | undefined).toMatchObject({ prompt: idle, hooks: idle, hooksUndo: null, tools: { status: 'ready', error: null } })
  expect(await ui.find({ type: 'Text', text: /^读取于 / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '还没有读取' })).toBeUndefined()
  await ui.unmount()
})

both('工具: a tool not described yet has no size and stands apart until the engine describes it; 重新读取 asks the engine again', async ($, on, surface) => {
  const { w, ui, lists } = await openTools($, on, surface, { isUnseen: true })
  expect(await ui.find({ type: 'Text', text: '还没见到说明的 · 7 个' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '每次都带着 · 0 个' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '用到才加载 · 0 个' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /发一条消息之后，它们会归到上面几组里/ })).toBeDefined()
  // in the engine's order; a name that reads as an MCP server's is folded under that server
  expect(await buttonKeys(ui, 'tool:')).toEqual(['tool:Read', 'tool:Bash', 'tool:ToolSearch', 'tool:WebFetch'])
  expect(await buttonKeys(ui, 'tsrv')).toEqual(['tsrv-new:plots', 'tsrv-new:reader'])
  expect(await ui.find({ type: 'Text', text: '还没见到说明' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /说明约 \d+ tokens/ })).toBeUndefined()
  // its page reads without its text, and says why it cannot be rewritten yet
  await ui.press({ key: 'tool:Bash' })
  expect(await ui.find({ type: 'Text', text: /还不知道它排在哪/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /还没见到它的说明/ })).toBeDefined()
  expect(await ui.find({ key: 't-rewrite' })).toBeUndefined()
  expect(await chosen(ui, surface, 't-place')).toBe('auto')
  // it can be switched off all the same: the refusal needs no description
  await pick(ui, surface, 't-place', 'off')
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBe(toolOffDeny('Bash'))
  await pick(ui, surface, 't-place', 'auto')
  await ui.press({ key: 'back' })

  // 重新读取: the list again, and every tool described again from the next turn
  const asked = w.invalidated.length
  const before = lists()
  await ui.press({ key: 't-reload' })
  expect(lists()).toBe(before + 1)
  expect(w.invalidated.slice(asked)).toContain('tool.describe')
  // the next turn: the engine describes them, and the page sorts them into its groups, sized
  await describeAll($)
  expect(await ui.find({ type: 'Text', text: '每次都带着 · 3 个' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '用到才加载 · 4 个' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /还没见到说明的 · / })).toBeUndefined()
  expect(await buttonKeys(ui, 'tool:')).toEqual(['tool:Bash', 'tool:Read', 'tool:ToolSearch', 'tool:WebFetch', 'tool:mcp__plots__chart'])
  expect(await buttonKeys(ui, 'tsrv')).toEqual(['tsrv:reader'])
  expect(await ui.find({ type: 'Text', text: new RegExp(`说明约 ${tokensOf(BASH)} tokens · 引擎自带`) })).toBeDefined()
  await ui.unmount()
})

both('工具: when the engine will not list its tools the page says so, shows what it has seen described, and reads well with nothing at all', async ($, on, surface) => {
  on('tool.list', () => ({ deny: 'no list today' }))
  on('tool.describe', (_, e) => ({ description: e.description }))
  const w = world(on)
  await start($, w)
  const ui = await mountPane($, surface)
  await ui.press({ key: 'tab:tools' })
  // nothing held: the two lines, the level, the load line, and a word on what to do
  expect(await ui.find({ type: 'Text', text: /没能读出工具清单/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /还没有工具的记录/ })).toBeDefined()
  expect(await ui.find({ key: 't-reload' })).toBeDefined()
  expect(await chosen(ui, surface, 'scope:tools')).toBe('session')
  expect(await buttonKeys(ui, 'tool:')).toEqual([])
  expect(await ui.find({ type: 'Text', text: /每次都带着 · / })).toBeUndefined()
  // a tool described after that is listed, list or no list
  await $.tool.describe(READ)
  expect(await buttonKeys(ui, 'tool:')).toEqual(['tool:Read'])
  expect(await ui.find({ type: 'Text', text: '每次都带着 · 1 个' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /还没有工具的记录/ })).toBeUndefined()
  await ui.unmount()
})

both('工具: with 生效 at 下一轮 every tool.describe answer carries breakPromptCache, and the page says how that switch stands', async ($, on, surface) => {
  const { w, ui } = await openTools($, on, surface)
  expect(await ui.find({ type: 'Text', text: /现在定的是「新会话或压缩后」生效/ })).toBeDefined()
  expect(await $.tool.describe(READ)).toEqual({ description: READ.description })
  await ui.press({ key: 'tab:prompt' })
  const asked = w.invalidated.length
  await pick(ui, surface, 'p-now', 'now')
  expect(w.invalidated.slice(asked)).toContain('tool.describe')
  expect(await $.tool.describe(READ)).toEqual({ description: READ.description, breakPromptCache: true })
  expect(await $.tool.describe(FETCH)).toEqual({ description: FETCH.description, isDeferred: true, breakPromptCache: true })
  await ui.press({ key: 'tab:tools' })
  expect(await ui.find({ type: 'Text', text: /现在定的是「下一轮」生效/ })).toBeDefined()
  await ui.press({ key: 'tool:Read' })
  expect(await ui.find({ type: 'Text', text: /现在定的是「下一轮」生效/ })).toBeDefined()
  await pick(ui, surface, 't-place', 'defer')
  await ui.press({ key: 't-rewrite' })
  await ui.input({ key: 't-rw', text: 'Mine.' })
  expect(await $.tool.describe(READ)).toEqual({ description: 'Mine.', isDeferred: true, breakPromptCache: true })
  await ui.press({ key: 'tab:prompt' })
  await pick(ui, surface, 'p-now', 'later')
  expect(await $.tool.describe(READ)).toEqual({ description: 'Mine.', isDeferred: true })
  await ui.unmount()
})

both('工具: a name set for the session is written over a rewritten description as over a tool\'s own, and the page counts the places', async ($, on, surface) => {
  const { ui } = await openTools($, on, surface)
  await ui.press({ key: 'tool:Read' })
  await ui.press({ key: 't-rewrite' })
  await ui.input({ key: 't-rw', text: 'Read what the user names, for the user. Not the user message.' })
  expect(await ui.find({ type: 'Text', text: /the user 会写成/ })).toBeUndefined()
  await ui.press({ key: 'tab:prompt' })
  await ui.input({ key: 'rn-name', text: 'Robin' })
  expect(await $.tool.describe(READ)).toEqual({ description: 'Read what Robin names, for Robin. Not the user message.' })
  expect(await $.tool.describe(BASH)).toEqual({ description: renameUser(BASH.description, 'Robin').text })
  expect(await $.tool.describe(FETCH)).toEqual({ description: FETCH.description, isDeferred: true })
  await ui.press({ key: 'tab:tools' })
  await ui.press({ key: 'tool:Read' })
  expect(await ui.find({ type: 'Text', text: /the user 会写成 Robin（2 处）/ })).toBeDefined()
  // the rewrite kept is as it was written; the name is written on the way out
  expect(await value(ui, 't-rw')).toBe('Read what the user names, for the user. Not the user message.')
  await ui.press({ key: 't-restore' })
  expect(await $.tool.describe(READ)).toEqual({ description: 'Reads a file Robin names.' })
  await ui.unmount()
})

test('工具: the hooks hand back what the engine gave, and refuse nothing, when the switches cannot be read', async ($, on) => {
  toolEngine(on)
  world(on, { store: { prefs: { prompt: { global: { rename: 'Robin', toolPlace: { Read: 'off', WebFetch: 'pin' }, toolRewrite: { Read: 'Mine.' } }, byProject: {} } } } })
  on('state.get', { plugin: 'atlas', key: 'switches' }, () => ({ deny: 'state unavailable' }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  expect(await $.tool.describe(READ)).toEqual({ description: READ.description })
  expect(await $.tool.describe(FETCH)).toEqual({ description: FETCH.description, isDeferred: true })
  expect(await $.tool.call({ tool: 'Read', file_path: A_FILE })).toEqual({ result: 'ran' })
  expect(await $.tool.call({ tool: 'Bash', command: 'ls' })).toEqual({ result: 'ran' })
})

both('工具: a tool named constructor or __proto__ is switched off, rewritten and put back like any other, and costs no other tool', async ($, on, surface) => {
  const builds: ToolFix = { tool: 'constructor', description: 'Builds.', provider: CORE }
  const links: ToolFix = { tool: '__proto__', description: 'Link.', provider: CORE }
  const { w, ui } = await openTools($, on, surface, { tools: [READ, builds, links] })
  expect(await buttonKeys(ui, 'tool:')).toEqual(['tool:Read', 'tool:constructor', 'tool:__proto__'])
  for (const t of [READ, builds, links]) expect(await $.tool.describe(t), t.tool).toEqual({ description: t.description })
  for (const name of ['Read', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) expect((await call($, name)).deny, name).toBeUndefined()
  for (const t of [builds, links]) {
    await ui.press({ key: `tool:${t.tool}` })
    expect(await chosen(ui, surface, 't-place'), t.tool).toBe('auto')
    await pick(ui, surface, 't-place', 'off')
    expect(toolPlaceOf(w.switches()?.prompt, t.tool), t.tool).toBe('off')
    expect(await chosen(ui, surface, 't-place'), t.tool).toBe('off')
    expect((await call($, t.tool)).deny, t.tool).toBe(toolOffDeny(t.tool))
    await ui.press({ key: 't-rewrite' })
    await ui.input({ key: 't-rw', text: 'Mine.' })
    expect(await $.tool.describe(t), t.tool).toEqual({ description: 'Mine.', isDeferred: true })
    await ui.press({ key: 'back' })
  }
  expect(Object.keys(w.switches()?.prompt?.toolPlace ?? {})).toEqual(['constructor', '__proto__'])
  expect(await ui.find({ type: 'Text', text: '关掉的 · 2 个' })).toBeDefined()
  // no other tool is touched by either, whatever it is called
  expect(await $.tool.describe(READ)).toEqual({ description: READ.description })
  for (const name of ['Read', 'toString', 'hasOwnProperty', 'valueOf']) expect((await call($, name)).deny, name).toBeUndefined()
  // as the global default: through the store and back
  await pick(ui, surface, 'scope:tools', 'global')
  await ui.press({ key: 'tool:__proto__' })
  await pick(ui, surface, 't-place', 'pin')
  expect(toolPlaceOf(normalizePrefs(w.store.get('prefs')).prompt?.global, '__proto__')).toBe('pin')
  expect(toolPlaceOf(normalizePrefs(w.store.get('prefs')).prompt?.global, 'constructor')).toBeUndefined()
  await pick(ui, surface, 't-place', 'auto')
  expect(normalizePrefs(w.store.get('prefs')).prompt?.global).toEqual(NONE)
  // put back for the session: described and run as the engine has them
  await pick(ui, surface, 'scope:tool', 'session')
  await ui.press({ key: 'back' })
  for (const t of [builds, links]) {
    await ui.press({ key: `tool:${t.tool}` })
    await ui.press({ key: 't-restore' })
    await pick(ui, surface, 't-place', 'auto')
    await ui.press({ key: 'back' })
    expect(await $.tool.describe(t), t.tool).toEqual({ description: t.description })
    expect((await call($, t.tool)).deny, t.tool).toBeUndefined()
  }
  expect(w.switches()?.prompt).toEqual(NONE)
  const fresh: Record<string, unknown> = {}
  expect(fresh.off).toBeUndefined()
  expect(Object.keys(Object.prototype)).toEqual([])
  await ui.unmount()
})

both('工具: the page\'s illustration counts what rides in the prompt, and says so when nothing is sized yet', async ($, on, surface) => {
  const { ui } = await openTools($, on, surface, { isUnseen: true })
  if (surface !== 'desktop') {
    expect(await journalPic(ui)).toBeUndefined()
    await ui.unmount()
    return
  }
  const unsized = String((await journalPic(ui))?.props.alt)
  expect(unsized).toContain('工具页')
  expect(unsized).toContain('7 个工具')
  expect(unsized).toContain('? 发条消息才知道大小')
  await describeAll($)
  await ui.press({ key: 'tool:Read' })
  await pick(ui, surface, 't-place', 'off')
  await ui.press({ key: 'back' })
  const alt = String((await journalPic(ui))?.props.alt)
  expect(alt).toContain('2 个工具每次都带着')
  expect(alt).toContain(`${tokensOf(BASH) + tokensOf(SEARCH)} tokens 左右的说明`)
  expect(alt).toContain('1 个你改过')
  expect(alt).toContain(`谁的说明最长：Bash ${tokensOf(BASH)}、ToolSearch ${tokensOf(SEARCH)}`)
  expect(alt).toContain('标签：1 个工具关着')
  await ui.unmount()
})

// ---------- 提示词: what the system prompt carries outside the sections ----------

const HOST_RULES = 'Your priority is to complete the request while following the rules below.\n\n## Action categories\n\n### Regular\nAnything else may proceed.'
const BILLING = 'x-anthropic-billing-header: cc_version=0.0.0; cc_entrypoint=test;'
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

/** A model request as the engine sends it: the sections in two blocks, the engine's lines before and an app's rules after. */
function requestBody(extra = HOST_RULES): string {
  return JSON.stringify({
    model: 'claude-test',
    system: [
      { type: 'text', text: BILLING },
      { type: 'text', text: IDENTITY },
      { type: 'text', text: `\n${INTRO}\n\n${TONE}`, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: `${ENV}\n\n${extra}` },
    ],
    messages: [{ role: 'user', content: 'hello' }],
  })
}

describe('manage.ts 段之外', () => {
  test('systemBlocks reads the text blocks of a model request, and nothing of any other body', () => {
    expect(systemBlocks(requestBody())).toEqual({ blocks: [BILLING, IDENTITY, `\n${INTRO}\n\n${TONE}`, `${ENV}\n\n${HOST_RULES}`], model: 'claude-test' })
    expect(systemBlocks(JSON.stringify({ model: 'm', system: 'one string', messages: [] }))).toEqual({ blocks: ['one string'], model: 'm' })
    expect(systemBlocks(JSON.stringify({ system: ['plain', { type: 'image' }, { text: 7 }, { text: 'kept' }] }))).toEqual({ blocks: ['plain', 'kept'], model: '' })
    for (const body of ['', '[]', 'not json', '{"system":', JSON.stringify({ messages: [] }), JSON.stringify({ system: [] }), JSON.stringify({ system: 3 }), JSON.stringify(['"system"'])]) {
      expect(systemBlocks(body), body).toBeNull()
    }
  })

  test('outsideOf leaves what no section accounts for, in the order sent, and counts the sections it found', () => {
    const blocks = systemBlocks(requestBody())?.blocks ?? []
    const out = outsideOf(blocks, [INTRO, TONE, ENV])
    expect(out.pieces).toEqual([
      { text: BILLING, block: 0 },
      { text: IDENTITY, block: 1 },
      { text: HOST_RULES, block: 3 },
    ])
    expect([out.matched, out.asked]).toEqual([3, 3])
    // white space between sections is nobody's; a section that is not there is simply not found
    expect(outsideOf([`${INTRO}\n\n \n${TONE}`], [INTRO, TONE, 'A section that was never sent.'])).toEqual({ pieces: [], matched: 2, asked: 3 })
    // a short section's words inside a longer one do not split the longer one
    expect(outsideOf(['Be brief and kind. Always. And then: Be brief and kind.'], ['Be brief and kind. Always.', 'Be brief and kind.']).pieces).toEqual([{ text: 'And then:', block: 0 }])
    // nothing shared: every block is left whole, and the caller can tell it is another prompt
    const other = outsideOf(['A subagent prompt.', 'With its own rules.'], [INTRO, TONE, ENV])
    expect(other).toEqual({ pieces: [{ text: 'A subagent prompt.', block: 0 }, { text: 'With its own rules.', block: 1 }], matched: 0, asked: 3 })
    expect(isOwnPrompt(other.matched, other.asked)).toBe(false)
    expect(isOwnPrompt(3, 3) && isOwnPrompt(2, 3) && isOwnPrompt(1, 1)).toBe(true)
    expect(isOwnPrompt(1, 3) || isOwnPrompt(0, 0) || isOwnPrompt(0, 1)).toBe(false)
    // sections too short to tell apart from ordinary words are not looked for
    expect(outsideOf(['ok then'], ['ok'])).toEqual({ pieces: [{ text: 'ok then', block: 0 }], matched: 0, asked: 0 })
  })

  test('a long stretch is listed by its parts: cut before a heading and around a tag block, never inside a code fence', () => {
    const pad = (n: number) => 'Words that fill a paragraph out. '.repeat(n).trim()
    const long = [
      pad(12),
      '',
      'Your priority is to follow the rules below.',
      '',
      '## Instruction source boundary',
      pad(10),
      '',
      '## Action categories',
      '',
      '### Prohibited (never perform)',
      pad(6),
      '',
      '### Regular',
      'Anything else.',
      '',
      '```',
      '## not a heading: this is code',
      '<tag>',
      '```',
      '',
      '<browsers>',
      pad(4),
      '</browsers>',
      '',
      'A paragraph after a tag block stands by itself.',
      '',
      '# Task list',
      pad(3),
    ].join('\n')
    const parts = splitOutside(long)
    expect(parts.map(outsideName)).toEqual([
      'Words that fill a paragraph out. Words that fil…',
      'Instruction source boundary',
      'Action categories',
      '<browsers>',
      'A paragraph after a tag block stands by itself.',
      'Task list',
    ])
    // third-level headings and the fenced lines stay inside their part
    expect(parts[2]).toContain('### Prohibited (never perform)')
    expect(parts[2]).toContain('## not a heading: this is code')
    expect(parts[3]?.endsWith('</browsers>')).toBe(true)
    // the opening sentence before the first heading is in the first part, with what came before it
    expect(parts[0]).toContain('Your priority is to follow the rules below.')
    // nothing is lost or added but the white space between parts
    expect(parts.join('\n\n').replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' '))
    // a short stretch stays whole, headings and all; white space alone is nothing
    expect(splitOutside(HOST_RULES)).toEqual([HOST_RULES])
    expect(splitOutside(' \n ')).toEqual([])
    // the list takes the parts in order, each in the block it stood in
    expect(outsideOf([INTRO, long], [INTRO]).pieces.map(p => [outsideName(p.text), p.block])).toEqual(parts.map(p => [outsideName(p), 1]))
  })

  test('requests are kept, a few of them, and the one that holds the sections is settled on', () => {
    const one = (text: string, atMs: number) => ({ blocks: [text], model: 'm', atMs })
    const a = one('side request', 1)
    const own = { blocks: systemBlocks(requestBody())?.blocks ?? [], model: 'm', atMs: 2 }
    let kept = keepSent([], a)
    kept = keepSent(kept, own)
    // the same prompt again takes the place of the one kept, with its newer time
    kept = keepSent(kept, { ...a, atMs: 3 })
    expect(kept.map(k => k.atMs)).toEqual([2, 3])
    for (let i = 0; i < 6; i++) kept = keepSent(kept, one(`other ${i}`, 10 + i))
    expect(kept.length).toBe(SENT_KEPT)
    expect(kept.map(k => k.atMs)).toEqual([12, 13, 14, 15])
    const sections = [INTRO, TONE, ENV].map((text, i) => ({ id: `s${i}`, text, scope: 'shared' as const }))
    // not known yet, or none of the kept is theirs: nothing is settled
    expect(settleOutside([a, own], null)).toBeNull()
    expect(settleOutside([a, own], [])).toBeNull()
    expect(settleOutside([a, one('another', 4)], sections)).toBeNull()
    const seen = settleOutside([a, own, one('later side request', 5)], sections)
    expect(seen?.atMs).toBe(2)
    expect(seen?.pieces.map(p => outsideName(p.text))).toEqual(['计费标记', '身份声明', HOST_RULES.slice(0, 47) + '…'])
    expect([seen?.matched, seen?.blocks, seen?.model]).toEqual([3, 4, 'm'])
  })

  test('a piece is named for what it is, else by its first line; the sections have a mark that changes with them', () => {
    expect(outsideName(BILLING)).toBe('计费标记')
    expect(outsideName(IDENTITY)).toBe('身份声明')
    expect(outsideName(HOST_RULES)).toBe(HOST_RULES.slice(0, 47) + '…')
    expect(outsideName('\n\n## Action categories\nmore')).toBe('Action categories')
    expect(outsideName('   ')).toBe('（空）')
    const a = sectionsMark([{ id: 'intro', text: INTRO, scope: 'shared' }, { id: 'tone', text: TONE, scope: 'shared' }])
    expect(a).toBe(`intro:${INTRO.length}|tone:${TONE.length}`)
    expect(sectionsMark([{ id: 'intro', text: INTRO, scope: 'shared' }])).not.toBe(a)
    expect(sectionsMark(null)).toBe('')
  })
})

/**
 * A stand-in for the engine's own sender: the kit raises no request of the engine's, so a plugin
 * beside Atlas sends them, and Atlas's hook sees them pass as it sees the engine's. `/send <url>
 * <body>` sends one and answers with what came back.
 */
const asEngine: Plugin = {
  name: 'sender',
  register: on => {
    on('command.run', { command: 'send' }, async ($, e) => {
      const at = e.args.indexOf(' ')
      const url = at < 0 ? e.args : e.args.slice(0, at)
      const body = at < 0 ? undefined : e.args.slice(at + 1)
      const res = await $.http.fetch(url, body === undefined ? {} : { method: 'POST', body: body.startsWith('base64:') ? { base64: body.slice(7) } : body })
      return { text: res.text }
    })
  },
}

async function send($: Engine, url: string, body?: string): Promise<string> {
  const out = await $.command.run({ command: 'send', args: body === undefined ? url : `${url} ${body}`, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  return String(out.text ?? '')
}

const MESSAGES = 'https://api.anthropic.com/v1/messages'

function asBoth(name: string, body: ($: Engine, on: On, surface: Surface) => Promise<void>): void {
  for (const surface of SURFACES) test(`${name} (${surface})`, { plugins: [asEngine], timeoutMs: 20_000 }, ($, on) => body($, on, surface))
}

asBoth('提示词: what a request carries outside the sections is listed read-only once one is sent, and the request goes on untouched', async ($, on, surface) => {
  const sent: unknown[] = []
  on('http.fetch', ($, e) => {
    sent.push(e.init?.body)
    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })
  const { ui } = await openPrompt($, on, surface)
  // before any request: said plainly, with nothing to open
  expect(await ui.find({ type: 'Text', text: /还没读到：Atlas 加载（或重新加载）之后，这个会话还没有发出过请求/ })).toBeDefined()
  expect(await buttonKeys(ui, 'out:')).toEqual([])
  // another prompt's request (a subagent's) is kept, found not to be this session's, and said so
  const foreign = JSON.stringify({ model: 'claude-test', system: [{ type: 'text', text: 'A subagent prompt with nothing in common.' }], messages: [] })
  await send($, `${MESSAGES}?beta=true`, foreign)
  // a request that is not a model request is not read at all
  await send($, 'https://api.anthropic.com/api/event_logging/v2/batch', requestBody())
  expect(await buttonKeys(ui, 'out:')).toEqual([])
  expect(await ui.find({ type: 'Text', text: /看过 1 个请求，还没有一个对得上上面这些段/ })).toBeDefined()
  // the session's own: read, listed in the order sent
  const body = requestBody()
  await send($, `${MESSAGES}?beta=true`, body)
  expect(sent).toEqual([foreign, requestBody(), body])
  expect(await buttonKeys(ui, 'out:')).toEqual(['out:0', 'out:1', 'out:2'])
  expect(await rowName(ui, surface, 'out:0')).toMatch(/^计费标记/)
  expect(await rowName(ui, surface, 'out:1')).toMatch(/^身份声明/)
  expect(await rowName(ui, surface, 'out:2')).toMatch(/^Your priority is to complete the request/)
  expect(await ui.find({ type: 'Text', text: /关不掉也改不了/ })).toBeDefined()
  // its page: the text as sent, a copy button, and no switch of any kind
  await ui.press({ key: 'out:2' })
  expect(await ui.find({ type: 'Text', text: HOST_RULES })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: new RegExp(`第 4 块里 · ${HOST_RULES.length} 字符 · 约 ${approxTokens(HOST_RULES)} tokens · 只读`) })).toBeDefined()
  expect(await ui.find({ key: 'out-copy' })).toBeDefined()
  for (const key of ['s-toggle', 's-rewrite', 'inj-toggle', 'scope:section', 'scope:inject']) expect(await ui.find({ key }), key).toBeUndefined()
  await ui.press({ key: 'back' })
  // read once: a later request is not parsed again until the page asks
  await send($, MESSAGES, requestBody('Other rules now.'))
  expect(await rowName(ui, surface, 'out:2')).toMatch(/^Your priority/)
  await ui.press({ key: 'p-reload' })
  await send($, MESSAGES, requestBody('Other rules now.'))
  expect(await rowName(ui, surface, 'out:2')).toMatch(/^Other rules now\./)
  await ui.unmount()
})

asBoth('提示词: a look at a request that cannot be read costs the request nothing', async ($, on, surface) => {
  const sent: unknown[] = []
  on('http.fetch', ($, e) => {
    sent.push(e.init?.body)
    return { value: { status: 200, ok: true, headers: {}, text: 'answered' } }
  })
  const { ui } = await openPrompt($, on, surface)
  for (const body of ['{"system": broken', 'x', JSON.stringify({ system: 5 })]) expect(await send($, MESSAGES, body)).toBe('answered')
  // bytes instead of text, and no body at all
  expect(await send($, MESSAGES, 'base64:AAAA')).toBe('answered')
  expect(await send($, MESSAGES)).toBe('answered')
  expect(sent.length).toBe(5)
  expect(await buttonKeys(ui, 'out:')).toEqual([])
  await ui.unmount()
})

asBoth('提示词: a request sent before the page was ever opened is listed as soon as the page is', async ($, on, surface) => {
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '{}' } }))
  const w = world(on)
  await start($, w)
  // the pane is up on another page: nothing has composed the prompt for Atlas yet
  await send($, `${MESSAGES}?beta=true`, JSON.stringify({ model: 'claude-test', system: [{ type: 'text', text: 'A side request of the engine.' }], messages: [] }))
  await send($, `${MESSAGES}?beta=true`, requestBody())
  const ui = await mountPane($, surface)
  await ui.press({ key: 'tab:prompt' })
  expect(await buttonKeys(ui, 'out:')).toEqual(['out:0', 'out:1', 'out:2'])
  expect(await rowName(ui, surface, 'out:2')).toMatch(/^Your priority is to complete the request/)
  await ui.unmount()
})

asBoth('提示词: a pane left on this page reads the prompt again by itself when the module starts anew', async ($, on, surface) => {
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '{}' } }))
  // what a reload leaves: the view still on 提示词, and nothing held by the module
  const wrote = { view: false }
  on('state.set', { plugin: 'atlas', key: 'view' }, ($, e, next) => {
    wrote.view = true
    return next(e)
  })
  on('state.get', { plugin: 'atlas', key: 'view' }, ($, e, next) => (wrote.view ? next(e) : { value: { value: { ...VIEW0, tab: 'prompt' as const }, version: 0 } }))
  const w = world(on)
  await start($, w)
  const ui = await mountPane($, surface)
  // no tab was pressed and no 重新读取: the sections are there, and a request sent now is read
  expect((await buttonKeys(ui, 'sec:')).sort()).toEqual(['sec:env_info_simple', 'sec:intro', 'sec:tone'])
  expect(await ui.find({ key: 'p-none' })).toBeUndefined()
  await send($, MESSAGES, requestBody())
  expect(await buttonKeys(ui, 'out:')).toEqual(['out:0', 'out:1', 'out:2'])
  await ui.unmount()
})
