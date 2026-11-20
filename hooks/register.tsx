// atlas: a pane over a person's memory folders, CLAUDE.md files, sessions and
// skills (bin/atlas.py indexes them), the switches that decide what this
// session loads, and the hooks that enforce them.
//
// Every function that touches `$` or `$.state` lives in this file: the
// engine follows `$` only into functions declared in the same file, and reads
// state only through atoms declared here. model.ts, text.ts, views.tsx and
// window.ts are pure.

import { atom, read, update as engineUpdate } from 'claude-code'
import type { Atom, EngineInterface, InstructionFile, Register, RenderSurface } from 'claude-code'

import type {
  AtlasCtx,
  AtlasExtra,
  AtlasFile,
  AtlasFmDraft,
  AtlasHookDraft,
  AtlasLoaded,
  AtlasManage,
  AtlasParkedHook,
  AtlasPromptEdits,
  AtlasPromptExtra,
  AtlasMemoryState,
  AtlasMerge,
  AtlasOp,
  AtlasPrefs,
  AtlasRoute,
  AtlasScan,
  AtlasScope,
  AtlasSearch,
  AtlasSwitches,
  AtlasTrash,
  AtlasTrashItem,
  AtlasView,
} from '../types'
import { asPost } from './boards'
import type { BoardPost } from './boards'
import type { Issue, MemoryFile, SearchHit, TrashMeta } from './data'
import { isIndex } from './data'
import {
  CTX0,
  EXTRA0,
  FILE0,
  LOADED0,
  MEMORY_DENY,
  MERGE0,
  MERGE_SYSTEM,
  MOUNT_LIMIT,
  OP0,
  PANE,
  NEVER,
  PATH_TOOLS,
  PREFS0,
  TEXT_EXT,
  SCAN0,
  SEARCH0,
  SKILL_DENY,
  SKILL_PATH_TOOLS,
  isKeep,
  keepNote,
  SKILL_PROMPT_OFF,
  SWITCHES0,
  TITLE,
  TRASH0,
  VIEW0,
  allGroups,
  archiveLabel,
  bashHits,
  currentGroupId,
  deadLinkName,
  draftFor,
  errText,
  folderOf,
  groupOfPath,
  groupPaths,
  guardFallback,
  held,
  isProjectGroup,
  lastLine,
  memState,
  memoryIndexPath,
  normalizePrefs,
  offRoots,
  parseJson,
  projectBySlug,
  projectClaudeMdPaths,
  summary,
  titleOf,
  toolPaths,
} from './model'
import {
  addFrontmatter,
  appendLine,
  basename,
  dirname,
  filterSkillListing,
  generateIndex,
  indexLine,
  isInside,
  lineDiff,
  linkTargets,
  parseFrontmatter,
  parseTzOffset,
  removeIndexLinks,
  reorderIndexLinks,
  shortPath,
  slashes,
  splitLines,
  stripFence,
} from './text'
import {
  EDITS0,
  EXTRA_PREFIX,
  LOAD0,
  MANAGE0,
  OUTSIDE_TRIES,
  addHook,
  applyCompose,
  draftHook,
  dropExtra,
  editSettings,
  extraId,
  heldM,
  injectOffOf,
  isOwnPrompt,
  mergeEdits,
  outsideOf,
  parkedId,
  parkedOf,
  promptPrefs,
  putExtra,
  recordInject,
  recordTool,
  removeAt,
  renameOf,
  renameUser,
  rowId,
  scanHooks,
  sectionAnswer,
  sectionsMark,
  sessionEdits,
  setInjectOff,
  setOff,
  setRename,
  setRewrite,
  setToolPlace,
  setToolRewrite,
  settingsFiles,
  systemBlocks,
  toolAnswer,
  toolOffDeny,
  toolPlaceOf,
  updateAt,
} from './manage'
import type { HookPatch, HooksTable, SectionSeen } from './manage'
import { drawPane } from './views'
import type { Actions, Snap } from './views'
import {
  WINDOW_ALREADY,
  WINDOW_NO_SURFACE,
  WINDOW_OPENED,
  heldW,
  noteTree,
  readHelperLine,
  serializeTree,
  startFailure,
  takeLines,
  tokenOf,
  windowFocus,
  windowOff,
  windowPage,
  windowSize,
  windowStale,
  windowSuits,
  windowTable,
  windowToast,
  windowWants,
  windowWish,
} from './window'
import type { WindowAct, WindowEvent, WindowWish } from './window'

type E = EngineInterface

const scanA = atom({ plugin: 'atlas', key: 'scan' } as const, SCAN0)
const viewA = atom({ plugin: 'atlas', key: 'view' } as const, VIEW0)
const searchA = atom({ plugin: 'atlas', key: 'search' } as const, SEARCH0)
const fileA = atom({ plugin: 'atlas', key: 'file' } as const, FILE0)
const ctxA = atom({ plugin: 'atlas', key: 'ctx' } as const, CTX0)
const switchesA = atom({ plugin: 'atlas', key: 'switches' } as const, SWITCHES0)
const prefsA = atom({ plugin: 'atlas', key: 'prefs' } as const, PREFS0)
const loadedA = atom({ plugin: 'atlas', key: 'loaded' } as const, LOADED0)
const mergeA = atom({ plugin: 'atlas', key: 'merge' } as const, MERGE0)
const opA = atom({ plugin: 'atlas', key: 'op' } as const, OP0)
const extraA = atom({ plugin: 'atlas', key: 'extra' } as const, EXTRA0)
const tickA = atom({ plugin: 'atlas', key: 'tick' } as const, 0)
const trashA = atom({ plugin: 'atlas', key: 'trash' } as const, TRASH0)
const manageA = atom({ plugin: 'atlas', key: 'manage' } as const, MANAGE0)

/** The person's userConfig values, set once per load by register. */
const config = { editorModel: 'sonnet', trashDays: '7' }

// ---------- held in the module (lost on reload; rebuilt) ----------

async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

/**
 * Every write of Atlas's state: the engine's own `update`, after which the
 * browser window, if one is open, is due a new drawing. The pane needs no
 * telling (a write wakes the drawings that read the value), and a hook of
 * Atlas's own on `state.set` would not do: a write made after a hook has
 * returned (a scan's, or a press in the window) passes it by.
 */
async function update<T>($: E, target: Atom<T>, change: (value: T) => T): Promise<T> {
  const next = await writeState($, target, change)
  windowStale()
  return next as T
}

/** The engine's `update` reads the value it writes off the source, so each atom is named where it is written. */
function writeState($: E, target: unknown, change: unknown): Promise<unknown> {
  switch (target) {
    case scanA:
      return engineUpdate($, scanA, change as never)
    case viewA:
      return engineUpdate($, viewA, change as never)
    case searchA:
      return engineUpdate($, searchA, change as never)
    case fileA:
      return engineUpdate($, fileA, change as never)
    case ctxA:
      return engineUpdate($, ctxA, change as never)
    case switchesA:
      return engineUpdate($, switchesA, change as never)
    case prefsA:
      return engineUpdate($, prefsA, change as never)
    case loadedA:
      return engineUpdate($, loadedA, change as never)
    case mergeA:
      return engineUpdate($, mergeA, change as never)
    case opA:
      return engineUpdate($, opA, change as never)
    case extraA:
      return engineUpdate($, extraA, change as never)
    case tickA:
      return engineUpdate($, tickA, change as never)
    case trashA:
      return engineUpdate($, trashA, change as never)
    case manageA:
      return engineUpdate($, manageA, change as never)
    default:
      return Promise.reject(new Error('atlas: a write to a value register.tsx does not name'))
  }
}

function toast($: E, text: string): void {
  // the window shows it too, while one is listening; the terminal still gets it
  windowToast(text)
  try {
    $.ui.toast(text)
  } catch {
    // a toast is never worth failing for
  }
}

function focusSoon($: E, key: string): void {
  windowFocus(key)
  try {
    void $.ui.focus({ requestId: PANE, key }).catch(() => undefined)
  } catch {
    // focus is a nicety
  }
}

/** A press whose work is not awaited: what it throws is told in a toast. */
function told($: E, work: Promise<unknown>): void {
  void work.catch(err => toast($, `没有完成：${errText(err)}`))
}

async function bump($: E): Promise<void> {
  await update($, tickA, (n): number => n + 1)
}

// ---------- context ----------

async function ensureCtx($: E, cwdHint?: string): Promise<AtlasCtx> {
  const cur = await read($, ctxA)
  if (cur.home && cur.cwd && cur.claudeDir && cwdHint === undefined) return cur
  // Windows names the home folder USERPROFILE, and says it is Windows in OS; its paths are kept with
  // forward slashes like every other, so one way of splitting and comparing holds
  const win = cur.win ?? (await safe(() => $.env.get('OS'))) === 'Windows_NT'
  const home = slashes(cur.home || held.index?.home || (await safe(() => $.env.get('HOME'))) || (await safe(() => $.env.get('USERPROFILE'))) || '')
  const cfg = await safe(() => $.env.get('CLAUDE_CONFIG_DIR'))
  const claudeDir = slashes(cur.claudeDir || held.index?.claudeDir || cfg || (home ? `${home}/.claude` : ''))
  const cwd = slashes(cwdHint || cur.cwd || (await safe(() => $.session.root())) || (await safe(() => $.session.cwd())) || '')
  const next = { ...cur, home, claudeDir, cwd, win }
  await update($, ctxA, (c): AtlasCtx => ({ ...c, home: next.home, claudeDir: next.claudeDir, cwd: next.cwd, win: next.win }))
  held.mirrorCtx = next
  return next
}

// ---------- prefs ($.store 'prefs', mirrored in state) ----------

async function loadPrefs($: E): Promise<AtlasPrefs> {
  const raw = await safe(() => $.store.get('prefs'))
  const prefs = normalizePrefs(raw)
  await update($, prefsA, (): AtlasPrefs => prefs)
  return prefs
}

/** The stored prefs, read strictly: a store that cannot be read throws, so nothing is saved over it. */
async function storedPrefs($: E): Promise<AtlasPrefs> {
  let raw: unknown
  try {
    raw = await $.store.get('prefs')
  } catch (err) {
    throw new Error(`读不到 Atlas 存的设置（${errText(err)}），这次没有保存`)
  }
  return normalizePrefs(raw)
}

async function savePrefs($: E, change: (p: AtlasPrefs) => AtlasPrefs): Promise<AtlasPrefs> {
  const fresh = await storedPrefs($)
  const next = change(fresh)
  await $.store.set('prefs', next)
  await update($, prefsA, (): AtlasPrefs => next)
  return next
}

/** Session start: the session's switches from the stored defaults, once. */
async function seed($: E, startedIn: string): Promise<void> {
  const cwd = slashes(startedIn)
  const ctx = await read($, ctxA)
  const sessionId = ctx.sessionId || (await safe(() => $.session.id())) || ''
  if (ctx.seeded) {
    held.mirror = await read($, switchesA)
    if (!ctx.sessionId && sessionId) await update($, ctxA, (c): AtlasCtx => ({ ...c, sessionId }))
    return
  }
  const prefs = await loadPrefs($)
  const skillsOff = [...new Set([...prefs.skillsOff.global, ...(prefs.skillsOff.byProject[cwd] ?? [])])]
  const skillDirs: Record<string, string> = {}
  for (const name of skillsOff) {
    const dir = prefs.skillDirs[name]
    if (dir) skillDirs[name] = dir
  }
  const memory = { ...prefs.memory.defaults.global, ...(prefs.memory.defaults.byProject[cwd] ?? {}) }
  const pp = promptPrefs(prefs)
  const sw: AtlasSwitches = { skillsOff, skillDirs, memory, files: {}, prompt: mergeEdits(pp.global, pp.byProject[cwd]), promptNow: false }
  await update($, switchesA, (): AtlasSwitches => sw)
  held.mirror = sw
  await update($, ctxA, (c): AtlasCtx => ({ ...c, seeded: true, sessionId, cwd: cwd || c.cwd }))
  await ensureCtx($)
}

// ---------- scanning ----------

/** The command line that runs atlas.py here: the system's own Python 3 on a Mac, `python` from PATH on Windows. */
async function atlasArgv($: E, args: readonly string[]): Promise<string[]> {
  const ctx = await ensureCtx($)
  return [ctx.win ? await windowsPython($, ctx.home) : '/usr/bin/python3', '-I', `${slashes($.plugin.root)}/bin/atlas.py`, ...args]
}

/**
 * The interpreter on Windows: a real one under uv's install folder when
 * there is one, the newest first, else `python` from PATH. uv's `python` on
 * PATH is a small launcher that names one exact version and fails once that
 * version is gone, so the interpreter itself is the surer thing to run.
 */
async function windowsPython($: E, home: string): Promise<string> {
  if (held.python) return held.python
  let found = 'python'
  try {
    const root = slashes((await safe(() => $.env.get('UV_PYTHON_INSTALL_DIR'))) || `${home}/.local/share/uv/python`).replace(/\/$/, '')
    const version = (name: string) => {
      const m = /^cpython-3\.(\d+)\.(\d+)-windows/.exec(name)
      return m ? Number(m[1]) * 1000 + Number(m[2]) : -1
    }
    const names = (await $.fs.list(root))
      .map(entry => entry.name)
      .filter(name => version(name) >= 9000)
      .sort((a, b) => version(b) - version(a))
    for (const name of names) {
      const exe = `${root}/${name}/python.exe`
      if (await exists($, exe)) {
        found = exe
        break
      }
    }
  } catch {
    // no such folder: PATH it is
  }
  held.python = found
  return found
}

