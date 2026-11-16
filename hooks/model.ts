// atlas: the pure half of the module. Constants, what the module holds
// between dispatches (the index, the in-memory undo), and every decision that
// needs no `$`: groups, switch states, guard roots, editability, file meta.

import type {
  AtlasCtx,
  AtlasExtra,
  AtlasFile,
  AtlasFmDraft,
  AtlasGroup,
  AtlasLoaded,
  AtlasMemoryState,
  AtlasMerge,
  AtlasOp,
  AtlasPrefs,
  AtlasScan,
  AtlasScope,
  AtlasSearch,
  AtlasSwitches,
  AtlasTrash,
  AtlasView,
} from '../types'
import type { AtlasIndex, CrossEdge, DocEdge, DocNode, Issue, IoDir, Project, Skill } from './data'
import { normalizeParked, normalizePromptPrefs } from './manage'
import { basename, dirname, firstBodyLine, isInside, normalizePath, parseFrontmatter, shortPath, slugify } from './text'

/** What the module keeps between dispatches: lost on a reload, rebuilt by a scan. */
export const held = {
  index: null as AtlasIndex | null,
  scanning: null as Promise<void> | null,
  /** A write made the index stale; rescan when the editor is left. */
  dirty: false,
  /** path → the text before the last save (null: the file did not exist). Never on disk. */
  undo: new Map<string, string | null>(),
  /** Undo of the last move / merge / reorder / fix; resolves an error or null. */
  opUndo: null as (() => Promise<string | null>) | null,
  /** The switches and context as last read, for a guard's failure handler (no `$` there). */
  mirror: null as AtlasSwitches | null,
  mirrorCtx: null as AtlasCtx | null,
  realCache: new Map<string, string>(),
  /** The interpreter atlas.py runs under on Windows, once found. */
  python: null as string | null,
}

/** Why the engine did not draw the pane, in plain words, with its own words after. */
export function notPlacedText(reason: string): string {
  const why = /no[- ]surface|no surface/i.test(reason)
    ? '这个会话的界面还没接上来'
    : /places panes/i.test(reason)
      ? '现在接着的界面不显示面板'
      : /columns/i.test(reason)
        ? '窗口太窄'
        : '引擎说现在放不了'
  return `面板还没画出来：${why}。它保持打开，界面一接上就会自己显示；过几秒再发一次 /atlas 也可以。（引擎的原话：${reason || '没有说明'}）`
}

/**
 * The text summary /atlas answers where no pane is drawn: with the engine's
 * `reason` when the pane is open and waiting, else for a surface that draws none.
 */
export function summary(reason?: string): string {
  const idx = held.index
  if (!idx) return 'Atlas：还没有扫描结果。'
  const withMemory = idx.projects.filter(p => p.memoryFiles.length > 0)
  const files = withMemory.reduce((n, p) => n + p.memoryFiles.length, 0)
  const sev = (s: string) => idx.health.filter(i => i.severity === s).length
  const cur = idx.projects.find(p => p.isCurrent)
  return [
    `Atlas：${withMemory.length} 个项目有记忆（共 ${files} 个文件），${idx.sessions.length} 个会话，${idx.skills.length} 个 skills。`,
    `体检：${sev('error')} 个错误 / ${sev('warn')} 个警告 / ${sev('info')} 个提示。`,
    cur ? `本会话项目：${cur.label}（${cur.memoryFiles.length} 个记忆文件）。` : '本会话的项目没有记忆目录。',
    reason === undefined ? '这个界面画不了完整面板；在 Claude 桌面 app 或终端里运行 /atlas 可以打开。' : notPlacedText(reason),
  ].join('\n')
}

export const PANE = 'atlas'
export const TITLE = 'Atlas · 记忆、Skills、提示词、工具与 Hooks'
export const SKILL_DENY = '这个 skill 已在 Atlas 面板里关闭。'
export const SKILL_PROMPT_OFF = '这个 skill 已在 Atlas 面板里关闭，不要使用它。'
export const MEMORY_DENY = '这组记忆在 Atlas 面板里关闭了。'
export const MOUNT_LIMIT = 100 * 1024

// ---------- state ----------

export const SCAN0: AtlasScan = { status: 'idle', dataVersion: 0, error: null, generatedAtMs: 0, elapsedMs: 0, tzOffsetMin: null }
export const VIEW0: AtlasView = {
  tab: 'memory',
  stack: [],
  limits: {},
  showSkillNames: false,
  memoryMode: 'overview',
  skillsMode: 'board',
  sortColumns: null,
  boardPage: {},
  scope: 'session',
  treeSlug: null,
  treeToggled: [],
  structureMode: 'tree',
  showArchived: false,
  trashDays: '',
  pending: null,
}
export const SEARCH0: AtlasSearch = { status: 'idle', query: '', error: null, results: [] }
export const FILE0: AtlasFile = {
  path: '',
  status: 'idle',
  text: '',
  isNew: false,
  error: null,
  size: 0,
  mtimeMs: 0,
  mode: 'read',
  anchor: 0,
  stale: false,
  note: null,
  fmDraft: null,
}
export const CTX0: AtlasCtx = { seeded: false, sessionId: '', cwd: '', home: '', claudeDir: '' }
export const SWITCHES0: AtlasSwitches = { skillsOff: [], skillDirs: {}, memory: {}, files: {} }
export const PREFS0: AtlasPrefs = {
  skillsOff: { global: [], byProject: {} },
  skillDirs: {},
  memory: { defaults: { global: {}, byProject: {} } },
  groups: [],
  archived: { sessions: [], projects: [] },
}
export const TRASH0: AtlasTrash = { status: 'idle', items: [], bytes: 0, error: null }
export const LOADED0: AtlasLoaded = { files: [], recordedAtMs: 0, added: [], removed: [], skipped: [] }
export const MERGE0: AtlasMerge = { status: 'idle', source: '', target: '', base: '', sourceBase: '', proposal: '', diff: '', error: null }
export const OP0: AtlasOp = { id: 0, label: '', canUndo: false, error: null }
export const EXTRA0: AtlasExtra = { claudeMds: null, skillFiles: null }

export function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

export function rec<T>(v: unknown, ok: (x: unknown) => x is T): Record<string, T> {
  const out: Record<string, T> = {}
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) if (ok(x)) out[k] = x
  }
  return out
}

export const isState = (x: unknown): x is AtlasMemoryState => x === 'mount' || x === 'read' || x === 'off'
export const isStr = (x: unknown): x is string => typeof x === 'string'
export const isStrList = (x: unknown): x is string[] => Array.isArray(x) && x.every(isStr)
export const isStateRec = (x: unknown): x is Record<string, AtlasMemoryState> =>
  typeof x === 'object' && x !== null && !Array.isArray(x) && Object.values(x).every(isState)

export function normalizePrefs(raw: unknown): AtlasPrefs {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const so = (typeof r.skillsOff === 'object' && r.skillsOff !== null ? r.skillsOff : {}) as Record<string, unknown>
  const mem = (typeof r.memory === 'object' && r.memory !== null ? r.memory : {}) as Record<string, unknown>
  const defs = (typeof mem.defaults === 'object' && mem.defaults !== null ? mem.defaults : {}) as Record<string, unknown>
  const groups = Array.isArray(r.groups)
    ? r.groups.flatMap(g => {
        const o = (typeof g === 'object' && g !== null ? g : {}) as Record<string, unknown>
        return typeof o.id === 'string' && typeof o.name === 'string' ? [{ id: o.id, name: o.name, paths: strList(o.paths) }] : []
      })
    : []
  return {
    skillsOff: { global: strList(so.global), byProject: rec(so.byProject, isStrList) },
    skillDirs: rec(r.skillDirs, isStr),
    memory: { defaults: { global: rec(defs.global, isState), byProject: rec(defs.byProject, isStateRec) } },
    groups,
    archived: {
      sessions: strList((r.archived as Record<string, unknown> | undefined)?.sessions),
      projects: strList((r.archived as Record<string, unknown> | undefined)?.projects),
    },
    prompt: normalizePromptPrefs(r.prompt),
    hooksOff: normalizeParked(r.hooksOff),
    ...(typeof r.skin === 'string' && r.skin ? { skin: r.skin } : {}),
    ...(isKeep(r.trashDays) ? { trashDays: r.trashDays } : {}),
  }
}