function startScan($: E): Promise<void> {
  if (held.scanning) return held.scanning
  held.scanning = (async () => {
    try {
      await doScan($)
    } catch (err) {
      await update($, scanA, (s): AtlasScan => ({ ...s, status: 'error', error: `扫描出错：${errText(err)}` }))
    } finally {
      held.scanning = null
    }
  })()
  return held.scanning
}

async function doScan($: E): Promise<void> {
  await update($, scanA, (s): AtlasScan => ({ ...s, status: 'scanning', error: null }))
  const ctx = await ensureCtx($)
  let tz = (await read($, scanA)).tzOffsetMin
  if (tz === null) {
    const r = ctx.win ? undefined : await safe(() => $.process.run(['/bin/date', '+%z']))
    tz = r && r.exitCode === 0 ? parseTzOffset(r.stdout) : null
    if (tz === null) tz = -new Date().getTimezoneOffset()
  }
  const argv = await atlasArgv($, ['index'])
  if (ctx.cwd) argv.push('--current-cwd', ctx.cwd)
  const fail = (error: string) => update($, scanA, (s): AtlasScan => ({ ...s, status: 'error', error, tzOffsetMin: tz }))
  let res
  try {
    res = await $.process.run(argv, { timeoutMs: 180_000 })
  } catch (err) {
    await fail(`atlas.py 没能运行：${errText(err)}`)
    return
  }
  const parsed = parseJson(res.stdout)
  if (res.exitCode !== 0) {
    const said = typeof parsed === 'object' && parsed !== null ? (parsed as { error?: unknown }).error : undefined
    await fail(`atlas.py 出错（退出码 ${res.exitCode}）：${typeof said === 'string' ? said : lastLine(res.stderr) || lastLine(res.stdout) || '没有输出'}`)
    return
  }
  if (res.isStdoutTruncated || !isIndex(parsed)) {
    await fail(`无法解析 atlas.py 的输出${res.isStdoutTruncated ? '（超过 4 MiB 被截断）' : ''}`)
    return
  }
  held.index = parsed
  held.dirty = false
  if (!ctx.home || !ctx.claudeDir) {
    await update($, ctxA, (c): AtlasCtx => ({ ...c, home: c.home || parsed.home, claudeDir: c.claudeDir || parsed.claudeDir }))
  }
  await rememberSkillDirs($)
  await update($, scanA, (s): AtlasScan => ({
    status: 'done',
    dataVersion: s.dataVersion + 1,
    error: null,
    generatedAtMs: parsed.generatedAtMs,
    elapsedMs: parsed.elapsedMs,
    tzOffsetMin: tz,
  }))
}

function rescanIfDirty($: E): void {
  if (held.dirty) void startScan($)
}

async function rememberSkillDirs($: E): Promise<void> {
  const sw = await read($, switchesA)
  const dirs: Record<string, string> = {}
  for (const name of sw.skillsOff) {
    const p = held.index?.skills.find(s => s.name === name)?.path
    if (p && !sw.skillDirs[name]) dirs[name] = dirname(p)
  }
  if (Object.keys(dirs).length) {
    await update($, switchesA, (s): AtlasSwitches => {
      const next = { ...s, skillDirs: { ...s.skillDirs, ...dirs } }
      held.mirror = next
      return next
    })
  }
}

// ---------- search ----------

async function runSearch($: E, query: string): Promise<void> {
  const q = query.trim()
  if (!q) {
    await update($, searchA, (): AtlasSearch => SEARCH0)
    return
  }
  await update($, searchA, (): AtlasSearch => ({ status: 'searching', query: q, error: null, results: [] }))
  let res
  try {
    res = await $.process.run(await atlasArgv($, ['search', q, '--limit', '200']), { timeoutMs: 60_000 })
  } catch (err) {
    await update($, searchA, (s): AtlasSearch => ({ ...s, status: 'error', error: `搜索没能运行：${errText(err)}` }))
    return
  }
  const parsed = parseJson(res.stdout) as { results?: SearchHit[]; error?: string } | undefined
  if (res.exitCode !== 0 || !parsed || !Array.isArray(parsed.results)) {
    const said = parsed?.error ?? (lastLine(res.stderr) || '无法解析输出')
    await update($, searchA, (s): AtlasSearch => ({ ...s, status: 'error', error: `搜索出错：${said}` }))
    return
  }
  const results = parsed.results.slice(0, 200).map(r => ({
    path: r.path,
    projectSlug: r.projectSlug ?? null,
    scope: r.scope,
    line: r.line,
    text: String(r.text ?? '').slice(0, 200),
  }))
  await update($, searchA, (s): AtlasSearch => ({ ...s, status: 'done', results }))
}

// ---------- groups ----------

function invalidateMemory($: E): void {
  try {
    $.ui.invalidate('prompt.context')
    $.ui.invalidate('prompt.section')
  } catch {
    // nothing cached yet
  }
}

function invalidateSkills($: E): void {
  try {
    $.ui.invalidate('prompt.attachment')
  } catch {
    // nothing cached yet
  }
}

async function setMemoryState($: E, scope: AtlasScope, id: string, state: AtlasMemoryState): Promise<void> {
  const ctx = await ensureCtx($)
  if (scope === 'session') {
    await update($, switchesA, (s): AtlasSwitches => {
      const next = { ...s, memory: { ...s.memory, [id]: state } }
      held.mirror = next
      return next
    })
    invalidateMemory($)
    return
  }
  await savePrefs($, p => {
    const d = p.memory.defaults
    if (scope === 'global') return { ...p, memory: { defaults: { ...d, global: { ...d.global, [id]: state } } } }
    const mine = { ...(d.byProject[ctx.cwd] ?? {}), [id]: state }
    return { ...p, memory: { defaults: { ...d, byProject: { ...d.byProject, [ctx.cwd]: mine } } } }
  })
}

async function setFileState($: E, path: string, state: AtlasMemoryState): Promise<void> {
  await update($, switchesA, (s): AtlasSwitches => {
    const files = { ...s.files }
    if (state === 'mount') delete files[path]
    else files[path] = state
    const next = { ...s, files }
    held.mirror = next
    return next
  })
  invalidateMemory($)
}

async function setSkillState($: E, scope: AtlasScope, name: string, off: boolean): Promise<void> {
  const ctx = await ensureCtx($)
  const p = held.index?.skills.find(s => s.name === name)?.path
  const dir = p ? dirname(p) : undefined
  const edit = (list: string[]) => (off ? [...new Set([...list, name])] : list.filter(n => n !== name))
  if (scope === 'session') {
    await update($, switchesA, (s): AtlasSwitches => {
      const skillDirs = { ...s.skillDirs }
      if (dir) skillDirs[name] = dir
      const next = { ...s, skillsOff: edit(s.skillsOff), skillDirs }
      held.mirror = next
      return next
    })
    invalidateSkills($)
    return
  }
  await savePrefs($, pr => {
    const skillDirs = dir ? { ...pr.skillDirs, [name]: dir } : pr.skillDirs
    if (scope === 'global') return { ...pr, skillDirs, skillsOff: { ...pr.skillsOff, global: edit(pr.skillsOff.global) } }
    const mine = edit(pr.skillsOff.byProject[ctx.cwd] ?? [])
    return { ...pr, skillDirs, skillsOff: { ...pr.skillsOff, byProject: { ...pr.skillsOff.byProject, [ctx.cwd]: mine } } }
  })
}

async function readSwitches($: E): Promise<AtlasSwitches> {
  const sw = await read($, switchesA)
  held.mirror = sw
  return sw
}

async function realOf($: E, p: string): Promise<string> {
  const hit = held.realCache.get(p)
  if (hit) return hit
  let real = p
  try {
    real = slashes((await $.fs.stat(p, { resolve: true })).realPath ?? p)
  } catch {
    try {
      const parent = (await $.fs.stat(dirname(p), { resolve: true })).realPath
      if (parent) real = `${slashes(parent).replace(/\/$/, '')}/${basename(p)}`
    } catch {
      real = p
    }
  }
  if (held.realCache.size > 500) held.realCache.clear()
  held.realCache.set(p, real)
  return real
}

async function insideAny($: E, paths: readonly string[], roots: readonly string[]): Promise<boolean> {
  if (roots.length === 0 || paths.length === 0) return false
  if (paths.some(p => roots.some(r => isInside(p, r)))) return true
  const realPaths = await Promise.all(paths.map(p => realOf($, p)))
  const realRoots = await Promise.all(roots.map(r => realOf($, r)))
  return realPaths.some(p => [...roots, ...realRoots].some(r => isInside(p, r)))
}

/** The refusal a call earns because the 工具 page switched its tool off for this session, or null. */
async function toolOffDecision($: E, tool: string): Promise<string | null> {
  const sw = await readSwitches($)
  return toolPlaceOf(sessionEdits(sw), tool) === 'off' ? toolOffDeny(tool) : null
}

/** The refusal a tool call earns from the switches, or null. */
async function guardDecision($: E, e: Record<string, unknown>): Promise<string | null> {
  const tool = String(e.tool)
  if (tool !== 'Bash' && !Object.hasOwn(PATH_TOOLS, tool)) return null
  const sw = await readSwitches($)
  if (sw.skillsOff.length === 0 && !Object.values(sw.memory).includes('off') && !Object.values(sw.files).includes('off')) return null
  const ctx = held.mirrorCtx ?? (await ensureCtx($))
  held.mirrorCtx = ctx
  const prefs = await read($, prefsA)
  const roots = offRoots(sw, ctx, prefs)
  if (tool === 'Bash') {
    const cmd = typeof e.command === 'string' ? e.command : ''
    if (bashHits(cmd, roots.skills, ctx.home)) return SKILL_DENY
    if (bashHits(cmd, roots.memory, ctx.home)) return MEMORY_DENY
    return null
  }
  const paths = toolPaths(e, tool, ctx)
  if (SKILL_PATH_TOOLS.has(tool) && (await insideAny($, paths, roots.skills))) return SKILL_DENY
  if (await insideAny($, paths, roots.memory)) return MEMORY_DENY
  return null
}

/** prompt.context: record what loaded, then drop / add per the switches. */
async function shapeInstructionFiles($: E, files: readonly InstructionFile[]): Promise<InstructionFile[] | null> {
  const sw = await readSwitches($)
  const ctx = await ensureCtx($)
  const prefs = await read($, prefsA)
  const curId = currentGroupId(ctx)
  const groups = allGroups(ctx, prefs)
  const offRootsList = offRoots(sw, ctx, prefs).memory
  const dropped = new Set<string>()
  for (const f of files) {
    const own = sw.files[f.path]
    if (own === 'read' || own === 'off') dropped.add(f.path)
    if (offRootsList.some(r => isInside(slashes(f.path), r))) dropped.add(f.path)
    if (f.kind === 'memory' && !f.parent && memState(sw, curId, curId) === 'read') {
      const g = groups.find(x => x.id === curId)
      const roots = g?.paths ?? groupPaths(curId, ctx, prefs)
      if (roots.some(r => isInside(slashes(f.path), r))) dropped.add(f.path)
    }
  }
  // an import of a dropped file goes with it
  let grew = true
  while (grew) {
    grew = false
    for (const f of files) {
      if (f.parent && dropped.has(f.parent) && !dropped.has(f.path)) {
        dropped.add(f.path)
        grew = true
      }
    }
  }
  const kept = files.filter(f => !dropped.has(f.path))
  const added: InstructionFile[] = []
  const skipped: { path: string; reason: string }[] = []
  const ids = new Set([...groups.map(g => g.id), ...Object.keys(sw.memory)])
  for (const id of ids) {
    if (memState(sw, id, curId) !== 'mount') continue
    // the session's own project loads as Claude Code loads it, unless 挂载 was chosen for it
    if (id === curId && sw.memory[curId] !== 'mount') continue
    const roots = groups.find(g => g.id === id)?.paths ?? groupPaths(id, ctx, prefs)
    if (kept.some(f => roots.some(r => isInside(f.path, r)))) continue
    for (const root of roots) {
      for (const path of await mountFiles($, root)) {
        if (kept.some(f => f.path === path) || added.some(f => f.path === path)) continue
        const st = await safe(() => $.fs.stat(path))
        if (!st || st.kind !== 'file') continue
        if (st.size > MOUNT_LIMIT) {
          skipped.push({ path, reason: `超过 100 KB（${Math.round(st.size / 1024)} KB），没有挂载` })
          continue
        }
        const content = await safe(() => $.fs.read(path))
        if (typeof content !== 'string') {
          skipped.push({ path, reason: '读不出来，没有挂载' })
          continue
        }
        added.push({ path, kind: 'memory', content })
      }
    }
  }
  await update($, loadedA, (): AtlasLoaded => ({
    files: files.map(f => ({ path: f.path, kind: f.kind, ...(f.parent ? { parent: f.parent } : {}), chars: f.content.length })),
    recordedAtMs: Date.now(),
    added: added.map(f => f.path),
    removed: [...dropped],
    skipped,
  }))
  if (dropped.size === 0 && added.length === 0) return null
  return [...kept, ...added]
}

async function mountFiles($: E, root: string): Promise<string[]> {
  const st = await safe(() => $.fs.stat(root))
  if (!st) return []
  if (st.kind === 'file') return [root]
  const index = `${root.replace(/\/$/, '')}/MEMORY.md`
  if (await safe(() => $.fs.exists(index))) return [index]
  const entries = (await safe(() => $.fs.list(root))) ?? []
  return entries
    .filter(x => x.kind === 'file' && x.name.endsWith('.md'))
    .map(x => `${root.replace(/\/$/, '')}/${x.name}`)
    .sort()
}