export function lastLine(s: string): string {
  const lines = s.trim().split('\n')
  return (lines[lines.length - 1] ?? '').trim()
}

export function parseJson(s: string): unknown {
  try {
    return JSON.parse(s) as unknown
  } catch {
    return undefined
  }
}

export function projectBySlug(slug: string): Project | undefined {
  return held.index?.projects.find(p => p.slug === slug)
}

export function currentProject(): Project | undefined {
  return held.index?.projects.find(p => p.isCurrent)
}

export function currentGroupId(ctx: AtlasCtx): string {
  return `project:${currentProject()?.slug ?? slugify(ctx.cwd)}`
}

/** Every memory group: one per project memory dir, the custom folders, the person's own. */
export function allGroups(ctx: AtlasCtx, prefs: AtlasPrefs): AtlasGroup[] {
  const out: AtlasGroup[] = []
  const idx = held.index
  if (idx) {
    for (const p of idx.projects) {
      if (!p.memoryDir) continue
      if (!p.isCurrent && p.memoryFiles.length === 0 && !(p.index?.exists && p.index.bytes > 0)) continue
      out.push({ id: `project:${p.slug}`, name: p.label, paths: [p.memoryDir] })
    }
    for (const c of idx.customMemory) out.push({ id: c.name, name: c.name, paths: [c.path] })
  } else if (ctx.claudeDir) {
    out.push({ id: currentGroupId(ctx), name: '本项目', paths: [`${ctx.claudeDir}/projects/${slugify(ctx.cwd)}/memory`] })
  }
  for (const g of prefs.groups) if (!out.some(o => o.id === g.id)) out.push(g)
  return out
}

/** A group's folders without the index (enough for the guards). */
export function groupPaths(id: string, ctx: AtlasCtx, prefs: AtlasPrefs): string[] {
  const own = prefs.groups.find(g => g.id === id)
  if (own) return own.paths
  if (id.startsWith('project:')) {
    const slug = id.slice('project:'.length)
    return [projectBySlug(slug)?.memoryDir ?? `${ctx.claudeDir}/projects/${slug}/memory`]
  }
  if (id === 'shared-memory' || id === 'memory-archive') {
    return [held.index?.customMemory.find(c => c.name === id)?.path ?? `${ctx.claudeDir}/${id}`]
  }
  return []
}

export function memState(sw: AtlasSwitches, id: string, currentId: string): AtlasMemoryState {
  return sw.memory[id] ?? (id === currentId ? 'mount' : 'read')
}

export function defaultState(prefs: AtlasPrefs, scope: AtlasScope, cwd: string, id: string, currentId: string): AtlasMemoryState {
  const table = scope === 'global' ? prefs.memory.defaults.global : prefs.memory.defaults.byProject[cwd] ?? {}
  return table[id] ?? (scope === 'project' ? prefs.memory.defaults.global[id] : undefined) ?? (id === currentId ? 'mount' : 'read')
}

export function groupOfPath(path: string, ctx: AtlasCtx, prefs: AtlasPrefs): AtlasGroup | undefined {
  return allGroups(ctx, prefs).find(g => g.paths.some(root => isInside(path, root)))
}

export function skillOffIn(prefs: AtlasPrefs, scope: AtlasScope, cwd: string, sw: AtlasSwitches): string[] {
  if (scope === 'session') return sw.skillsOff
  if (scope === 'global') return prefs.skillsOff.global
  return prefs.skillsOff.byProject[cwd] ?? []
}