// ---------- views ----------

async function setView($: E, change: (v: AtlasView) => AtlasView): Promise<void> {
  await update($, viewA, change)
}

async function push($: E, route: AtlasRoute, focus = 'back'): Promise<void> {
  await update($, viewA, (v): AtlasView => ({ ...v, stack: [...v.stack, route] }))
  if (route.kind === 'project') void loadClaudeMds($, route.slug)
  if (route.kind === 'skill') void loadSkillFiles($, route.name)
  if (route.kind === 'file') await openFile($, route.path, { line: route.line })
  if (route.kind === 'section' && !heldM.composed) void loadPrompt($)
  if ((route.kind === 'tool' || route.kind === 'toolserver') && !heldM.toolList) void loadTools($, false)
  if ((route.kind === 'hook' || route.kind === 'hooknew') && !heldM.hooks) void loadHooks($)
  focusSoon($, focus)
}

async function back($: E): Promise<void> {
  const v = await read($, viewA)
  const top = v.stack[v.stack.length - 1]
  await update($, viewA, (x): AtlasView => ({ ...x, stack: x.stack.slice(0, -1) }))
  const under = v.stack[v.stack.length - 2]
  if (under?.kind === 'file') await openFile($, under.path, {})
  if (top?.kind === 'file') rescanIfDirty($)
  focusSoon($, top?.from ?? 'tab:' + v.tab)
}

async function switchTab($: E, tab: AtlasView['tab']): Promise<void> {
  const v = await read($, viewA)
  if (v.stack.some(r => r.kind === 'file')) rescanIfDirty($)
  await update($, viewA, (x): AtlasView => ({ ...x, tab, stack: [], pending: null }))
  if (tab === 'trash') void loadTrash($)
  if (tab === 'prompt') void loadPrompt($)
  if (tab === 'tools') void loadTools($, false)
  if (tab === 'hooks') void loadHooks($)
  focusSoon($, `tab:${tab}`)
}

// ---------- files ----------

async function readText($: E, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

async function openFile(
  $: E,
  path: string,
  opts: { line?: number; mode?: 'read' | 'edit'; isNew?: boolean; fmDraft?: AtlasFmDraft },
): Promise<void> {
  const prev = await read($, fileA)
  const same = prev.path === path
  await update($, fileA, (): AtlasFile => ({
    ...FILE0,
    path,
    status: 'loading',
    mode: opts.mode ?? (same ? prev.mode : 'read'),
    anchor: opts.line ?? (same ? prev.anchor : 0),
    fmDraft: opts.fmDraft ?? null,
  }))
  const text = await readText($, path)
  if (text === null) {
    if (opts.isNew) {
      await update($, fileA, (f): AtlasFile => ({ ...f, status: 'ready', text: '', isNew: true, mode: 'edit' }))
    } else {
      await update($, fileA, (f): AtlasFile => ({ ...f, status: 'error', error: '读不到这个文件（不存在或没有权限）' }))
    }
    return
  }
  const st = await safe(() => $.fs.stat(path))
  await update($, fileA, (f): AtlasFile => ({ ...f, status: 'ready', text, size: st?.size ?? text.length, mtimeMs: st?.mtimeMs ?? 0 }))
}

/**
 * Writes the editor's file, its new text made from the text the editor
 * holds now; refused when the disk changed under it.
 */
async function saveText($: E, path: string, change: (text: string) => string): Promise<boolean> {
  const f = await read($, fileA)
  if (f.path !== path || f.status !== 'ready') return false
  const next = change(f.text)
  const disk = await readText($, path)
  const unchanged = f.isNew ? disk === null : disk === f.text
  if (!unchanged) {
    await update($, fileA, (x): AtlasFile => ({ ...x, stale: true }))
    return false
  }
  if (next === f.text && !f.isNew) return true
  try {
    await $.fs.write(path, next)
  } catch (err) {
    await update($, fileA, (x): AtlasFile => ({ ...x, note: `没有写成：${errText(err)}` }))
    return false
  }
  held.undo.set(path, f.isNew ? null : f.text)
  held.dirty = true
  const st = await safe(() => $.fs.stat(path))
  const lines = splitLines(next).length
  const warn = basename(path) === 'MEMORY.md' && lines > 200 ? `MEMORY.md 现在 ${lines} 行，超过 200 行的部分启动时不会加载` : null
  await update($, fileA, (x): AtlasFile => ({
    ...x,
    text: next,
    isNew: false,
    stale: false,
    fmDraft: null,
    size: st?.size ?? next.length,
    mtimeMs: st?.mtimeMs ?? x.mtimeMs,
    note: warn,
  }))
  await bump($)
  toast($, '已保存')
  return true
}

async function undoFile($: E, path: string): Promise<void> {
  if (!held.undo.has(path)) return
  const prev = held.undo.get(path) ?? null
  const f = await read($, fileA)
  const disk = await readText($, path)
  if (f.path === path && disk !== f.text) {
    await update($, fileA, (x): AtlasFile => ({ ...x, stale: true }))
    return
  }
  if (prev === null) {
    const moved = await trash($, path)
    if (!moved.ok) {
      toast($, `撤销没成功：${moved.error}`)
      return
    }
  } else {
    await $.fs.write(path, prev)
  }
  held.undo.delete(path)
  held.dirty = true
  await bump($)
  toast($, '已撤销')
  if (prev === null) {
    await update($, fileA, (x): AtlasFile => ({ ...x, text: '', isNew: true, size: 0 }))
  } else {
    const st = await safe(() => $.fs.stat(path))
    await update($, fileA, (x): AtlasFile => ({ ...x, text: prev, stale: false, size: st?.size ?? prev.length, mtimeMs: st?.mtimeMs ?? x.mtimeMs }))
  }
}

async function reloadFile($: E): Promise<void> {
  const f = await read($, fileA)
  if (f.path) await openFile($, f.path, { mode: f.mode, line: f.anchor, isNew: f.isNew })
}

// ---------- host commands ----------

async function run($: E, argv: string[]): Promise<{ ok: boolean; error: string }> {
  try {
    const r = await $.process.run(argv, { timeoutMs: 30_000 })
    return { ok: r.exitCode === 0, error: lastLine(r.stderr) || (r.exitCode === 0 ? '' : `退出码 ${r.exitCode}`) }
  } catch (err) {
    return { ok: false, error: errText(err) }
  }
}

async function exists($: E, path: string): Promise<boolean> {
  return (await safe(() => $.fs.exists(path))) === true
}

/** Asks atlas.py for one of its host commands (Windows): the error it gave, or null. */
async function atlasHost($: E, args: string[]): Promise<string | null> {
  const out = await atlasJson($, args)
  return typeof out === 'string' ? out : null
}

/** Moves a file into a folder, never over another: `mv -n` on a Mac, atlas.py's `move` on Windows. */
async function moveInto($: E, src: string, destDir: string): Promise<{ ok: boolean; error: string }> {
  if ((await ensureCtx($)).win) {
    const error = await atlasHost($, ['move', src, destDir])
    return { ok: error === null, error: error ?? '' }
  }
  return run($, ['/bin/mv', '-n', src, `${destDir}/`])
}

/** Moves a file to the system's trash: ~/.Trash with `mv -n` under a name not taken there, or the Recycle Bin on Windows. */
async function trash($: E, path: string): Promise<{ ok: true; to: string } | { ok: false; error: string }> {
  const ctx = await ensureCtx($)
  if (ctx.win) {
    const out = await atlasJson($, ['os-trash', path])
    if (typeof out === 'string') return { ok: false, error: out }
    const to = (out as { to?: unknown } | null)?.to
    return (await exists($, path)) ? { ok: false, error: '没能移到回收站' } : { ok: true, to: typeof to === 'string' ? to : '' }
  }
  if (!ctx.home) return { ok: false, error: '不知道 home 在哪' }
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let to = `${ctx.home}/.Trash/${name}`
  if (await exists($, to)) to = `${ctx.home}/.Trash/${stem} atlas-${Date.now()}${ext}`
  const r = await run($, ['/bin/mv', '-n', path, to])
  if ((await exists($, path)) || !(await exists($, to))) return { ok: false, error: r.error || '没能移到废纸篓' }
  return { ok: true, to }
}

async function reveal($: E, path: string): Promise<void> {
  if ((await ensureCtx($)).win) {
    const error = await atlasHost($, ['reveal', path])
    if (error !== null) toast($, `没能在资源管理器里显示：${error}`)
    return
  }
  const r = await run($, ['/usr/bin/open', '-R', path])
  if (!r.ok) toast($, `没能在 Finder 显示：${r.error}`)
}

async function openInEditor($: E, path: string): Promise<void> {
  if ((await ensureCtx($)).win) {
    const error = await atlasHost($, ['open', path, '--edit'])
    if (error !== null) toast($, `没能用编辑器打开：${error}`)
    return
  }
  const r = await run($, ['/usr/bin/open', '-t', path])
  if (!r.ok) toast($, `没能用编辑器打开：${r.error}`)
}

async function copyText($: E, text: string, surface: Parameters<E['ui']['copy']>[0]['surface']): Promise<void> {
  const res = await safe(() => $.ui.copy({ text, surface }))
  if (res?.isCopied) {
    toast($, '已复制')
    return
  }
  if ((await ensureCtx($)).win) {
    toast($, '没能复制')
    return
  }
  try {
    const r = await $.process.run(['/usr/bin/pbcopy'], { stdin: text, timeoutMs: 5000 })
    toast($, r.exitCode === 0 ? '已复制' : '没能复制')
  } catch {
    toast($, '没能复制')
  }
}

// ---------- structural operations (one level of undo, in memory) ----------

async function setOp($: E, label: string, canUndo: boolean, error: string | null = null): Promise<void> {
  await update($, opA, (o): AtlasOp => ({ id: o.id + 1, label, canUndo, error }))
}

async function undoOp($: E): Promise<void> {
  const fn = held.opUndo
  held.opUndo = null
  if (!fn) return
  const error = await fn()
  await setOp($, error ? `撤销没完全成功：${error}` : '已撤销', false, error)
  toast($, error ? '撤销没完全成功' : '已撤销')
  void startScan($)
}

/** Writes `next` over `path` only if it still holds `expect` (null: missing). */
async function writeIf($: E, path: string, expect: string | null, next: string): Promise<boolean> {
  const cur = await readText($, path)
  if (cur !== expect) return false
  await $.fs.write(path, next)
  return true
}

/** Board drop: move a memory file to another group's folder and fix both indexes. */
async function moveMemoryFile($: E, src: string, toId: string): Promise<void> {
  const ctx = await ensureCtx($)
  const prefs = await read($, prefsA)
  const groups = allGroups(ctx, prefs)
  const to = groups.find(g => g.id === toId)
  const from = groups.find(g => g.paths.some(r => isInside(src, r)))
  const destDir = to ? folderOf(to) : undefined
  if (!to || !destDir) {
    await setOp($, '', false, '找不到目标组')
    return
  }
  const name = basename(src)
  const dest = `${destDir.replace(/\/$/, '')}/${name}`
  if (from?.id === to.id) return
  if (await exists($, dest)) {
    await setOp($, '', false, `${to.name} 里已经有 ${name}，没有移动`)
    toast($, `${to.name} 里已经有同名文件，没有移动`)
    return
  }
  const srcText = await readText($, src)
  if (srcText === null) {
    await setOp($, '', false, `读不到 ${name}，没有移动`)
    return
  }
  const srcIndex = from && isProjectGroup(from) ? `${dirname(src)}/MEMORY.md` : null
  const destIndex = isProjectGroup(to) ? `${destDir.replace(/\/$/, '')}/MEMORY.md` : null
  const srcBefore = srcIndex ? await readText($, srcIndex) : null
  const destBefore = destIndex ? await readText($, destIndex) : null
  const moved = await moveInto($, src, destDir.replace(/\/$/, ''))
  if ((await exists($, src)) || !(await exists($, dest))) {
    await setOp($, '', false, `没有移动：${moved.error || 'mv 没有完成'}`)
    return
  }
  let srcAfter: string | null = null
  if (srcIndex && srcBefore !== null) {
    srcAfter = removeIndexLinks(srcBefore, name)
    if (srcAfter !== srcBefore) await $.fs.write(srcIndex, srcAfter)
    else srcAfter = null
  }
  let destAfter: string | null = null
  if (destIndex) {
    const base = destBefore ?? ''
    if (!splitLines(base).some(l => linkTargets(l.text).includes(name))) {
      const { title, description } = titleOf(srcText, name)
      destAfter = appendLine(base, indexLine(name, title, description))
      await $.fs.write(destIndex, destAfter)
    }
  }
  const fromDir = dirname(src)
  held.opUndo = async () => {
    if (await exists($, src)) return `原位置已经有 ${name}`
    await moveInto($, dest, fromDir)
    if (!(await exists($, src))) return '没能移回去'
    const problems: string[] = []
    if (srcIndex && srcAfter !== null && srcBefore !== null && !(await writeIf($, srcIndex, srcAfter, srcBefore))) {
      problems.push('原来的 MEMORY.md 后来又被改过，没有还原')
    }
    if (destIndex && destAfter !== null) {
      if (destBefore === null) {
        if ((await readText($, destIndex)) === destAfter) {
          const t = await trash($, destIndex)
          if (!t.ok) problems.push(t.error)
        }
      } else if (!(await writeIf($, destIndex, destAfter, destBefore))) {
        problems.push('目标 MEMORY.md 后来又被改过，没有还原')
      }
    }
    return problems.length ? problems.join('；') : null
  }
  await setOp($, `已把 ${name} 移到 ${to.name}`, true)
  toast($, `已移到 ${to.name}`)
  void startScan($)
}

async function startMerge($: E, source: string, target: string, model: string): Promise<void> {
  const base = await readText($, target)
  const sourceBase = await readText($, source)
  if (base === null || sourceBase === null) {
    await update($, mergeA, (): AtlasMerge => ({ ...MERGE0, status: 'error', source, target, error: '读不到要合并的文件' }))
    return
  }
  await update($, mergeA, (): AtlasMerge => ({ ...MERGE0, status: 'running', source, target, base, sourceBase }))
  const prompt = [
    `TARGET file (${target}):`,
    '<<<TARGET',
    base,
    'TARGET>>>',
    '',
    `SOURCE file (${source}), to be merged into the target:`,
    '<<<SOURCE',
    sourceBase,
    'SOURCE>>>',
  ].join('\n')
  let res
  try {
    res = await $.model.complete({
      model,
      system: MERGE_SYSTEM,
      prompt,
      maxTokens: Math.min(64_000, Math.max(4096, Math.ceil((base.length + sourceBase.length) * 1.5) + 1024)),
      timeoutMs: 300_000,
    })
  } catch (err) {
    await update($, mergeA, (m): AtlasMerge => ({ ...m, status: 'error', error: `没能请求模型：${errText(err)}` }))
    return
  }
  if (!res.isAnswered) {
    const why =
      res.reason === 'api-error'
        ? `API 出错${res.status ? `（${res.status}）` : ''}`
        : res.reason === 'empty-reply'
          ? '模型没有给出内容'
          : res.reason === 'aborted'
            ? '请求超时或被中断'
            : res.reason
    await update($, mergeA, (m): AtlasMerge => ({ ...m, status: 'error', error: `合并没完成：${why}` }))
    return
  }
  const proposal = stripFence(res.text)
  await update($, mergeA, (m): AtlasMerge => ({ ...m, status: 'ready', proposal, diff: lineDiff(base, proposal) }))
}

async function applyMerge($: E): Promise<void> {
  const m = await read($, mergeA)
  if (m.status !== 'ready') return
  const ctx = await ensureCtx($)
  const curTarget = await readText($, m.target)
  const curSource = await readText($, m.source)
  if (curTarget !== m.base || curSource !== m.sourceBase) {
    await update($, mergeA, (x): AtlasMerge => ({ ...x, status: 'error', error: '文件在外面被改过了，没有合并' }))
    return
  }
  const name = basename(m.source)
  const days = await daysOf($)
  const out = await atlasJson($, ['trash', m.source, '--days', days, '--kind', 'memory', '--label', name, ...(ctx.sessionId ? ['--protect-session', ctx.sessionId] : [])])
  const meta = asTrashed(out)
  if (!meta.ok) {
    await update($, mergeA, (x): AtlasMerge => ({ ...x, status: 'error', error: `没能把 ${name} 移进回收站：${meta.error}，什么都没改` }))
    return
  }
  await $.fs.write(m.target, m.proposal)
  const { target, base, proposal, source } = m
  const ids = meta.items.map(t => t.id)
  held.opUndo = async () => {
    const problems: string[] = []
    if (!(await writeIf($, target, proposal, base))) problems.push('合并后的文件又被改过，没有还原')
    const restored = await atlasJson($, ['restore', ...ids])
    const refused = refusedOf(restored)
    if (typeof restored === 'string') problems.push(restored)
    else if (refused) problems.push(refused)
    if (!(await exists($, source))) problems.push(`没能从回收站取回 ${name}`)
    return problems.length ? problems.join('；') : null
  }
  await update($, mergeA, (): AtlasMerge => MERGE0)
  await setOp($, `已把 ${name} 合并进 ${basename(target)}，原文件在回收站（${keepNote(days)}）`, true)
  toast($, '已合并')
  void startScan($)
  void loadTrash($)
}

async function dropMerge($: E): Promise<void> {
  await update($, mergeA, (): AtlasMerge => MERGE0)
}

/** Board reorder inside a project column: the link lines of MEMORY.md. */
async function reorderGroup($: E, groupId: string, order: readonly string[]): Promise<void> {
  const ctx = await ensureCtx($)
  const prefs = await read($, prefsA)
  const group = allGroups(ctx, prefs).find(g => g.id === groupId)
  const dir = group ? folderOf(group) : undefined
  if (!group || !dir || !isProjectGroup(group)) {
    await setOp($, '', false, '这一组没有 MEMORY.md，顺序不保存')
    return
  }
  const path = `${dir.replace(/\/$/, '')}/MEMORY.md`
  const before = await readText($, path)
  if (before === null) {
    await setOp($, '', false, '这一组还没有 MEMORY.md')
    return
  }
  const after = reorderIndexLinks(before, order.map(basename))
  if (after === before) return
  await $.fs.write(path, after)
  held.opUndo = async () => ((await writeIf($, path, after, before)) ? null : 'MEMORY.md 又被改过，没有还原')
  await setOp($, `已调整 ${group.name} 的 MEMORY.md 顺序`, true)
  void startScan($)
}

// ---------- 体检 fixes ----------

async function rewriteIndex($: E, path: string, change: (before: string) => string, label: string, allowMissing = false): Promise<void> {
  const before = await readText($, path)
  if (before === null && !allowMissing) {
    await setOp($, '', false, `读不到 ${shortPath(path, (await ensureCtx($)).home)}`)
    return
  }
  const after = change(before ?? '')
  if (after === (before ?? '')) {
    await setOp($, `${label}：没有需要改的`, false)
    return
  }
  await $.fs.write(path, after)
  held.opUndo = async () => {
    if (before === null) {
      if ((await readText($, path)) !== after) return 'MEMORY.md 又被改过，没有还原'
      const t = await trash($, path)
      return t.ok ? null : t.error
    }
    return (await writeIf($, path, after, before)) ? null : 'MEMORY.md 又被改过，没有还原'
  }
  await setOp($, label, true)
  toast($, label)
  void startScan($)
}

async function fixOrphan($: E, issue: Issue): Promise<void> {
  const p = issue.projectSlug ? projectBySlug(issue.projectSlug) : undefined
  const idx = p ? memoryIndexPath(p) : null
  if (!p || !idx) return
  const name = basename(issue.path)
  const text = await readText($, issue.path)
  const mf = p.memoryFiles.find(f => f.path === issue.path)
  const meta = text !== null ? titleOf(text, name) : { title: mf?.title ?? name, description: mf?.description ?? '' }
  await rewriteIndex(
    $,
    idx,
    before => (splitLines(before).some(l => linkTargets(l.text).includes(name)) ? before : appendLine(before, indexLine(name, meta.title, meta.description))),
    `已把 ${name} 加入索引`,
    true,
  )
}

async function fixDeadLink($: E, issue: Issue): Promise<void> {
  const p = issue.projectSlug ? projectBySlug(issue.projectSlug) : undefined
  const idx = p ? memoryIndexPath(p) : null
  const name = deadLinkName(issue)
  if (!idx || !name) return
  await rewriteIndex($, idx, before => removeIndexLinks(before, name), `已从 MEMORY.md 删掉指向 ${name} 的链接`)
}

async function fixNoIndex($: E, issue: Issue): Promise<void> {
  const p = issue.projectSlug ? projectBySlug(issue.projectSlug) : undefined
  const idx = p ? memoryIndexPath(p) : null
  if (!p || !idx) return
  if ((await readText($, idx)) !== null) {
    await setOp($, '', false, 'MEMORY.md 已经有了，没有覆盖')
    return
  }
  const files = [...p.memoryFiles].sort((a: MemoryFile, b: MemoryFile) => b.mtimeMs - a.mtimeMs)
  const text = generateIndex(files.map(f => ({ name: f.name, title: f.title, description: f.description })))
  await rewriteIndex($, idx, () => text, `已生成 MEMORY.md（${files.length} 条）`, true)
}

async function setFileMode($: E, mode: 'read' | 'edit'): Promise<void> {
  await update($, fileA, (f): AtlasFile => ({ ...f, mode }))
}

async function setFileAnchor($: E, anchor: number): Promise<void> {
  await update($, fileA, (f): AtlasFile => ({ ...f, anchor: Math.max(0, anchor) }))
}

async function startFmDraft($: E): Promise<void> {
  await update($, fileA, (f): AtlasFile => (f.status === 'ready' ? { ...f, mode: 'edit', fmDraft: f.fmDraft ?? draftFor(f.path, f.text) } : f))
}

async function setFileDraft($: E, patch: Partial<AtlasFmDraft>): Promise<void> {
  await update($, fileA, (f): AtlasFile => ({ ...f, fmDraft: { ...(f.fmDraft ?? draftFor(f.path, f.text)), ...patch } }))
}

async function writeFrontmatterFromDraft($: E): Promise<void> {
  const f = await read($, fileA)
  const draft = f.fmDraft
  if (!f.path || f.status !== 'ready' || !draft) return
  if (parseFrontmatter(f.text)) {
    await update($, fileA, (x): AtlasFile => ({ ...x, fmDraft: null }))
    return
  }
  await saveText($, f.path, t => addFrontmatter(t, draft))
}

/** 体检 no-frontmatter: the editor, its fields filled from the stem and first line. */
async function openFrontmatterFix($: E, path: string, from: string): Promise<void> {
  await push($, { kind: 'file', path, from })
  await startFmDraft($)
}

/** 体检 same-title: the 记忆整理 board with the groups that share the title. */
async function showSameTitle($: E, issue: Issue): Promise<void> {
  const idx = held.index
  if (!idx) return
  const ctx = await ensureCtx($)
  const prefs = await read($, prefsA)
  const all = [...idx.projects.flatMap(p => p.memoryFiles), ...idx.customMemory.flatMap(c => c.files)]
  const title = all.find(f => f.path === issue.path)?.title
  const ids = new Set<string>()
  for (const f of all) {
    if (title !== undefined && f.title !== title) continue
    if (title === undefined && f.path !== issue.path) continue
    const g = groupOfPath(f.path, ctx, prefs)
    if (g) ids.add(g.id)
  }
  await update($, viewA, (v): AtlasView => ({ ...v, tab: 'memory', memoryMode: 'sort', stack: [], sortColumns: [...ids] }))
}

// ---------- detail loaders ----------

async function loadClaudeMds($: E, slug: string): Promise<void> {
  const p = projectBySlug(slug)
  if (!p?.cwd) {
    await update($, extraA, (x): AtlasExtra => ({ ...x, claudeMds: { slug, items: [] } }))
    return
  }
  const items = await Promise.all(projectClaudeMdPaths(p.cwd).map(async path => ({ path, exists: await exists($, path) })))
  await update($, extraA, (x): AtlasExtra => ({ ...x, claudeMds: { slug, items } }))
}

async function loadSkillFiles($: E, name: string): Promise<void> {
  const s = held.index?.skills.find(k => k.name === name)
  if (!s?.path) {
    await update($, extraA, (x): AtlasExtra => ({ ...x, skillFiles: { name, status: 'ready', files: [], error: null } }))
    return
  }
  await update($, extraA, (x): AtlasExtra => ({ ...x, skillFiles: { name, status: 'loading', files: [], error: null } }))
  const root = dirname(s.path)
  const files: { rel: string; path: string; size: number }[] = []
  const walk = async (dir: string, rel: string, depth: number) => {
    const entries = (await safe(() => $.fs.list(dir))) ?? []
    for (const en of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (en.name.startsWith('.')) continue
      const path = `${dir}/${en.name}`
      const r = rel ? `${rel}/${en.name}` : en.name
      if (en.kind === 'dir' && depth < 2) await walk(path, r, depth + 1)
      else if (en.kind === 'file' && TEXT_EXT.test(en.name)) files.push({ rel: r, path, size: en.size })
      if (files.length >= 200) return
    }
  }
  await walk(root, '', 0)
  await update($, extraA, (x): AtlasExtra => ({ ...x, skillFiles: { name, status: 'ready', files, error: null } }))
}


// ---------- boards ----------

const STATES: readonly string[] = ['mount', 'read', 'off']

async function handleBoard($: E, post: BoardPost, editorModel: string): Promise<void> {
  const view = await read($, viewA)
  if (post.board === 'load') {
    if (post.type === 'drop' && STATES.includes(post.to)) {
      const to = post.to as AtlasMemoryState
      if (post.card.startsWith('g:')) await setMemoryState($, view.scope, post.card.slice(2), to)
      else if (post.card.startsWith('f:')) {
        if (view.scope === 'session') await setFileState($, post.card.slice(2), to)
        else toast($, '说明文件只能按本会话切换')
      }
    } else if (post.type === 'open') {
      if (post.card.startsWith('f:')) await push($, { kind: 'file', path: post.card.slice(2) })
      else if (post.card.startsWith('g:project:')) await push($, { kind: 'project', slug: post.card.slice('g:project:'.length) })
      else if (post.card.startsWith('g:')) await push($, { kind: 'custom', name: post.card.slice(2) })
    }
    return
  }
  if (post.board === 'skills') {
    if (post.type === 'drop' && (post.to === 'on' || post.to === 'off') && post.card.startsWith('s:')) {
      await setSkillState($, view.scope, post.card.slice(2), post.to === 'off')
    } else if (post.type === 'open' && post.card.startsWith('s:')) {
      await push($, { kind: 'skill', name: post.card.slice(2) })
    }
    return
  }
  if (post.board === 'sort') {
    if (post.type === 'drop') await moveMemoryFile($, post.card, post.to)
    else if (post.type === 'merge') await startMerge($, post.card, post.onto, editorModel)
    else if (post.type === 'reorder') await reorderGroup($, post.column, post.order)
    else await push($, { kind: 'file', path: post.card })
  }
}


// ---------- trash, restore, purge, archive (atlas.py does the moving) ----------

/** Runs an atlas.py subcommand; its JSON, or the error as a string. */
async function atlasJson($: E, args: string[]): Promise<unknown> {
  let res
  try {
    res = await $.process.run(await atlasArgv($, args), { timeoutMs: 120_000 })
  } catch (err) {
    return `atlas.py 没能运行：${errText(err)}`
  }
  const parsed = parseJson(res.stdout)
  if (res.exitCode !== 0 || parsed === undefined) {
    const said = typeof parsed === 'object' && parsed !== null ? (parsed as { error?: unknown }).error : undefined
    return typeof said === 'string' ? said : lastLine(res.stderr) || `atlas.py ${args[0] ?? ''} 退出码 ${res.exitCode}`
  }
  return parsed
}

function refusedOf(out: unknown): string | null {
  if (typeof out !== 'object' || out === null) return null
  const list = (out as { refused?: unknown }).refused
  if (!Array.isArray(list) || list.length === 0) return null
  return list
    .map(x => {
      const o = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>
      return String(o.reason ?? '被拒绝')
    })
    .join('；')
}

function asTrashed(out: unknown): { ok: true; items: TrashMeta[] } | { ok: false; error: string } {
  if (typeof out === 'string') return { ok: false, error: out }
  const refused = refusedOf(out)
  const items = ((out as { trashed?: unknown }).trashed ?? []) as TrashMeta[]
  if (refused || !Array.isArray(items) || items.length === 0) return { ok: false, error: refused ?? '没有移动任何东西' }
  return { ok: true, items }
}

async function daysOf($: E): Promise<string> {
  // this session's pick at a delete, else this machine's default from the 回收站 page, else the plugin's option
  const v = await read($, viewA)
  return v.trashDays || (await read($, prefsA)).trashDays || config.trashDays
}

function routeIsGone(route: AtlasRoute | undefined, paths: readonly string[]): boolean {
  if (!route) return false
  const p = route.kind === 'file' ? route.path : route.kind === 'session' ? route.path : route.kind === 'project' ? projectFolder(route.slug) : route.kind === 'skill' ? skillFolder(route.name) : undefined
  return p !== undefined && paths.some(x => p === x || isInside(p, x))
}

function projectFolder(slug: string): string | undefined {
  const cd = held.index?.claudeDir
  return cd ? `${cd}/projects/${slug}` : undefined
}

function skillFolder(name: string): string | undefined {
  const p = held.index?.skills.find(s => s.name === name)?.path
  return p ? dirname(p) : undefined
}

/** 删除: moves the paths into Atlas's trash for the chosen days; 撤销 restores them. */
async function trashTargets($: E, paths: string[], label: string, kind?: string): Promise<void> {
  const ctx = await ensureCtx($)
  const days = await daysOf($)
  await setOp($, `正在移进回收站：${label}…`, false)
  const args = ['trash', ...paths, '--days', days, '--label', label]
  if (kind) args.push('--kind', kind)
  if (ctx.sessionId) args.push('--protect-session', ctx.sessionId)
  const out = await atlasJson($, args)
  await update($, viewA, (v): AtlasView => ({ ...v, pending: null }))
  const meta = asTrashed(out)
  if (!meta.ok) {
    await setOp($, '', false, `没有删除：${meta.error}`)
    return
  }
  const ids = meta.items.map(t => t.id)
  held.opUndo = async () => {
    const restored = await atlasJson($, ['restore', ...ids])
    if (typeof restored === 'string') return restored
    void loadTrash($)
    return refusedOf(restored)
  }
  const v = await read($, viewA)
  if (routeIsGone(v.stack[v.stack.length - 1], paths)) {
    await update($, viewA, (x): AtlasView => ({ ...x, stack: x.stack.slice(0, -1) }))
  }
  await setOp($, `已移进回收站：${label}（${keepNote(days)}）`, true)
  toast($, days === NEVER ? `已删除 ${label}，在回收站里一直留着，可以恢复` : `已删除 ${label}，${days} 天内可在回收站恢复`)
  void startScan($)
  void loadTrash($)
}

async function loadTrash($: E): Promise<void> {
  await update($, trashA, (t): AtlasTrash => ({ ...t, status: t.items.length ? t.status : 'loading', error: null }))
  const out = await atlasJson($, ['trash-list'])
  if (typeof out === 'string') {
    await update($, trashA, (t): AtlasTrash => ({ ...t, status: 'error', error: out }))
    return
  }
  const o = out as { items?: unknown; bytes?: unknown }
  const items: AtlasTrashItem[] = (Array.isArray(o.items) ? o.items : []).flatMap(x => {
    const m = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>
    if (typeof m.id !== 'string') return []
    return [
      {
        id: m.id,
        originalPath: String(m.originalPath ?? ''),
        kind: String(m.kind ?? m.pathClass ?? ''),
        label: String(m.label ?? m.id),
        deletedAtMs: Number(m.deletedAtMs ?? 0),
        expiresAtMs: Number(m.expiresAtMs ?? 0),
        sizeBytes: Number(m.sizeBytes ?? 0),
        exists: m.exists !== false,
      },
    ]
  })
  await update($, trashA, (): AtlasTrash => ({ status: 'ready', items, bytes: Number(o.bytes ?? 0), error: null }))
}

async function restoreIds($: E, ids: string[]): Promise<void> {
  await setOp($, '正在恢复…', false)
  const out = await atlasJson($, ['restore', ...ids])
  const refused = typeof out === 'string' ? out : refusedOf(out)
  if (refused) await setOp($, '', false, `没有恢复：${refused}`)
  else {
    await setOp($, '已恢复', false)
    toast($, '已恢复')
  }
  void startScan($)
  await loadTrash($)
}

async function purgeNow($: E, id: string): Promise<void> {
  await setOp($, '正在永久删除…', false)
  const out = await atlasJson($, ['purge', '--now', id])
  await update($, viewA, (v): AtlasView => ({ ...v, pending: null }))
  const refused = typeof out === 'string' ? out : refusedOf(out)
  if (refused) await setOp($, '', false, `没有清空：${refused}`)
  else {
    const freed = Number((out as { freedBytes?: unknown }).freedBytes ?? 0)
    await setOp($, `已永久删除，释放 ${(freed / 1024 / 1024).toFixed(1)} MB`, false)
  }
  await loadTrash($)
}

/** Empties the whole trash, whatever each item's expiry says. */
async function purgeAll($: E): Promise<void> {
  await setOp($, '正在清空回收站…', false)
  const out = await atlasJson($, ['purge', '--all'])
  await update($, viewA, (v): AtlasView => ({ ...v, pending: null }))
  const refused = typeof out === 'string' ? out : refusedOf(out)
  const purged = typeof out === 'string' ? [] : (out as { purged?: unknown }).purged
  const n = Array.isArray(purged) ? purged.length : 0
  const freed = typeof out === 'string' ? 0 : Number((out as { freedBytes?: unknown }).freedBytes ?? 0)
  if (refused && n) await setOp($, `清空了 ${n} 项，有的没清掉：${refused}`, false)
  else if (refused) await setOp($, '', false, `没有清空：${refused}`)
  else await setOp($, `回收站已清空：永久删除 ${n} 项，释放 ${(freed / 1024 / 1024).toFixed(1)} MB`, false)
  await loadTrash($)
}

/** This machine's keep period for what is deleted from now on; what is already in the trash keeps its own. */
async function setTrashDefault($: E, days: string): Promise<void> {
  if (!isKeep(days)) return
  await savePrefs($, p => ({ ...p, trashDays: days }))
  // a pick made at a delete earlier in this session no longer stands over the new default
  await update($, viewA, (v): AtlasView => ({ ...v, trashDays: '' }))
  toast($, days === NEVER ? '以后删除的东西一直保留，只手动清空' : `以后删除的东西保留 ${days} 天`)
}

async function setExpiry($: E, id: string, days: string): Promise<void> {
  const out = await atlasJson($, ['set-expiry', id, '--days', days])
  const refused = typeof out === 'string' ? out : refusedOf(out)
  if (refused) await setOp($, '', false, `没有改成：${refused}`)
  else toast($, `改成${keepNote(days)}`)
  await loadTrash($)
}

/** 归档 a project memory file: atlas.py moves it into memory-archive/<label>/, kept for good. */
async function archiveMemory($: E, path: string, label: string): Promise<void> {
  await setOp($, '正在归档…', false)
  const out = await atlasJson($, ['archive-memory', path, '--project-label', archiveLabel(label)])
  const refused = typeof out === 'string' ? out : refusedOf(out)
  const archived = typeof out === 'object' && out !== null ? (out as { archived?: { to?: string } | null }).archived : null
  if (refused || !archived) {
    await setOp($, '', false, `没有归档：${refused ?? '没有移动任何东西'}`)
    return
  }
  const v = await read($, viewA)
  if (routeIsGone(v.stack[v.stack.length - 1], [path])) await update($, viewA, (x): AtlasView => ({ ...x, stack: x.stack.slice(0, -1) }))
  await setOp($, `已归档到 ${shortPath(archived.to ?? '', (await ensureCtx($)).home)}`, false)
  toast($, '已归档')
  void startScan($)
}

/** 归档 a session or project: a flag in $.store that hides it from the default lists. */
async function setArchived($: E, kind: 'sessions' | 'projects', id: string, on: boolean): Promise<void> {
  await savePrefs($, p => {
    const list = p.archived[kind].filter(x => x !== id)
    return { ...p, archived: { ...p.archived, [kind]: on ? [...list, id] : list } }
  })
  toast($, on ? '已归档（文件没动）' : '已取消归档')
}

async function openDir($: E, dir: string): Promise<void> {
  if ((await ensureCtx($)).win) {
    const error = await atlasHost($, ['open', dir])
    if (error !== null) toast($, `没能打开：${error}`)
    return
  }
  const r = await run($, ['/usr/bin/open', dir])
  if (!r.ok) toast($, `没能打开：${r.error}`)
}

/** The expired items atlas.py purges; a toast when it freed anything. */
async function autoPurge($: E): Promise<void> {
  const out = await atlasJson($, ['purge'])
  if (typeof out !== 'object' || out === null) return
  const purged = (out as { purged?: unknown }).purged
  const n = Array.isArray(purged) ? purged.length : 0
  if (n > 0) {
    const freed = Number((out as { freedBytes?: unknown }).freedBytes ?? 0)
    toast($, `回收站自动清空了 ${n} 项，释放 ${(freed / 1024 / 1024).toFixed(1)} MB`)
    const t = await read($, trashA)
    if (t.status !== 'idle') await loadTrash($)
  }
}

async function setPending($: E, key: string | null): Promise<void> {
  await update($, viewA, (v): AtlasView => ({ ...v, pending: key }))
}

// ---------- 提示词: the system prompt's sections and the edits to them ----------

/** The sections with "the user" written as `name`; the ones it does not occur in are passed as they are. */
function named<S extends { text: string }>(sections: readonly S[], name: string): S[] {
  if (!name) return [...sections]
  return sections.map(s => {
    const r = renameUser(s.text, name)
    return r.count ? { ...s, text: r.text } : s
  })
}

function seenOf(sections: readonly { id: string; text: string; scope: 'shared' | 'session' }[]): SectionSeen[] {
  return sections.map(s => ({ id: s.id, text: s.text, scope: s.scope }))
}

/** Asks the engine for the prompt as it composes it now, for the page to list. */
async function loadPrompt($: E): Promise<void> {
  await update($, manageA, (m): AtlasManage => ({ ...m, prompt: { ...m.prompt, status: 'loading', error: null } }))
  try {
    const out = await $.prompt.compose()
    const edits = sessionEdits(await readSwitches($))
    for (const s of out.sections) {
      if (!heldM.original.has(s.id) && edits.rewrite[s.id] === undefined && !s.id.startsWith(EXTRA_PREFIX)) heldM.original.set(s.id, s.text)
    }
    heldM.composed = seenOf(named(applyCompose(edits, out.sections), renameOf(edits)))
    // asked for by hand: the next request the engine sends is read again for what lies outside the sections
    heldM.outsideTries = OUTSIDE_TRIES
    heldM.outsideUnder = sectionsMark(heldM.composed)
    const atMs = Date.now()
    await update($, manageA, (m): AtlasManage => ({ ...m, prompt: { status: 'ready', error: null, atMs } }))
  } catch (err) {
    const error = `没能读出系统提示词：${errText(err)}`
    await update($, manageA, (m): AtlasManage => ({ ...m, prompt: { ...m.prompt, status: 'error', error } }))
  }
  await bump($)
}

/**
 * Reads, off a request the engine is about to send, what its system prompt carries beside the
 * sections (manage.ts says why). Looks only: the request goes on as it was. A body is parsed only
 * while a look is owed (after the sections changed, or the page asked), and only so many times, since
 * a long conversation's request is large; another prompt's request (a subagent's, a side request's)
 * shares few of the sections and is passed over.
 */
function noteOutside($: E, url: string, body: unknown): void {
  if (heldM.outsideTries <= 0 || typeof body !== 'string' || !/\/v1\/messages(?:[?#]|$)/.test(url)) return
  const sections = heldM.composed
  if (!sections || sections.length === 0) return
  heldM.outsideTries--
  const sent = systemBlocks(body)
  if (!sent) return
  const { pieces, matched, asked } = outsideOf(sent.blocks, sections.map(s => s.text))
  if (!isOwnPrompt(matched, asked)) return
  heldM.outside = { pieces, blocks: sent.blocks.length, matched, model: sent.model, atMs: Date.now() }
  heldM.outsideTries = 0
  void bump($).catch(() => undefined)
}

function invalidatePrompt($: E): void {
  try {
    $.ui.invalidate('prompt.section')
  } catch {
    // nothing cached yet
  }
}

/** Applies a change to the edits at the level the page's 改的是 names. */
async function changePrompt($: E, change: (e: AtlasPromptEdits) => AtlasPromptEdits, what: 'sections' | 'injects' | 'tools' = 'sections'): Promise<void> {
  const ctx = await ensureCtx($)
  const scope = (await read($, viewA)).scope
  if (scope === 'session') {
    await update($, switchesA, (s): AtlasSwitches => {
      const next = { ...s, prompt: change(sessionEdits(s)) }
      held.mirror = next
      return next
    })
    if (what === 'injects') {
      // asked again from the next turn; what the conversation already holds stays until it is cleared or compacted
      invalidateSkills($)
      return
    }
    if (what === 'tools') {
      // each tool is described again from the next turn; a call to one switched off is refused from now
      invalidateTools($)
      return
    }
    invalidatePrompt($)
    await loadPrompt($)
    return
  }
  await savePrefs($, p => {
    const cur = promptPrefs(p)
    if (scope === 'global') return { ...p, prompt: { ...cur, global: change(cur.global) } }
    return { ...p, prompt: { ...cur, byProject: { ...cur.byProject, [ctx.cwd]: change(cur.byProject[ctx.cwd] ?? EDITS0) } } }
  })
}

async function promptEditsNow($: E): Promise<AtlasPromptEdits> {
  const ctx = await ensureCtx($)
  const scope = (await read($, viewA)).scope
  if (scope === 'session') return sessionEdits(await read($, switchesA))
  const cur = promptPrefs(await read($, prefsA))
  return scope === 'global' ? cur.global : cur.byProject[ctx.cwd] ?? EDITS0
}

async function rewriteSection($: E, id: string, text: string | null): Promise<void> {
  if (text !== null && !text.trim()) {
    toast($, '改写不能是空的；不想要这一段就关闭它')
    return
  }
  await changePrompt($, e => setRewrite(e, id, text))
}

async function newExtra($: E, name: string): Promise<void> {
  const clean = name.trim()
  if (!clean) return
  const edits = await promptEditsNow($)
  const extra: AtlasPromptExtra = { id: extraId(clean, edits.extra.map(x => x.id)), name: clean, text: '', off: false }
  await changePrompt($, e => putExtra(e, extra))
  await push($, { kind: 'section', id: extra.id, from: 'px-new' }, 'px-text')
}

async function dropExtraSection($: E, id: string): Promise<void> {
  await changePrompt($, e => dropExtra(e, id))
  await setPending($, null)
  const v = await read($, viewA)
  const top = v.stack[v.stack.length - 1]
  if (top?.kind === 'section' && top.id === id) await back($)
}

/** The name for "the user" at the level 改的是 names; the sections, injections and tool descriptions are asked again. */
async function setPromptRename($: E, name: string): Promise<void> {
  await changePrompt($, e => setRename(e, name))
  if ((await read($, viewA)).scope !== 'session') return
  try {
    $.ui.invalidate('prompt.attachment')
    $.ui.invalidate('tool.describe')
  } catch {
    // nothing cached yet
  }
}

async function setPromptNow($: E, on: boolean): Promise<void> {
  await update($, switchesA, (s): AtlasSwitches => {
    const next = { ...s, promptNow: on }
    held.mirror = next
    return next
  })
  invalidatePrompt($)
  invalidateTools($)
}

// ---------- 工具: where each tool waits, and what it tells the model ----------

function invalidateTools($: E): void {
  try {
    $.ui.invalidate('tool.describe')
  } catch {
    // nothing cached yet
  }
}

/**
 * Asks the engine which tools the model has, for the page to list. With
 * `ask`, the engine also describes each one again from the next turn, which is
 * where the page's sizes come from (`$.tool.list()` cuts every description short).
 */
async function loadTools($: E, ask: boolean): Promise<void> {
  await update($, manageA, (m): AtlasManage => ({ ...m, tools: { ...(m.tools ?? LOAD0), status: 'loading', error: null } }))
  try {
    const list = await $.tool.list()
    heldM.toolList = list.map(t => ({ name: t.name, mcp: t.mcp === true }))
    if (ask) invalidateTools($)
    const atMs = Date.now()
    await update($, manageA, (m): AtlasManage => ({ ...m, tools: { status: 'ready', error: null, atMs } }))
  } catch (err) {
    const error = `没能读出工具清单：${errText(err)}`
    await update($, manageA, (m): AtlasManage => ({ ...m, tools: { ...(m.tools ?? LOAD0), status: 'error', error } }))
  }
  await bump($)
}

async function rewriteTool($: E, name: string, text: string | null): Promise<void> {
  if (text !== null && !text.trim()) {
    toast($, '改写不能是空的；不想让模型用这个工具就把它关掉')
    return
  }
  await changePrompt($, e => setToolRewrite(e, name, text), 'tools')
}

// ---------- Hooks: the settings files' hooks ----------

/** Presses that write a settings file run one at a time, each on what the one before left. */
let hooksQueue: Promise<void> = Promise.resolve()

/** What such a press throws is told, never left unsaid, and the page reads the files again. */
function guarded($: E, fn: () => Promise<void>): Promise<void> {
  const run = async (): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      toast($, `没有完成：${errText(err)}`)
      await safe(() => loadHooks($))
    }
  }
  hooksQueue = hooksQueue.then(run, run)
  return hooksQueue
}

/**
 * A settings file as it is on disk: its text, or null when there is no such
 * file. Throws when it is there and cannot be read, so a file is never taken
 * for missing and written over.
 */
async function readSettings($: E, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch (err) {
    // a read fails for a missing file too: only one that is positively not there counts as missing
    let has: boolean
    try {
      has = await $.fs.exists(path)
    } catch {
      has = true
    }
    if (!has) return null
    throw new Error(`这个 settings 文件读不出来（${errText(err)}），没有动它`)
  }
}

async function loadHooks($: E): Promise<void> {
  await update($, manageA, (m): AtlasManage => ({ ...m, hooks: { ...m.hooks, status: 'loading', error: null } }))
  try {
    const ctx = await ensureCtx($)
    const files = []
    for (const f of settingsFiles(ctx)) {
      try {
        files.push({ ...f, text: await readSettings($, f.path), readError: null })
      } catch (err) {
        files.push({ ...f, text: null, readError: errText(err) })
      }
    }
    const prefs = await storedPrefs($)
    await update($, prefsA, (): AtlasPrefs => prefs)
    heldM.hooks = scanHooks(files, parkedOf(prefs))
    const atMs = Date.now()
    await update($, manageA, (m): AtlasManage => ({ ...m, hooks: { status: 'ready', error: null, atMs } }))
  } catch (err) {
    const error = `没能读出 hooks：${errText(err)}`
    await update($, manageA, (m): AtlasManage => ({ ...m, hooks: { ...m.hooks, status: 'error', error } }))
  }
  await bump($)
}

/**
 * Rewrites one settings file's hooks table. Refused when the file cannot be
 * read or changed since the page read it; what it replaced is kept in memory
 * for one undo, with the parked entry that undo puts back or takes out.
 */
async function writeSettings(
  $: E,
  path: string,
  label: string,
  change: (table: HooksTable) => void,
  parked: { add?: AtlasParkedHook; drop?: string } = {},
): Promise<void> {
  const before = await readSettings($, path)
  const seen = heldM.hooks?.files.find(f => f.path === path)
  if (seen && (seen.unreadable || seen.text !== before)) throw new Error('这个 settings 文件在外面被改过了，已经重新读取，请再试一次')
  const after = editSettings(before, change)
  if (after === before) return
  await $.fs.write(path, after)
  heldM.hooksUndo = { path, before, after, label, parkedAdd: parked.add ?? null, parkedDrop: parked.drop ?? null }
  await update($, manageA, (m): AtlasManage => ({ ...m, hooksUndo: label }))
}

async function setParked($: E, change: (list: AtlasParkedHook[]) => AtlasParkedHook[]): Promise<void> {
  await savePrefs($, p => ({ ...p, hooksOff: change(parkedOf(p)) }))
}

async function retarget($: E, from: string, to: string): Promise<void> {
  await update($, viewA, (v): AtlasView => ({
    ...v,
    pending: null,
    stack: v.stack.map(r => (r.kind === 'hook' && r.id === from ? { ...r, id: to } : r)),
  }))
}

function hookRow(id: string) {
  const row = heldM.hooks?.rows.find(r => r.id === id)
  if (!row) throw new Error('这个 hook 不在最新读到的列表里了')
  return row
}

/** Off: out of its settings file and into Atlas's keeping. On: back into the file it came from. */
async function toggleHook($: E, id: string): Promise<void> {
  const row = hookRow(id)
  if (row.isOn) {
    const taken = parkedOf(await storedPrefs($)).map(p => p.id)
    const parked: AtlasParkedHook = { id: parkedId(taken, Date.now()), file: row.file, event: row.event, matcher: row.matcher, json: row.json }
    // kept first, taken out second: a hook is never out of its file and in nobody's keeping
    await setParked($, list => [...list, parked])
    try {
      await writeSettings($, row.file, `关闭 ${row.event}`, table => void removeAt(table, row), { drop: parked.id })
    } catch (err) {
      await safe(() => setParked($, list => list.filter(p => p.id !== parked.id)))
      throw err
    }
    await retarget($, id, parked.id)
    toast($, '已关闭：从 settings 里拿出来了，Atlas 替你留着')
  } else {
    const hook = parseJson(row.json)
    if (typeof hook !== 'object' || hook === null || Array.isArray(hook)) throw new Error('这个关着的 hook 存坏了，放不回去')
    const source = settingsFiles(await ensureCtx($)).find(f => f.path === row.file)?.source
    const entry: AtlasParkedHook = { id: row.id, file: row.file, event: row.event, matcher: row.matcher, json: row.json }
    let at = { g: 0, i: 0 }
    // put back first, let go of second: a failure leaves it in both places, never in neither
    await writeSettings(
      $,
      row.file,
      `开启 ${row.event}`,
      table => {
        at = addHook(table, row.event, row.matcher, hook as Record<string, unknown>)
      },
      { add: entry },
    )
    await setParked($, list => list.filter(p => p.id !== id))
    if (source) await retarget($, id, rowId(source, row.event, at.g, at.i))
    toast($, '已开启：放回 settings 了')
  }
  await loadHooks($)
}

async function saveHook($: E, id: string, patch: HookPatch): Promise<void> {
  const row = hookRow(id)
  if (!row.isOn || !row.source) throw new Error('关着的 hook 要先开启才能改')
  let at = { g: row.g, i: row.i }
  await writeSettings($, row.file, `修改 ${row.event}`, table => {
    at = updateAt(table, row, patch)
  })
  await retarget($, id, rowId(row.source, row.event, at.g, at.i))
  await loadHooks($)
  toast($, '已保存')
}

async function deleteHook($: E, id: string): Promise<void> {
  const row = hookRow(id)
  if (row.isOn) {
    await writeSettings($, row.file, `删除 ${row.event}`, table => void removeAt(table, row))
  } else {
    const entry: AtlasParkedHook = { id: row.id, file: row.file, event: row.event, matcher: row.matcher, json: row.json }
    await setParked($, list => list.filter(p => p.id !== id))
    // a parked hook lives only in the store: its undo puts the entry back, and touches no file
    heldM.hooksUndo = { path: '', before: null, after: '', label: `删除 ${row.event}`, parkedAdd: entry, parkedDrop: null }
    await update($, manageA, (m): AtlasManage => ({ ...m, hooksUndo: `删除 ${row.event}` }))
  }
  await setPending($, null)
  const v = await read($, viewA)
  const top = v.stack[v.stack.length - 1]
  if (top?.kind === 'hook' && top.id === id) await back($)
  await loadHooks($)
  toast($, '已删除')
}

async function startHookDraft($: E): Promise<void> {
  const ctx = await ensureCtx($)
  const file = settingsFiles(ctx)[0]?.path ?? ''
  const draft: AtlasHookDraft = { file, event: 'PostToolUse', matcher: '', command: '', timeout: '' }
  await update($, viewA, (v): AtlasView => ({ ...v, hookDraft: v.hookDraft ?? draft }))
  await push($, { kind: 'hooknew', from: 'hook-new' }, 'hd-command')
}

async function addDraftHook($: E): Promise<void> {
  const d = (await read($, viewA)).hookDraft
  if (!d) return
  const ctx = await ensureCtx($)
  const target = settingsFiles(ctx).find(f => f.path === d.file)
  if (!target) throw new Error('先选要写到哪个 settings 文件')
  const hook = draftHook(d)
  if (!heldM.hooks) await loadHooks($)
  let at = { g: 0, i: 0 }
  await writeSettings($, target.path, `新增 ${d.event}`, table => {
    at = addHook(table, d.event, d.matcher.trim(), hook)
  })
  await loadHooks($)
  const id = rowId(target.source, d.event, at.g, at.i)
  await update($, viewA, (v): AtlasView => ({
    ...v,
    hookDraft: null,
    stack: [...v.stack.filter(r => r.kind !== 'hooknew'), { kind: 'hook', id, from: 'hook-new' }],
  }))
  toast($, '已添加')
}

/**
 * One level: the file the last write replaced goes back, and the one parked
 * entry that write went with. What it throws, `guarded` tells.
 */
async function undoHooks($: E): Promise<void> {
  const u = heldM.hooksUndo
  if (!u) return
  if (u.path) {
    const disk = await readSettings($, u.path)
    if (disk !== u.after) throw new Error('settings 文件在那之后又被改过，没法原样撤回')
  }
  // the entry comes back before its hook leaves the file, and goes only after the hook is back in it
  const add = u.parkedAdd
  if (add) await setParked($, list => (list.some(p => p.id === add.id) ? list : [...list, add]))
  if (u.path) await $.fs.write(u.path, u.before ?? '{}\n')
  const drop = u.parkedDrop
  if (drop) await setParked($, list => list.filter(p => p.id !== drop))
  heldM.hooksUndo = null
  await update($, manageA, (m): AtlasManage => ({ ...m, hooksUndo: null }))
  await update($, viewA, (v): AtlasView => ({ ...v, pending: null, stack: v.stack.filter(r => r.kind !== 'hook') }))
  toast($, '已撤销')
  await loadHooks($)
}

// ---------- the pane ----------

/** The closures a draw hands its presses, each over the render hook's `$`. */
function actionsFor($: E): Actions {
  return {
    scan: () => void startScan($),
    tab: tab => void switchTab($, tab),
    push: route => void push($, route, 'back'),
    back: () => void back($),
    view: change => void setView($, change),
    search: query => void runSearch($, query),
    memState: (groupId, state) => void setMemoryState($, 'session', groupId, state),
    skillState: (name, off) => void setSkillState($, 'session', name, off),
    editor: path => void openInEditor($, path),
    reveal: path => void reveal($, path),
    copy: (text, surface) => void copyText($, text, surface),
    undoFile: path => void undoFile($, path),
    reloadFile: () => void reloadFile($),
    fileMode: mode => void setFileMode($, mode),
    fileAnchor: line => void setFileAnchor($, line),
    save: (path, change, focusAfter) =>
      void saveText($, path, change).then(ok => {
        if (ok && focusAfter) focusSoon($, focusAfter)
      }),
    startFmDraft: () => void startFmDraft($),
    fmDraft: patch => void setFileDraft($, patch),
    writeFm: () => void writeFrontmatterFromDraft($),
    newFile: path => void openNewFile($, path),
    applyMerge: () => void applyMerge($),
    dropMerge: () => void dropMerge($),
    undoOp: () => void undoOp($),
    fixOrphan: issue => void fixOrphan($, issue),
    fixDeadLink: issue => void fixDeadLink($, issue),
    fixNoIndex: issue => void fixNoIndex($, issue),
    fixFrontmatter: (path, from) => void openFrontmatterFix($, path, from),
    openAt: (path, line, from) => void openAt($, path, line, from),
    sameTitle: issue => void showSameTitle($, issue),
    openDir: dir => void openDir($, dir),
    trash: (paths, label, kind) => void trashTargets($, paths, label, kind),
    restore: ids => void restoreIds($, ids),
    purgeNow: id => void purgeNow($, id),
    setExpiry: (id, days) => void setExpiry($, id, days),
    purgeAll: () => void purgeAll($),
    trashDefault: days => told($, setTrashDefault($, days)),
    archiveMemory: (path, label) => void archiveMemory($, path, label),
    setArchived: (kind, id, on) => told($, setArchived($, kind, id, on)),
    loadTrash: () => void loadTrash($),
    pending: key => void setPending($, key),
    promptLoad: () => void loadPrompt($),
    promptOff: (id, off) => told($, changePrompt($, e => setOff(e, id, off))),
    promptRewrite: (id, text) => told($, rewriteSection($, id, text)),
    promptExtraNew: name => told($, newExtra($, name)),
    promptExtra: extra => told($, changePrompt($, e => putExtra(e, extra))),
    promptExtraDrop: id => told($, dropExtraSection($, id)),
    promptNow: on => void setPromptNow($, on),
    injectOff: (type, off) => told($, changePrompt($, e => setInjectOff(e, type, off), 'injects')),
    promptRename: name => told($, setPromptRename($, name)),
    toolsLoad: () => void loadTools($, true),
    toolPlace: (name, place) => told($, changePrompt($, e => setToolPlace(e, name, place), 'tools')),
    toolRewrite: (name, text) => told($, rewriteTool($, name, text)),
    skin: id => told($, savePrefs($, p => ({ ...p, skin: id }))),
    hooksLoad: () => void loadHooks($),
    hooksUndo: () => void guarded($, () => undoHooks($)),
    hookToggle: id => void guarded($, () => toggleHook($, id)),
    hookSave: (id, patch) => void guarded($, () => saveHook($, id, patch)),
    hookDelete: id => void guarded($, () => deleteHook($, id)),
    hookDraft: () => void startHookDraft($),
    hookAdd: () => void guarded($, () => addDraftHook($)),
  }
}

async function openNewFile($: E, path: string): Promise<void> {
  await update($, viewA, (v): AtlasView => ({ ...v, stack: [...v.stack, { kind: 'file', path, from: 'cm-new' }] }))
  await openFile($, path, { isNew: true, mode: 'edit' })
  focusSoon($, 'back')
}

async function openAt($: E, path: string, line: number, from: string): Promise<void> {
  await update($, viewA, (v): AtlasView => ({ ...v, stack: [...v.stack, { kind: 'file', path, line, from }] }))
  await openFile($, path, { line, mode: 'edit' })
  focusSoon($, 'back')
}

async function snapshot($: E, surface: RenderSurface, editorModel: string): Promise<Snap> {
  await read($, tickA)
  return {
    surface,
    scan: await read($, scanA),
    view: await read($, viewA),
    search: await read($, searchA),
    file: await read($, fileA),
    ctx: await read($, ctxA),
    sw: await read($, switchesA),
    prefs: await read($, prefsA),
    loaded: await read($, loadedA),
    merge: await read($, mergeA),
    op: await read($, opA),
    extra: await read($, extraA),
    trash: await read($, trashA),
    manage: await read($, manageA),
    editorModel,
    trashDays: (await read($, prefsA)).trashDays || config.trashDays,
    act: actionsFor($),
  }
}

// ---------- the browser window ----------
//
// `/atlas` in a terminal opens the pane as a page in a browser window of its
// own. bin/atlas_window.py serves the page (web/) on a loopback port and is
// the only thing the page talks to. The pane is drawn here as the desktop app
// draws it, into a table of plain nodes (window.ts), and pushed to the helper
// as JSON; what the person does in the page comes back on the helper's
// standard output and runs the handler the drawing held under that key.

/** How long the helper has to say it is listening. */
const WINDOW_READY_MS = 10_000
/** A press writes several values one after another: the drawing waits this long, and draws once. */
const WINDOW_SETTLE_MS = 25
/** A second bare /atlas this soon after a window was asked for finds it still opening. */
const WINDOW_OPENING_MS = 4000

type WindowStarted = { port: number } | { error: string }

/** A wait on the engine's clock: a hooks module has no timers of its own. */
function pause($: E, ms: number): Promise<void> {
  return new Promise(resolve => {
    try {
      $.clock.after(ms, () => resolve())
    } catch {
      resolve()
    }
  })
}

function windowLog($: E, text: string): void {
  try {
    $.ui.log(`atlas window: ${text}`, { to: 'debug' })
  } catch {
    // the debug log is a nicety
  }
}

/** One request to the helper, with the mod's token. */
async function windowHttp($: E, method: 'GET' | 'POST', path: string, body?: string): Promise<{ ok: boolean; status: number; doc: Record<string, unknown> }> {
  const res = await $.http.fetch(`http://127.0.0.1:${heldW.port}${path}`, {
    method,
    headers: body === undefined ? { 'X-Atlas-Token': heldW.token } : { 'X-Atlas-Token': heldW.token, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body }),
  })
  const doc = parseJson(res.text)
  return { ok: res.ok, status: res.status, doc: typeof doc === 'object' && doc !== null ? (doc as Record<string, unknown>) : {} }
}

/** Starts the helper, once per load, and waits until it listens: null, or why it does not. */
function startWindow($: E): Promise<string | null> {
  if (heldW.status === 'ready') return Promise.resolve(null)
  if (!heldW.starting) {
    heldW.starting = bootWindow($).finally(() => {
      heldW.starting = null
    })
  }
  return heldW.starting
}

async function bootWindow($: E): Promise<string | null> {
  const ctx = await ensureCtx($)
  const root = slashes($.plugin.root)
  const python = ctx.win ? await windowsPython($, ctx.home) : '/usr/bin/python3'
  // the helper opens no window by itself: each one is asked for (POST /open), so its answer can be told
  const argv = [python, '-I', `${root}/bin/atlas_window.py`, '--web', `${root}/web`, '--no-open']
  // the token goes in on standard input: a command line can be read by every process on the machine
  const token = tokenOf(crypto.getRandomValues(new Uint8Array(32)))
  windowOff()
  const gen = ++heldW.gen
  heldW.status = 'starting'
  heldW.token = token
  const said = await new Promise<WindowStarted>(resolve => {
    let timer: { cancel: () => void } | null = null
    const settle = (r: WindowStarted) => {
      try {
        timer?.cancel()
      } catch {
        // a timer that cannot be stopped fires into a promise already settled
      }
      resolve(r)
    }
    try {
      timer = $.clock.after(WINDOW_READY_MS, () => settle({ error: `窗口的服务没能启动：等了 ${WINDOW_READY_MS / 1000} 秒，${python} 还没有回话。` }))
    } catch {
      // no clock: no time limit
    }
    void windowHost($, gen, argv, token, python, settle)
  })
  if ('error' in said || heldW.gen !== gen) {
    if (heldW.gen === gen) {
      const stop = heldW.stop
      windowOff()
      heldW.gen++
      stop?.()
    }
    return 'error' in said ? said.error : '窗口的服务被另一次启动顶掉了。'
  }
  heldW.port = said.port
  heldW.status = 'ready'
  void windowDraws($, gen)
  return null
}

/**
 * The helper's life: runs it, reads what it says a line at a time, and ends
 * with it. Leaving the loop is what stops the helper, so this runs on after
 * the hook that started it has returned, until the helper exits or the module
 * is unloaded.
 */
async function windowHost($: E, gen: number, argv: readonly string[], token: string, python: string, started: (r: WindowStarted) => void): Promise<void> {
  let rest = ''
  let errors = ''
  let why = ''
  try {
    const child = $.process.spawn({ argv: [...argv], input: `${token}\n` })
    if (heldW.gen === gen) {
      heldW.stop = () => {
        try {
          void child.return({ code: null, signal: null }).catch(() => undefined)
        } catch {
          // leaving the loop stops it too
        }
      }
    }
    for await (const piece of child) {
      if (heldW.gen !== gen) break
      if (piece.stream === 'stderr') {
        errors = (errors + piece.text).slice(-800)
        continue
      }
      const cut = takeLines(rest, piece.text)
      rest = cut.rest
      for (const line of cut.lines) {
        const said = readHelperLine(line)
        if (said.kind === 'ready') started({ port: said.port })
        else if (said.kind === 'failed') why = said.error
        else if (said.kind === 'page') windowPage(said.open)
        else if (said.kind === 'act') windowAct($, said.act)
      }
    }
  } catch (err) {
    why = why || errText(err)
  }
  // the helper is gone: a window still open says so itself, and the next /atlas starts another
  if (heldW.gen === gen) windowOff()
  started({ error: startFailure(python, why, errors) })
}

/** Runs what a page did: the handler the last drawing held under that key, or the board's post. Unknown keys do nothing. */
function windowAct($: E, act: WindowAct): void {
  try {
    if (act.kind === 'hello' || act.kind === 'resize') {
      heldW.width = act.width
      heldW.height = act.height
      // a page that says hello is listening, whether or not the helper has said so yet
      if (act.kind === 'hello') windowPage(true)
      else windowStale()
      return
    }
    if (act.kind === 'board') {
      const post = asPost(act.data)
      if (post) told($, handleBoard($, post, config.editorModel))
      return
    }
    const mine = heldW.handlers.get(act.key)
    if (!mine) return
    const e: WindowEvent = { plugin: 'atlas', element: act.key, component: 'Pane', requestId: PANE, surface: heldW.surface }
    if (act.kind === 'press') mine.onPress?.(e)
    else if (act.kind === 'select') mine.onSelect?.(act.value, e)
    else if (act.kind === 'input') mine.onInput?.(act.value, e)
    else mine.onSubmit?.(act.value, e)
  } catch (err) {
    toast($, `没有完成：${errText(err)}`)
  }
}

/** The pane as the desktop app draws it, at the window's size, as JSON; its handlers are kept for the page's acts. */
async function drawWindow($: E): Promise<string> {
  let drawing
  try {
    const snap = await snapshot($, 'desktop', config.editorModel)
    drawing = serializeTree(drawPane(snap, windowSize(heldW.width, heldW.height), windowTable))
  } catch (err) {
    drawing = { tree: noteTree(`Atlas 没能画出这一页：${errText(err)}`), handlers: new Map(), problems: [] }
  }
  heldW.handlers = drawing.handlers
  for (const problem of drawing.problems) {
    if (heldW.said.has(problem)) continue
    heldW.said.add(problem)
    windowLog($, problem)
  }
  return JSON.stringify(drawing.tree)
}

/** Sends the helper what is due: a new drawing when something changed, the toasts raised since, the key to focus. */
async function pushWindow($: E): Promise<void> {
  const parts: string[] = []
  let tree: string | null = null
  if (heldW.stale) {
    heldW.stale = false
    tree = await drawWindow($)
    if (tree === heldW.lastTree) tree = null
    else parts.push(`"tree":${tree}`)
  }
  const toasts = heldW.toasts.splice(0)
  const focus = heldW.focus
  heldW.focus = null
  if (toasts.length > 0) parts.push(`"toasts":${JSON.stringify(toasts)}`)
  if (focus !== null) parts.push(`"focus":${JSON.stringify(focus)}`)
  if (parts.length === 0) return
  const cwd = (await read($, ctxA)).cwd
  parts.push(`"title":${JSON.stringify(cwd ? `Atlas · ${basename(cwd)}` : 'Atlas')}`)
  const res = await windowHttp($, 'POST', '/push', `{${parts.join(',')}}`)
  if (!res.ok) {
    // the drawing did not arrive: it is due again
    if (tree !== null) heldW.stale = true
    throw new Error(`窗口的服务回答 ${res.status}`)
  }
  if (tree !== null) heldW.lastTree = tree
}

/**
 * Draws for the window while a page is listening and something has changed,
 * and waits on a plain promise otherwise (`windowStale`, a toast or a page
 * arriving wakes it). It runs on after the hook that started it, beside the
 * helper's loop, and ends with the helper.
 */
async function windowDraws($: E, gen: number): Promise<void> {
  let failures = 0
  while (heldW.gen === gen && heldW.status === 'ready') {
    if (!windowWants()) {
      await new Promise<void>(resolve => {
        heldW.wake = resolve
      })
      continue
    }
    await pause($, WINDOW_SETTLE_MS)
    if (heldW.gen !== gen || heldW.status !== 'ready') break
    try {
      await pushWindow($)
      failures = 0
    } catch (err) {
      windowLog($, `没能把画面送到窗口：${errText(err)}`)
      // not again and again: after a few tries the drawing waits for the next change
      if (++failures >= 3) {
        heldW.stale = false
        failures = 0
      }
    }
  }
}

/** How many pages are looking right now, asked of the helper: a window closed a moment ago is not one. */
async function windowPages($: E): Promise<number> {
  const res = await safe(() => windowHttp($, 'GET', '/status'))
  return res?.ok && typeof res.doc.pages === 'number' ? res.doc.pages : 0
}

/**
 * `/atlas` as a browser window: `text` says what happened, in a line. `note`
 * instead means the embedded pane is to be opened as before, with what to say
 * first when a window was meant and could not be had.
 */
async function atlasWindow($: E, wish: WindowWish): Promise<{ text: string } | { note: string | null }> {
  if (wish === 'pane') return { note: null }
  const surfaces = await safe(() => $.session.surfaces())
  if (wish === 'auto' && !windowSuits(surfaces)) return { note: null }
  // a run that draws nowhere (claude -p) starts nothing and opens nothing, whatever was typed
  if (surfaces && surfaces.length === 0) return { text: WINDOW_NO_SURFACE }
  heldW.surface = surfaces?.[0] ?? 'terminal'
  const failed = await startWindow($)
  if (failed) return wish === 'auto' ? { note: `${failed}先打开了嵌在终端里的面板。` } : { text: failed }
  if (!held.index && !held.scanning) void startScan($)
  const now = (await safe(() => $.clock.now())) ?? Date.now()
  if (wish === 'auto' && (now - heldW.openedAtMs < WINDOW_OPENING_MS || (await windowPages($)) > 0)) return { text: WINDOW_ALREADY }
  const res = await safe(() => windowHttp($, 'POST', '/open', '{}'))
  if (res?.ok && res.doc.opened === true) {
    heldW.openedAtMs = now
    return { text: WINDOW_OPENED }
  }
  const why =
    res?.doc.how === 'suppressed'
      ? 'ATLAS_WINDOW_NO_OPEN=1 关掉了自动打开'
      : typeof res?.doc.error === 'string' && res.doc.error
        ? res.doc.error
        : res
          ? `窗口的服务回答 ${res.status}`
          : '连不上窗口的服务'
  // the address the window would have opened on: good for one page and two minutes, so it can be opened by hand
  const url = typeof res?.doc.url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\//.test(res.doc.url) ? res.doc.url : ''
  const text = `没能打开浏览器窗口：${why}。${url ? `可以自己在浏览器里打开这个地址（两分钟内有效，只能用一次）：${url}` : ''}`
  return wish === 'auto' ? { note: `${text}${url ? '\n' : ''}先打开了嵌在终端里的面板。` } : { text }
}

// ---------- hooks ----------

export const register: Register = (on, options) => {
  const editorModel = typeof options.editorModel === 'string' && options.editorModel ? options.editorModel : 'sonnet'
  config.editorModel = editorModel
  config.trashDays = isKeep(options.trashDays) ? options.trashDays : '7'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'atlas',
      description: '打开 Atlas 面板：记忆、CLAUDE.md、会话、Skills、提示词、工具与 Hooks（终端里开成浏览器窗口）',
      argumentHint: '[window|pane]',
    })
    try {
      await seed($, e.cwd)
    } catch (err) {
      $.ui.log(`atlas: 没能读出开关默认值：${errText(err)}`, { to: 'debug' })
    }
    try {
      const panes = await $.ui.panes()
      if (panes.some(p => p.id === PANE) && !held.index) void startScan($)
    } catch {
      // nothing open
    }
    // the trash empties itself: now, then every six hours while this session runs
    void autoPurge($)
    $.clock.every(6 * 3600_000, () => void autoPurge($))
    return next(e)
  })

  on('command.run', { command: 'atlas' }, async ($, e) => {
    // `/atlas window` and `/atlas pane` say which; a bare `/atlas` is the window where only a terminal draws
    // the session, and the pane, as it always was, everywhere else
    const windowed = await atlasWindow($, windowWish(String(e.args ?? ''))).catch((err: unknown) => ({ note: `没能打开浏览器窗口：${errText(err)}。先打开了嵌在终端里的面板。` }))
    if ('text' in windowed) return { text: windowed.text }
    const lead = windowed.note ? `${windowed.note}\n` : ''
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
    if (opened.isPlaced) {
      if (!held.index && !held.scanning) void startScan($)
      return { text: `${lead}已打开 Atlas 面板。` }
    }
    // Not drawn now: the pane stays open, and a surface that attaches later draws it (session.attach
    // below starts its scan). Closing it here is what kept it from ever showing in a session whose
    // page had not attached yet.
    if (!held.index) await startScan($)
    return { text: lead + summary(opened.reason) }
  })

  on('session.attach', async ($, e, next) => {
    const out = await next(e)
    try {
      const panes = await $.ui.panes()
      if (panes.some(p => p.id === PANE) && !held.index && !held.scanning) void startScan($)
    } catch {
      // nothing open
    }
    return out
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'terminal' || e.surface === 'desktop') {
      const snap = await snapshot($, e.surface, editorModel)
      return drawPane(snap, { bodyColumns: e.props.bodyColumns, bodyRows: e.props.scroll.bodyRows, viewportRows: e.viewport?.rows }, $.ui.resolve(e))
    }
    const { Text } = $.ui.resolve(e)
    return <Text>{summary()}</Text>
  })

  on('ui.message', async ($, e, next) => {
    const post = asPost(e.data)
    if (post) {
      try {
        await handleBoard($, post, editorModel)
      } catch (err) {
        toast($, `没有完成：${errText(err)}`)
      }
    }
    return next(e)
  })

  // ---- enforcement of the switches ----

  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    const sw = await readSwitches($)
    if (sw.skillsOff.length === 0) return next(e)
    const text = filterSkillListing(e.text, new Set(sw.skillsOff))
    return text === e.text ? next(e) : next({ ...e, text })
  })

  on('skill.prompt', async ($, e, next) => {
    const sw = await readSwitches($)
    return sw.skillsOff.includes(e.skill) ? { text: SKILL_PROMPT_OFF } : next(e)
  })

  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const sw = await readSwitches($)
    return sw.skillsOff.includes(e.skill) ? { deny: SKILL_DENY } : next(e)
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    const why = guardFallback(e as unknown as Record<string, unknown>)
    // inert unless the switches positively say this skill is off
    return why === null || why === 'unknown' ? next(e) : { deny: why }
  })

  // one hook for every tool (the engine takes a single matcherless one per event): a tool the 工具 page
  // switched off is refused whoever calls it, then the path guards
  on('tool.call', async ($, e, next) => {
    const why = (await toolOffDecision($, String(e.tool))) ?? (await guardDecision($, e as unknown as Record<string, unknown>))
    return why ? { deny: why } : next(e)
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    const why = guardFallback(e as unknown as Record<string, unknown>)
    // inert unless the switches positively say this path is off; a tool switched off runs when they cannot be read
    return why === null || why === 'unknown' ? next(e) : { deny: why }
  })

  on('prompt.context', async ($, e, next) => {
    const out = await next(e)
    try {
      const files = out.instructionFiles ?? e.instructionFiles
      if (!files) return out
      const shaped = await shapeInstructionFiles($, files)
      return shaped ? { ...out, instructionFiles: shaped } : out
    } catch {
      return out
    }
  }).catch(($, e, next) => next(e))


  // ---- 提示词: the edits (and the 记忆 board's memory switch), where the engine assembles and composes the prompt ----

  on('prompt.section', async ($, e, next) => {
    heldM.original.set(e.name, e.text)
    const sw = await readSwitches($)
    let answer = sectionAnswer(sessionEdits(sw), e.name, e.text)
    if (!answer && e.name === 'memory') {
      // the 记忆 board's switch for this project's own memory
      const id = currentGroupId(await ensureCtx($))
      if (memState(sw, id, id) === 'off') answer = { text: null }
    }
    const raw = answer ?? (await next(e))
    const name = renameOf(sessionEdits(sw))
    const out = name && typeof raw.text === 'string' ? { ...raw, text: renameUser(raw.text, name).text } : raw
    return sw.promptNow === true ? { ...out, breakPromptCache: true } : out
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    try {
      const edits = sessionEdits(await readSwitches($))
      for (const s of out.sections) {
        if (!heldM.original.has(s.id) && edits.rewrite[s.id] === undefined && !s.id.startsWith(EXTRA_PREFIX)) heldM.original.set(s.id, s.text)
      }
      const sections = named(applyCompose(edits, out.sections), renameOf(edits))
      if (!e.traits.includes('bare')) {
        heldM.composed = seenOf(sections)
        // sections that changed: what lies outside them is looked for again in the requests that follow
        const mark = sectionsMark(heldM.composed)
        if (mark !== heldM.outsideUnder) {
          heldM.outsideUnder = mark
          heldM.outsideTries = OUTSIDE_TRIES
        }
      }
      return { ...out, sections }
    } catch {
      return out
    }
  }).catch(($, e, next) => next(e))

  // ---- 提示词: what a request's system prompt carries outside the sections; looked at, never changed ----

  on('http.fetch', ($, e, next) => {
    try {
      // whoever sends it: what tells the session's own prompt from any other is that it holds the sections
      noteOutside($, String(e.url), e.init?.body)
    } catch {
      // a look that fails costs nothing: the request goes on as it was
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // ---- 提示词: what the engine injects into the conversation (system reminders), counted and switched ----

  on('prompt.attachment', async ($, e, next) => {
    const type = String(e.type)
    const origin = e.origin?.kind ?? 'engine'
    const sw = await readSwitches($)
    if (injectOffOf(sessionEdits(sw)).includes(type)) {
      recordInject(type, e.text, origin, Date.now(), true)
      void bump($).catch(() => undefined)
      return { text: null }
    }
    const raw = await next(e)
    const name = renameOf(sessionEdits(sw))
    const out = name && typeof raw.text === 'string' ? { ...raw, text: renameUser(raw.text, name).text } : raw
    recordInject(type, out.text, origin, Date.now(), out.text === null)
    void bump($).catch(() => undefined)
    return out
  }).catch(($, e, next) => next(e))

  // ---- 工具: what each tool tells the model and where it waits; the name for "the user" over whatever is sent ----

  on('tool.describe', async ($, e, next) => {
    const out = await next(e)
    const tool = String(e.tool)
    // what the engine computed, kept for the page before anything here changes it
    const provider = e.provider?.tier === 'core' ? 'engine' : String(e.provider?.plugin ?? '')
    if (recordTool(tool, out.description, (out.isDeferred ?? e.isDeferred) === true, provider, Date.now())) void bump($).catch(() => undefined)
    const sw = await readSwitches($)
    const edits = sessionEdits(sw)
    const placed = toolAnswer(edits, tool, out)
    const name = renameOf(edits)
    const r = name ? renameUser(placed.description, name) : null
    const named = r && r.count ? { ...placed, description: r.text } : placed
    return sw.promptNow === true ? { ...named, breakPromptCache: true } : named
  }).catch(($, e, next) => next(e))

  // ---- Hooks: how often each classic event fired, for the page ----

  on('classic.*', ($, e, next) => {
    const event = next.event.slice('classic.'.length)
    const seen = heldM.fires.get(event)
    heldM.fires.set(event, { count: (seen?.count ?? 0) + 1, lastMs: Date.now() })
    return next(e)
  }).catch(($, e, next) => next(e))
}