/** Where a session-off skill comes from, for its label. */
export function skillOffLevel(prefs: AtlasPrefs, cwd: string, name: string): '本项目' | '默认' | '本会话' {
  if ((prefs.skillsOff.byProject[cwd] ?? []).includes(name)) return '本项目'
  if (prefs.skillsOff.global.includes(name)) return '默认'
  return '本会话'
}

// ---------- enforcement ----------

export const PATH_TOOLS: Record<string, readonly string[]> = {
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Grep: ['path'],
  Glob: ['path', 'pattern'],
}
export const SKILL_PATH_TOOLS = new Set(['Read', 'NotebookEdit', 'Grep', 'Glob'])

export type Roots = { skills: string[]; memory: string[] }

export function offRoots(sw: AtlasSwitches, ctx: AtlasCtx, prefs: AtlasPrefs): Roots {
  const skills = sw.skillsOff.map(n => sw.skillDirs[n]).filter((d): d is string => typeof d === 'string' && d.length > 1)
  const memory: string[] = []
  for (const [id, state] of Object.entries(sw.memory)) if (state === 'off') memory.push(...groupPaths(id, ctx, prefs))
  for (const [path, state] of Object.entries(sw.files)) if (state === 'off') memory.push(path)
  return { skills, memory: memory.filter(p => p.length > 1) }
}

export function toolPaths(e: Record<string, unknown>, tool: string, ctx: AtlasCtx): string[] {
  // an own key only: a tool may be named `constructor`
  const keys = Object.hasOwn(PATH_TOOLS, tool) ? PATH_TOOLS[tool] ?? [] : []
  const out: string[] = []
  for (const k of keys) {
    const v = e[k]
    if (typeof v !== 'string' || !v) continue
    if (k === 'pattern' && !v.startsWith('/') && !v.startsWith('~')) continue
    const base = k === 'pattern' ? v.replace(/[*?[{].*$/, '') : v
    out.push(normalizePath(base || '/', ctx.cwd || '/', ctx.home))
  }
  return out
}

export function spellings(root: string, home: string): string[] {
  const out = new Set([root, shortPath(root, home), root.replace(/ /g, '\\ ')])
  return [...out].filter(s => s.length > 2)
}

export function bashHits(command: string, roots: readonly string[], home: string): boolean {
  return roots.some(r => spellings(r, home).some(s => command.includes(s)))
}

/** The same decision from the held.mirror alone, for a guard that failed (no `$`). */
export function guardFallback(e: Record<string, unknown>): string | null | 'unknown' {
  const tool = String(e.tool)
  if (tool !== 'Skill' && tool !== 'Bash' && !Object.hasOwn(PATH_TOOLS, tool)) return null
  const sw = held.mirror
  const ctx = held.mirrorCtx
  if (!sw || !ctx) return 'unknown'
  if (tool === 'Skill') return sw.skillsOff.includes(String(e.skill)) ? SKILL_DENY : null
  const roots = offRoots(sw, ctx, PREFS0)
  if (tool === 'Bash') {
    const cmd = typeof e.command === 'string' ? e.command : ''
    return bashHits(cmd, roots.skills, ctx.home) ? SKILL_DENY : bashHits(cmd, roots.memory, ctx.home) ? MEMORY_DENY : null
  }
  const paths = toolPaths(e, tool, ctx)
  if (SKILL_PATH_TOOLS.has(tool) && paths.some(p => roots.skills.some(r => isInside(p, r)))) return SKILL_DENY
  if (paths.some(p => roots.memory.some(r => isInside(p, r)))) return MEMORY_DENY
  return null
}


export type EditInfo = { editable: boolean; note: string | null; isMemory: boolean; isIndexFile: boolean }

export const TEXT_EXT = /\.(md|markdown|txt|py|sh|bash|zsh|js|mjs|cjs|ts|tsx|jsx|json|jsonc|ya?ml|toml|ini|cfg|html?|css|csv|tsv|xml|rb|go|rs|swift|sql)$/i

export function editInfo(path: string, ctx: AtlasCtx): EditInfo {
  const cd = ctx.claudeDir
  const isMd = path.toLowerCase().endsWith('.md')
  const isIndexFile = basename(path) === 'MEMORY.md'
  const memRoots = cd
    ? [`${cd}/shared-memory`, `${cd}/memory-archive`, ...(held.index?.customMemory.map(c => c.path) ?? [])]
    : []
  const inProjectMemory = cd ? new RegExp(`^${escapeRe(cd)}/projects/[^/]+/memory/`).test(path) : false
  if ((inProjectMemory || memRoots.some(r => isInside(path, r))) && isMd) {
    return { editable: true, note: null, isMemory: true, isIndexFile }
  }
  const claudeMds = new Set<string>()
  if (cd) claudeMds.add(`${cd}/CLAUDE.md`)
  if (held.index?.globalClaudeMd.path) claudeMds.add(held.index.globalClaudeMd.path)
  const cwds = new Set<string>([ctx.cwd, ...(held.index?.projects.map(p => p.cwd ?? '') ?? [])])
  for (const c of cwds) if (c) for (const f of projectClaudeMdPaths(c)) claudeMds.add(f)
  if (claudeMds.has(path)) return { editable: true, note: null, isMemory: false, isIndexFile: false }
  const skill = skillOfPath(path)
  if (skill && skill.path) {
    if (skill.source === 'synced' || skill.source === 'plugin') {
      return { editable: false, note: '只读：由 Claude 应用同步/插件提供，改了会被覆盖', isMemory: false, isIndexFile: false }
    }
    if (TEXT_EXT.test(path)) return { editable: true, note: null, isMemory: false, isIndexFile: false }
    return { editable: false, note: '只读：不是文本文件', isMemory: false, isIndexFile: false }
  }
  if (cd && (isInside(path, `${cd}/skills/synced`) || isInside(path, `${cd}/plugins`))) {
    return { editable: false, note: '只读：由 Claude 应用同步/插件提供，改了会被覆盖', isMemory: false, isIndexFile: false }
  }
  if (cd && isInside(path, `${cd}/skills`) && TEXT_EXT.test(path)) {
    return { editable: true, note: null, isMemory: false, isIndexFile: false }
  }
  return { editable: false, note: '只读：不在 Atlas 可编辑的范围内', isMemory: false, isIndexFile: false }
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function projectClaudeMdPaths(cwd: string): string[] {
  const c = cwd.replace(/\/$/, '')
  return [`${c}/CLAUDE.md`, `${c}/.claude/CLAUDE.md`, `${c}/CLAUDE.local.md`]
}

export function skillOfPath(path: string): Skill | undefined {
  return held.index?.skills.find(s => s.path && isInside(path, dirname(s.path)))
}

export function folderOf(group: AtlasGroup): string | undefined {
  return group.paths[0]
}

export function isProjectGroup(group: AtlasGroup): boolean {
  return group.id.startsWith('project:')
}

export function titleOf(text: string, name: string): { title: string; description: string } {
  const fm = parseFrontmatter(text)
  return {
    title: fm?.name?.value || name.replace(/\.md$/, ''),
    description: fm?.description?.value || firstBodyLine(text),
  }
}

export const MERGE_SYSTEM = [
  'You merge two memory files of a Claude Code user into one file.',
  'Output ONLY the complete merged file, nothing before or after it, no code fence.',
  'Keep the TARGET file\'s frontmatter block and its `name` and `type` (metadata.type or type) exactly as they are.',
  'Combine the two descriptions into the target\'s `description` (one line).',
  'Combine both bodies; drop facts that say the same thing twice; keep every distinct fact, date and rule.',
  'Keep the language of the files: where they are Chinese, write Chinese.',
  'Change nothing else; keep the target\'s formatting style.',
].join('\n')

export function memoryIndexPath(p: Project): string | null {
  return p.memoryDir ? `${p.memoryDir.replace(/\/$/, '')}/MEMORY.md` : null
}

export function deadLinkName(issue: Issue): string | null {
  const p = issue.projectSlug ? projectBySlug(issue.projectSlug) : undefined
  const dead = p?.index?.deadLinks ?? []
  const own = basename(issue.path)
  if (own !== 'MEMORY.md' && own.endsWith('.md')) return own
  return dead.find(d => issue.message.includes(d)) ?? (dead.length === 1 ? dead[0] ?? null : null)
}

export function draftFor(path: string, text: string): AtlasFmDraft {
  return { name: basename(path).replace(/\.md$/i, ''), description: firstBodyLine(text), type: '' }
}


// ---------- v2: document tree, cross links, reads and writes, trash ----------

export const EDGE_TAG: Record<string, string> = {
  import: '@导入',
  link: '链接',
  index: '索引',
  wikilink: '[[ ]]',
  nested: '子目录',
  symlink: '软链接',
  'session-read': '会话读',
  'session-write': '会话写',
}

export const IO_CLASS: Record<IoDir['class'], string> = { project: '项目内', scratch: '临时', claude: 'Claude', external: '外部' }

/** How long a deleted thing may be kept: a number of days, or `never` (kept until it is emptied by hand). */
export const NEVER = 'never'
export const TRASH_DAYS = ['1', '7', '30', '90', NEVER] as const

/** True for a keep period atlas.py takes: whole days, or `never`. */
export function isKeep(v: unknown): v is string {
  return typeof v === 'string' && (v === NEVER || /^\d{1,4}$/.test(v))
}

/** `保留 7 天` / `一直保留，只手动清空`: a keep period as a choice reads. */
export function keepLabel(days: string): string {
  return days === NEVER ? '一直保留，只手动清空' : `保留 ${days} 天`
}

/** `7 天` / `只手动清空`: the same, short. */
export function keepShort(days: string): string {
  return days === NEVER ? '只手动清空' : `${days} 天`
}

/** `7 天后自动清空` / `不会自动清空`: what becomes of a thing deleted under that keep period. */
export function keepNote(days: string): string {
  return days === NEVER ? '不会自动清空' : `${days} 天后自动清空`
}

export type DocMaps = { byId: Map<string, DocNode>; out: Map<string, DocEdge[]> }

export function docMaps(idx: AtlasIndex): DocMaps {
  const byId = new Map<string, DocNode>()
  const out = new Map<string, DocEdge[]>()
  for (const n of idx.docs?.nodes ?? []) byId.set(n.id, n)
  for (const e of idx.docs?.edges ?? []) {
    if (e.type === 'symlink') continue
    const list = out.get(e.from) ?? []
    list.push(e)
    out.set(e.from, list)
  }
  return { byId, out }
}

/** A project's tree roots: the global CLAUDE.md, the project's CLAUDE.md family, its MEMORY.md. */
export function treeRoots(idx: AtlasIndex, slug: string): DocNode[] {
  const nodes = idx.docs?.nodes ?? []
  const roots: DocNode[] = []
  const global = nodes.find(n => n.kind === 'claude-md' && n.scope === 'global' && n.path === idx.globalClaudeMd.path)
  if (global) roots.push(global)
  const p = idx.projects.find(x => x.slug === slug)
  const family = p ? projectClaudeMdPaths(p.resolvedCwd ?? p.cwd ?? '') : []
  const mine = nodes.filter(n => n.kind === 'claude-md' && n.projectSlug === slug)
  mine.sort((a, b) => {
    const ia = family.indexOf(a.path)
    const ib = family.indexOf(b.path)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.path.localeCompare(b.path)
  })
  roots.push(...mine)
  const index = nodes.find(n => n.kind === 'memory-index' && n.projectSlug === slug)
  if (index) roots.push(index)
  return roots
}

/** What a cross-link endpoint is called in the pane. */
export function scopeLabel(idx: AtlasIndex, key: string): string {
  if (key === 'global') return '全局'
  if (key === 'shared-memory') return '共享记忆'
  if (key === 'memory-archive') return '记忆归档'
  return idx.projects.find(p => p.slug === key)?.label ?? key
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const KIND_COLOR: Record<string, string> = {
  import: '#4C78A8',
  link: '#59A14F',
  index: '#9C755F',
  wikilink: '#B07AA1',
  nested: '#F28E2B',
  symlink: '#76B7B2',
  'session-read': '#8CB4E0',
  'session-write': '#E15759',
}

/** The 交织 graph as one SVG: endpoints on a circle, a line per cross link. */
export function crossSvg(idx: AtlasIndex, edges: readonly CrossEdge[]): string {
  const top = edges.slice(0, 80)
  const keys: string[] = []
  for (const e of top) for (const k of [e.from, e.to]) if (!keys.includes(k)) keys.push(k)
  const shown = keys.slice(0, 32)
  const W = 640
  const H = 480
  const cx = W / 2
  const cy = 210
  const R = 170
  const pos = new Map<string, { x: number; y: number }>()
  shown.forEach((k, i) => {
    const a = (2 * Math.PI * i) / Math.max(1, shown.length) - Math.PI / 2
    pos.set(k, { x: Math.round(cx + R * Math.cos(a)), y: Math.round(cy + R * Math.sin(a)) })
  })
  const parts: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="-apple-system, PingFang SC, sans-serif">`]
  for (const e of top) {
    const a = pos.get(e.from)
    const b = pos.get(e.to)
    if (!a || !b) continue
    const w = Math.min(8, 1 + Math.log2(e.count + 1))
    parts.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${KIND_COLOR[e.kind] ?? '#999'}" stroke-width="${w.toFixed(1)}" stroke-opacity="0.65"><title>${xml(`${scopeLabel(idx, e.from)} → ${scopeLabel(idx, e.to)} · ${EDGE_TAG[e.kind] ?? e.kind} · ${e.count}`)}</title></line>`)
  }
  for (const k of shown) {
    const p = pos.get(k)
    if (!p) continue
    const label = scopeLabel(idx, k)
    const short = label.length > 14 ? label.slice(0, 13) + '…' : label
    const anchor = p.x < cx - 10 ? 'end' : p.x > cx + 10 ? 'start' : 'middle'
    const dx = anchor === 'end' ? -9 : anchor === 'start' ? 9 : 0
    const dy = anchor === 'middle' ? (p.y < cy ? -10 : 18) : 4
    parts.push(`<circle cx="${p.x}" cy="${p.y}" r="5" fill="#888"/><text x="${p.x + dx}" y="${p.y + dy}" font-size="12" fill="#888" text-anchor="${anchor}">${xml(short)}</text>`)
  }
  const kinds = [...new Set(top.map(e => e.kind))]
  kinds.forEach((k, i) => {
    const x = 16 + (i % 4) * 150
    const y = H - 40 + Math.floor(i / 4) * 18
    parts.push(`<line x1="${x}" y1="${y}" x2="${x + 22}" y2="${y}" stroke="${KIND_COLOR[k] ?? '#999'}" stroke-width="3"/><text x="${x + 28}" y="${y + 4}" font-size="12" fill="#888">${xml(EDGE_TAG[k] ?? k)}</text>`)
  })
  parts.push('</svg>')
  return parts.join('')
}

/** The project a 交织 endpoint opens, when it is one. */
export function isProjectKey(idx: AtlasIndex, key: string): boolean {
  return idx.projects.some(p => p.slug === key)
}

/** A label atlas.py archive-memory takes: no `/`, not hidden. */
export function archiveLabel(label: string): string {
  const s = label.replace(/\//g, '-').trim() || 'project'
  return s.startsWith('.') ? `_${s.slice(1)}` : s
}

/** 已移到 / 曾用名 for a project row, or ''. */
export function renameNote(p: Project, home: string): string {
  if (p.resolvedCwd && (p.resolution === 'relocated' || p.resolution === 'slug-match' || p.resolution === 'related')) {
    return `已移到 ${shortPath(p.resolvedCwd, home)}`
  }
  const now = p.resolvedCwd ?? p.cwd
  const old = (p.pathHistory ?? []).find(h => h.launch && h.path !== now && basename(h.path) !== p.label)
  return old ? `曾用名 ${basename(old.path)}` : ''
}
