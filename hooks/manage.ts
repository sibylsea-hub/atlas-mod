// atlas: the pure half of the 提示词, 工具 and Hooks pages. What the module
// holds for them between dispatches, the edits to the system prompt and to the
// tools and how they apply, and the settings files' hooks: reading, switching,
// rewriting.
// No `$` here and no import from model.ts (it imports this file).

import type {
  AtlasCtx,
  AtlasHookDraft,
  AtlasLoad,
  AtlasManage,
  AtlasParkedHook,
  AtlasPrefs,
  AtlasPromptEdits,
  AtlasPromptExtra,
  AtlasScope,
  AtlasSwitches,
} from '../types'

// ---------- state ----------

export const LOAD0: AtlasLoad = { status: 'idle', error: null, atMs: 0 }
export const MANAGE0: AtlasManage = { prompt: LOAD0, hooks: LOAD0, hooksUndo: null, tools: LOAD0 }
export const EDITS0: AtlasPromptEdits = { off: [], rewrite: {}, extra: [] }

export type SectionScope = 'shared' | 'session'
export type SectionSeen = { id: string; text: string; scope: SectionScope }

/** One kind of injected message as this session has seen it: how often, how much, and its latest text. */
export type InjectSeen = { count: number; blocked: number; chars: number; lastText: string; origin: string; lastMs: number }

/** What the last settings write replaced, for its one level of undo. */
export type HooksUndo = {
  /** '' when the change touched no file (a parked hook deleted). */
  path: string
  before: string | null
  after: string
  label: string
  /** The parked entry an undo puts back, and the id of the one it takes out. */
  parkedAdd: AtlasParkedHook | null
  parkedDrop: string | null
}

/** One tool as `tool.describe` last gave it, before any edit of this module's. */
export type ToolSeen = {
  /** Its description as the layers beneath this module computed it. */
  text: string
  /** True when it waits behind ToolSearch by the engine's own rule. */
  isDeferred: boolean
  /** Who provides it: `engine`, `mcp:<server>`, or a plugin's name ('' when the engine did not say). */
  provider: string
  lastMs: number
}

/** One tool as `$.tool.list()` names it. */
export type ToolListed = { name: string; mcp: boolean }

/** What the module keeps for the pages: lost on a reload, read again on demand. */
export const heldM = {
  /** The system prompt's sections as last composed, this module's edits applied. */
  composed: null as SectionSeen[] | null,
  /** Section id → the text the engine computed before any edit (null: it leaves the section out). */
  original: new Map<string, string | null>(),
  hooks: null as HookScan | null,
  hooksUndo: null as HooksUndo | null,
  /** Classic hook event → how often it fired in this session since the module loaded. */
  fires: new Map<string, { count: number; lastMs: number }>(),
  /** Injected message kind → what this session has seen of it since the module loaded. */
  injects: new Map<string, InjectSeen>(),
  /** Tool name → what `tool.describe` last gave for it since the module loaded. */
  tools: new Map<string, ToolSeen>(),
  /** The tools `$.tool.list()` last named; null until asked. */
  toolList: null as ToolListed[] | null,
  /** What the system prompt carried beside the sections, in the last request read; null until one is. */
  outside: null as OutsideSeen | null,
  /** How many more requests may be read for it: a request's body is parsed only while this is above zero. */
  outsideTries: 6,
  /** The sections `outside` was last looked for under: their ids and lengths, to tell when they changed. */
  outsideUnder: '',
  /** The system prompts of the last few requests read while a look was owed, newest last: matched once the sections are known. */
  sent: [] as SentSystem[],
  /** How many requests have been read since the module loaded, for the page to say. */
  outsideLooked: 0,
}

// ---------- 提示词: what the system prompt carries outside the sections ----------
//
// The engine composes the system prompt from sections, and those a mod can switch and rewrite. A
// request's `system` holds more than that: a line or two of the engine's own in front, and whatever the
// app that started the session appended (an app's own rules for its tools, say). None of it passes
// through `prompt.section` or `prompt.compose`, so it is read off the request the engine sends, where
// the engine shows its requests to a mod, and shown as it is: read, never changed.

/** One stretch of the system prompt that no section accounts for, and the block of `system` it stood in. */
export type OutsidePiece = { text: string; block: number }

export type OutsideSeen = {
  pieces: OutsidePiece[]
  /** How many blocks the request's `system` had, and how many of the sections were found in them. */
  blocks: number
  matched: number
  model: string
  atMs: number
}

/** How many requests are read before giving up, each time the look is asked for again. */
export const OUTSIDE_TRIES = 6

/** One request's system prompt, kept until the sections are known and it can be told whose prompt it is. */
export type SentSystem = { blocks: string[]; model: string; atMs: number }

/** How many are kept: the session's own prompt and those of a few side requests sent around it. */
export const SENT_KEPT = 4

/** The list with one more: a prompt that says the same as one kept takes its place, and the oldest go past the cap. */
export function keepSent(list: readonly SentSystem[], one: SentSystem): SentSystem[] {
  const same = (a: SentSystem) => a.blocks.length === one.blocks.length && a.blocks.every((b, i) => b === one.blocks[i])
  return [...list.filter(a => !same(a)), one].slice(-SENT_KEPT)
}

/**
 * Among the prompts kept, the one that holds the sections (the most of them, the newest on a tie),
 * read for what lies outside them; null while the sections are not known or no prompt kept is theirs.
 */
export function settleOutside(sent: readonly SentSystem[], sections: readonly SectionSeen[] | null): OutsideSeen | null {
  if (!sections || sections.length === 0) return null
  const texts = sections.map(s => s.text)
  let best: OutsideSeen | null = null
  for (const one of sent) {
    const { pieces, matched, asked } = outsideOf(one.blocks, texts)
    if (!isOwnPrompt(matched, asked)) continue
    if (!best || matched >= best.matched) best = { pieces, blocks: one.blocks.length, matched, model: one.model, atMs: one.atMs }
  }
  return best
}

/**
 * Settles what is held: when a prompt kept is the sections' own, it becomes what the page lists and
 * the look is over. Says whether it did.
 */
export function settleHeld(): boolean {
  const seen = settleOutside(heldM.sent, heldM.composed)
  if (!seen) return false
  heldM.outside = seen
  heldM.sent = []
  heldM.outsideTries = 0
  return true
}

/** The text blocks of the `system` a model request carries; null when the body is not such a request. */
export function systemBlocks(body: string): { blocks: string[]; model: string } | null {
  if (body.length < 2 || body[0] !== '{' || !body.includes('"system"')) return null
  let doc: unknown
  try {
    doc = JSON.parse(body)
  } catch {
    return null
  }
  if (!isObj(doc)) return null
  const system = doc.system
  const blocks =
    typeof system === 'string'
      ? [system]
      : Array.isArray(system)
        ? system.flatMap(b => (typeof b === 'string' ? [b] : isObj(b) && typeof b.text === 'string' ? [b.text] : []))
        : []
  if (blocks.length === 0) return null
  return { blocks, model: typeof doc.model === 'string' ? doc.model : '' }
}

/**
 * The blocks with every section's text taken out, and what is left between: each stretch that holds
 * more than white space, in the order sent. `matched` counts the sections found, so a caller can tell
 * the session's own prompt from another one (a subagent's, a side request's) that shares little of it.
 */
export function outsideOf(blocks: readonly string[], sections: readonly string[]): { pieces: OutsidePiece[]; matched: number; asked: number } {
  // the longest first: a short section's words may also stand inside a longer one
  const wanted = [...new Set(sections.map(s => s.trim()).filter(s => s.length >= 8))].sort((a, b) => b.length - a.length)
  const found = new Set<string>()
  const pieces: OutsidePiece[] = []
  blocks.forEach((block, i) => {
    let parts = [block]
    for (const s of wanted) {
      const next: string[] = []
      for (const part of parts) {
        const at = part.indexOf(s)
        if (at < 0) {
          next.push(part)
          continue
        }
        found.add(s)
        next.push(part.slice(0, at), part.slice(at + s.length))
      }
      parts = next
    }
    for (const part of parts) for (const text of splitOutside(part)) pieces.push({ text, block: i })
  })
  return { pieces, matched: found.size, asked: wanted.length }
}

/** A stretch this long or longer is listed by its parts, so that one of them can be found by its heading. */
const OUTSIDE_WHOLE = 1200

/**
 * A stretch of text as the parts a reader would look for: it is cut before each first- or
 * second-level heading, before a line that opens a tag of its own (`<browsers>`), and after a line
 * that closes one. A short stretch stays whole; nothing inside a code fence is taken for a heading.
 */
export function splitOutside(text: string): string[] {
  const whole = text.trim()
  if (!whole) return []
  if (whole.length < OUTSIDE_WHOLE) return [whole]
  const parts: string[] = []
  let cur: string[] = []
  let isFenced = false
  let isAfterClose = false
  const flush = () => {
    const part = cur.join('\n').trim()
    if (part) parts.push(part)
    cur = []
  }
  for (const line of whole.split('\n')) {
    const isFence = /^\s*(```|~~~)/.test(line)
    if (!isFenced && !isFence) {
      const starts = /^#{1,2} \S/.test(line) || /^<[A-Za-z][\w-]*>\s*$/.test(line) || (isAfterClose && line.trim() !== '')
      if (starts) flush()
    }
    if (isFence) isFenced = !isFenced
    cur.push(line)
    if (!isFenced && line.trim() !== '') isAfterClose = /^<\/[A-Za-z][\w-]*>\s*$/.test(line)
  }
  flush()
  return parts
}

/** True when the blocks hold at least half of the sections: the prompt the sections were composed for. */
export function isOwnPrompt(matched: number, asked: number): boolean {
  return asked > 0 && matched >= Math.max(1, Math.ceil(asked / 2))
}

/** A signature of the sections as composed: it changes when one is added, dropped or rewritten. */
export function sectionsMark(sections: readonly SectionSeen[] | null): string {
  return sections ? sections.map(s => `${s.id}:${s.text.length}`).join('|') : ''
}

/** What a piece is called in the list: what it is when that is known, else its first line. */
export function outsideName(text: string): string {
  if (/^x-anthropic-billing-header:/i.test(text)) return '计费标记'
  if (/^You are Claude Code\b/.test(text) && text.length < 400) return '身份声明'
  // a heading is its own words; a tag is shown as it is written
  const first = (text.split('\n').find(line => line.trim()) ?? '').trim().replace(/^#+\s*/, '')
  return first.length > 48 ? first.slice(0, 47) + '…' : first || '（空）'
}

// ---------- 提示词: edits ----------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** Where a level puts a tool: in the prompt's list, behind ToolSearch, or behind it with every call refused. */
export type ToolPlace = 'pin' | 'defer' | 'off'

const isPlace = (v: unknown): v is ToolPlace => v === 'pin' || v === 'defer' || v === 'off'
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

// A tool's name is whatever its maker called it, `constructor` and `__proto__`
// included. So the two records keyed by tool name are read by own key only, and
// built entry by entry (Object.fromEntries defines each key, it never assigns):
// no name reads from the prototype or writes to it.

function own<T>(rec: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return rec !== undefined && Object.hasOwn(rec, key) ? rec[key] : undefined
}

function entriesOf<T>(raw: unknown, ok: (v: unknown) => v is T): [string, T][] {
  return isObj(raw) ? Object.entries(raw).filter((kv): kv is [string, T] => ok(kv[1])) : []
}

/** The record with `key` set to `value`, or taken out (undefined); undefined when nothing is left. */
function withKey<T>(rec: Readonly<Record<string, T>> | undefined, key: string, value: T | undefined): Record<string, T> | undefined {
  const entries = Object.entries(rec ?? {}).filter(([k]) => k !== key)
  if (value !== undefined) entries.push([key, value])
  return entries.length ? Object.fromEntries(entries) : undefined
}

export function normalizeEdits(raw: unknown): AtlasPromptEdits {
  if (!isObj(raw)) return EDITS0
  const rewrite: Record<string, string> = {}
  if (isObj(raw.rewrite)) for (const [k, v] of Object.entries(raw.rewrite)) if (typeof v === 'string') rewrite[k] = v
  const extra: AtlasPromptExtra[] = []
  if (Array.isArray(raw.extra)) {
    for (const x of raw.extra) {
      if (!isObj(x) || typeof x.id !== 'string' || !x.id || extra.some(e => e.id === x.id)) continue
      extra.push({ id: x.id, name: typeof x.name === 'string' ? x.name : x.id, text: typeof x.text === 'string' ? x.text : '', off: x.off === true })
    }
  }
  const out: AtlasPromptEdits = { off: [...new Set(strs(raw.off))], rewrite, extra }
  const injectOff = [...new Set(strs(raw.injectOff))]
  if (injectOff.length) out.injectOff = injectOff
  const rename = typeof raw.rename === 'string' ? cleanName(raw.rename) : ''
  if (rename) out.rename = rename
  const toolPlace = entriesOf(raw.toolPlace, isPlace)
  if (toolPlace.length) out.toolPlace = Object.fromEntries(toolPlace)
  const toolRewrite = entriesOf(raw.toolRewrite, isText)
  if (toolRewrite.length) out.toolRewrite = Object.fromEntries(toolRewrite)
  return out
}

export function normalizePromptPrefs(raw: unknown): NonNullable<AtlasPrefs['prompt']> {
  const r = isObj(raw) ? raw : {}
  const byProject: Record<string, AtlasPromptEdits> = {}
  if (isObj(r.byProject)) for (const [k, v] of Object.entries(r.byProject)) byProject[k] = normalizeEdits(v)
  return { global: normalizeEdits(r.global), byProject }
}

export function promptPrefs(prefs: AtlasPrefs): NonNullable<AtlasPrefs['prompt']> {
  return prefs.prompt ?? { global: EDITS0, byProject: {} }
}

/** A session's starting edits: the global default, then the project's over it. */
export function mergeEdits(global: AtlasPromptEdits, project: AtlasPromptEdits | undefined): AtlasPromptEdits {
  if (!project) return global
  const extra = [...project.extra, ...global.extra.filter(g => !project.extra.some(p => p.id === g.id))]
  const merged: AtlasPromptEdits = { off: [...new Set([...global.off, ...project.off])], rewrite: { ...global.rewrite, ...project.rewrite }, extra }
  const injectOff = [...new Set([...injectOffOf(global), ...injectOffOf(project)])]
  if (injectOff.length) merged.injectOff = injectOff
  const rename = renameOf(project) || renameOf(global)
  if (rename) merged.rename = rename
  const toolPlace = [...Object.entries(global.toolPlace ?? {}), ...Object.entries(project.toolPlace ?? {})]
  if (toolPlace.length) merged.toolPlace = Object.fromEntries(toolPlace)
  const toolRewrite = [...Object.entries(global.toolRewrite ?? {}), ...Object.entries(project.toolRewrite ?? {})]
  if (toolRewrite.length) merged.toolRewrite = Object.fromEntries(toolRewrite)
  return merged
}

export function sessionEdits(sw: AtlasSwitches | null | undefined): AtlasPromptEdits {
  return sw?.prompt ?? EDITS0
}

export function editsIn(prefs: AtlasPrefs, scope: AtlasScope, cwd: string, sw: AtlasSwitches): AtlasPromptEdits {
  if (scope === 'session') return sessionEdits(sw)
  const p = promptPrefs(prefs)
  return scope === 'global' ? p.global : p.byProject[cwd] ?? EDITS0
}

export const LEVELS = ['session', 'project', 'global'] as const
export const LEVEL_NAME: Record<AtlasScope, string> = { session: '本会话', project: '本项目', global: '全局' }

/** The edits at each of the three levels, side by side: where a change comes from. */
export function levelEdits(prefs: AtlasPrefs, cwd: string, sw: AtlasSwitches): Record<AtlasScope, AtlasPromptEdits> {
  const p = promptPrefs(prefs)
  return { session: sessionEdits(sw), project: p.byProject[cwd] ?? EDITS0, global: p.global }
}

export function levelsWhere(all: Record<AtlasScope, AtlasPromptEdits>, has: (e: AtlasPromptEdits) => boolean): AtlasScope[] {
  return LEVELS.filter(l => has(all[l]))
}

export function levelsText(levels: readonly AtlasScope[]): string {
  return levels.map(l => LEVEL_NAME[l]).join('、')
}

/** One level's word for a section: 已关闭, 已改写 or 没改 (off wins over a rewrite). */
export function levelState(e: AtlasPromptEdits, id: string): '已关闭' | '已改写' | '没改' {
  return e.off.includes(id) ? '已关闭' : e.rewrite[id] !== undefined ? '已改写' : '没改'
}

/** `已关闭（本会话、全局） · 已改写（本项目）`: every level that edits the section; '' when none does. */
export function sectionLevelsText(all: Record<AtlasScope, AtlasPromptEdits>, id: string): string {
  const off = levelsWhere(all, e => e.off.includes(id))
  const rewritten = levelsWhere(all, e => e.rewrite[id] !== undefined)
  return [off.length ? `已关闭（${levelsText(off)}）` : '', rewritten.length ? `已改写（${levelsText(rewritten)}）` : ''].filter(Boolean).join(' · ')
}

export function setOff(e: AtlasPromptEdits, id: string, off: boolean): AtlasPromptEdits {
  return { ...e, off: off ? [...new Set([...e.off, id])] : e.off.filter(x => x !== id) }
}

/** `text` null takes the rewrite back. */
export function setRewrite(e: AtlasPromptEdits, id: string, text: string | null): AtlasPromptEdits {
  const rewrite = { ...e.rewrite }
  if (text === null) delete rewrite[id]
  else rewrite[id] = text
  return { ...e, rewrite }
}

export function putExtra(e: AtlasPromptEdits, extra: AtlasPromptExtra): AtlasPromptEdits {
  const has = e.extra.some(x => x.id === extra.id)
  return { ...e, extra: has ? e.extra.map(x => (x.id === extra.id ? extra : x)) : [...e.extra, extra] }
}

export function dropExtra(e: AtlasPromptEdits, id: string): AtlasPromptEdits {
  return { ...e, extra: e.extra.filter(x => x.id !== id) }
}

// ---------- 提示词: what the engine injects into the conversation ----------

export function injectOffOf(e: AtlasPromptEdits | undefined): string[] {
  return e?.injectOff ?? []
}

export function setInjectOff(e: AtlasPromptEdits, type: string, off: boolean): AtlasPromptEdits {
  const list = off ? [...new Set([...injectOffOf(e), type])] : injectOffOf(e).filter(x => x !== type)
  const next: AtlasPromptEdits = { ...e }
  if (list.length) next.injectOff = list
  else delete next.injectOff
  return next
}

/** Counts one injected message; a blocked one keeps the text it would have carried, for the page to show. */
export function recordInject(type: string, text: string | null, origin: string, nowMs: number, blocked = false): void {
  const seen = heldM.injects.get(type) ?? { count: 0, blocked: 0, chars: 0, lastText: '', origin, lastMs: 0 }
  if (blocked) seen.blocked++
  else {
    seen.count++
    seen.chars += text?.length ?? 0
  }
  if (text) seen.lastText = text.length > 60_000 ? text.slice(0, 60_000) : text
  seen.origin = origin
  seen.lastMs = nowMs
  heldM.injects.set(type, seen)
}

const INJECT_NAME: Record<string, string> = {
  environment: '环境信息',
  model: '模型说明',
  date: '当前日期',
  instructions: 'CLAUDE.md 和记忆文件',
  session_context: '会话上下文（邮箱等）',
  skill_listing: 'Skills 列表',
  agent_listing_delta: '子 agent 清单',
  deferred_tools_delta: '工具清单更新',
  mcp_instructions_delta: 'MCP 服务说明',
  remote_session_change: '提交署名说明',
  plan_mode: '计划模式说明',
  plan_mode_reentry: '回到计划模式',
  plan_mode_exit: '退出计划模式',
}

export function injectName(type: string): string {
  return INJECT_NAME[type] ?? type
}

/** What switching one kind off costs, where Atlas knows; '' otherwise. */
export function injectCaution(type: string): string {
  if (type === 'instructions') return 'CLAUDE.md 和记忆文件走的就是这一种。只想关其中几个文件的话，用「记忆」页的开关更合适；在这里关是整个不给。'
  if (type === 'skill_listing') return 'Skills 列表走的就是这一种。只想关个别 skill 的话，用「Skills」页的开关更合适；在这里关，模型就不知道有哪些 skill 了。'
  if (/tools|agent_listing|mcp_instructions/.test(type)) return '关掉后模型就不知道这些工具、子 agent 或 MCP 服务的存在，对应的功能会用不了。'
  if (type.startsWith('plan_mode')) return '这是计划模式的说明：关掉后模型不知道自己处在计划模式里。'
  return ''
}

export function injectLevelsText(all: Record<AtlasScope, AtlasPromptEdits>, type: string): string {
  const off = LEVELS.filter(l => injectOffOf(all[l]).includes(type))
  return off.length ? `已关闭（${off.map(l => LEVEL_NAME[l]).join('、')}）` : ''
}

// ---------- 提示词: the name that stands where the instructions say "the user" ----------

// "the user message", "the user settings": there "user" is no person, and the words stay
const NOT_A_PERSON = 'messages?|prompts?|turns?|role|input|settings|scope|tier|config|configuration|directory|folder|account|interface|type|memory|memories|id|email'
const THE_USER = new RegExp(`\\b[Tt]he user\\b(?![-\\w])(?! (?:${NOT_A_PERSON})\\b)`, 'g')

/** A name as it is kept and written: one line, trimmed, 40 characters at most. */
export function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, 40)
}

export function renameOf(e: AtlasPromptEdits | undefined): string {
  return cleanName(e?.rename ?? '')
}

/** An empty name takes the rule back. */
export function setRename(e: AtlasPromptEdits, name: string): AtlasPromptEdits {
  const clean = cleanName(name)
  const next: AtlasPromptEdits = { ...e }
  if (clean) next.rename = clean
  else delete next.rename
  return next
}

/**
 * The text with "the user" / "The user" written as `name`, and how many
 * places changed. "users", "user-facing" and "the user message" are left
 * alone; a possessive keeps its ending ("the user's" → "Robin's").
 */
export function renameUser(text: string, name: string): { text: string; count: number } {
  const clean = cleanName(name)
  if (!clean || !text) return { text, count: 0 }
  let count = 0
  const out = text.replace(THE_USER, () => {
    count++
    return clean
  })
  return { text: out, count }
}

/** `本会话：Robin · 全局：Robin`: the levels that name someone; '' when none does. */
export function renameLevelsText(all: Record<AtlasScope, AtlasPromptEdits>): string {
  return LEVELS.filter(l => renameOf(all[l]))
    .map(l => `${LEVEL_NAME[l]}：${renameOf(all[l])}`)
    .join(' · ')
}

export const EXTRA_PREFIX = 'atlas:'

/** An id for a new own section: `atlas:<name>`, numbered when taken. */
export function extraId(name: string, taken: readonly string[]): string {
  const slug = name.trim().toLowerCase().replace(/[\s:]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '') || 'section'
  let id = `${EXTRA_PREFIX}${slug}`
  for (let n = 2; taken.includes(id); n++) id = `${EXTRA_PREFIX}${slug}-${n}`
  return id
}

/**
 * What a `prompt.section` hook answers for one section: null to pass it on
 * unchanged, else the text to send (null inside: leave the section out).
 */
export function sectionAnswer(edits: AtlasPromptEdits, id: string, coreText: string | null): { text: string | null } | null {
  if (edits.off.includes(id)) return { text: null }
  const rw = edits.rewrite[id]
  // a section the engine leaves out stays out: a rewrite never brings one in
  if (rw !== undefined && coreText !== null) return { text: rw }
  return null
}

/** The composed list with the edits applied: off ones dropped, rewrites in place, own sections last. */
export function applyCompose<S extends SectionSeen>(edits: AtlasPromptEdits, sections: readonly S[]): (S | SectionSeen)[] {
  const out: (S | SectionSeen)[] = []
  for (const s of sections) {
    if (edits.off.includes(s.id)) continue
    const rw = edits.rewrite[s.id]
    out.push(rw !== undefined && rw !== s.text ? { ...s, text: rw } : s)
  }
  for (const x of edits.extra) {
    if (x.off || !x.text.trim()) continue
    const at = out.findIndex(s => s.id === x.id)
    const mine: SectionSeen = { id: x.id, text: x.text, scope: 'session' }
    if (at >= 0) out[at] = mine
    else out.push(mine)
  }
  return out
}

const SECTION_NAME: Record<string, string> = {
  intro: '开场和身份',
  system: '系统规则',
  doing_tasks: '怎么做任务',
  actions: '谨慎执行操作',
  tools: '怎么用工具',
  tone: '语气和格式',
  communication: '怎么说话',
  pronouns: '人称代词',
  session_guidance: '本会话的补充说明',
  memory: '记忆怎么用',
  env_info_simple: '环境信息',
  context_management: '上下文管理',
  act_dont_rederive: '该动手就动手',
  lean_body: '精简版正文',
  bare: '极简提示词',
}

/** A section's name in plain words; its id where Atlas has none for it. */
export function sectionName(id: string): string {
  return SECTION_NAME[id] ?? id
}

export type SectionState = 'on' | 'off' | 'rewritten'
export type SectionRow = {
  id: string
  scope: SectionScope | null
  state: SectionState
  /** The engine's own text, when the module has seen it. */
  original: string | null
  /** What is sent under `edits`: the rewrite, the original, or nothing when off. */
  sent: string | null
}

/**
 * The engine's sections for the list, under `edits`: the composed ones in
 * order, then the ones only known from their originals (off, so not composed).
 */
export function sectionRows(
  composed: readonly SectionSeen[],
  original: ReadonlyMap<string, string | null>,
  edits: AtlasPromptEdits,
  /** The session's own edits, which the composed texts already carry; `edits` when left out. */
  session: AtlasPromptEdits = edits,
): SectionRow[] {
  const rows: SectionRow[] = []
  const row = (id: string, scope: SectionScope | null, seenText: string | null) => {
    const known = original.get(id)
    // a composed text the session rewrote is the rewrite, not the engine's own
    const own = known ?? (session.rewrite[id] !== undefined ? null : seenText)
    const rw = edits.rewrite[id]
    const state: SectionState = edits.off.includes(id) ? 'off' : rw !== undefined ? 'rewritten' : 'on'
    rows.push({ id, scope, state, original: own, sent: state === 'off' ? null : state === 'rewritten' ? rw ?? null : own })
  }
  for (const s of composed) if (!s.id.startsWith(EXTRA_PREFIX)) row(s.id, s.scope, s.text)
  for (const [id, text] of original) {
    if (text === null || id.startsWith(EXTRA_PREFIX) || rows.some(r => r.id === id)) continue
    row(id, null, null)
  }
  for (const id of edits.off) if (!rows.some(r => r.id === id)) row(id, null, null)
  return rows
}

/** A rough token count: a CJK character about one, other text about four characters each. */
export function approxTokens(text: string): number {
  let cjk = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)) cjk++
  }
  return cjk + Math.ceil((text.length - cjk) / 4)
}

// ---------- 工具: where each tool waits, and what it tells the model ----------

/** Every deferred tool is reached through this one, so it is never deferred and never off. */
export const TOOL_SEARCH = 'ToolSearch'

/** Where the level puts the tool; undefined when it leaves that to the engine. A placement kept for ToolSearch is not read. */
export function toolPlaceOf(e: AtlasPromptEdits | undefined, tool: string): ToolPlace | undefined {
  if (tool === TOOL_SEARCH) return undefined
  const place = own(e?.toolPlace, tool)
  return isPlace(place) ? place : undefined
}

/** The description the level sends in place of the tool's own; undefined when it has none. */
export function toolRewriteOf(e: AtlasPromptEdits | undefined, tool: string): string | undefined {
  const text = own(e?.toolRewrite, tool)
  return isText(text) ? text : undefined
}

/** `place` null leaves the tool to the engine again. */
export function setToolPlace(e: AtlasPromptEdits, tool: string, place: ToolPlace | null): AtlasPromptEdits {
  const next: AtlasPromptEdits = { ...e }
  const rec = withKey(e.toolPlace, tool, tool === TOOL_SEARCH ? undefined : place ?? undefined)
  if (rec) next.toolPlace = rec
  else delete next.toolPlace
  return next
}

/** `text` null takes the rewrite back. */
export function setToolRewrite(e: AtlasPromptEdits, tool: string, text: string | null): AtlasPromptEdits {
  const next: AtlasPromptEdits = { ...e }
  const rec = withKey(e.toolRewrite, tool, text ?? undefined)
  if (rec) next.toolRewrite = rec
  else delete next.toolRewrite
  return next
}

/** Every tool the level names, placed or rewritten. */
export function toolNamesIn(e: AtlasPromptEdits | undefined): string[] {
  return [...new Set([...Object.keys(e?.toolPlace ?? {}), ...Object.keys(e?.toolRewrite ?? {})])]
}

/**
 * What a `tool.describe` hook answers for one tool under `edits`, from what
 * the layers beneath gave: the rewrite in place of the text, and the placement
 * where one is set (`pin` in the prompt's list; `defer` and `off` behind
 * ToolSearch). `base` itself when the edits do not touch the tool.
 */
export function toolAnswer<T extends { description: string; isDeferred?: boolean }>(edits: AtlasPromptEdits, tool: string, base: T): T {
  const rewrite = toolRewriteOf(edits, tool)
  const place = toolPlaceOf(edits, tool)
  if (rewrite === undefined && place === undefined) return base
  return { ...base, ...(rewrite === undefined ? {} : { description: rewrite }), ...(place === undefined ? {} : { isDeferred: place !== 'pin' }) }
}

/** What the model reads when it calls a tool that is switched off. */
export function toolOffDeny(tool: string): string {
  return `The tool ${tool} is switched off in Atlas, by the person's own setting. Do not call it again or look for a way around it. If the task needs this tool, say so and let them switch it back on.`
}

/** Keeps what the engine gave for one tool; answers whether that differs from what was held. */
export function recordTool(tool: string, text: string, isDeferred: boolean, provider: string, nowMs: number): boolean {
  const had = heldM.tools.get(tool)
  heldM.tools.set(tool, { text, isDeferred, provider, lastMs: nowMs })
  return !had || had.text !== text || had.isDeferred !== isDeferred || had.provider !== provider
}

/** `mcp__<server>__<tool>` taken apart; null for any other name. */
export function mcpParts(name: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m && m[1] && m[2] ? { server: m[1], tool: m[2] } : null
}

export type ToolKind = 'engine' | 'mcp' | 'plugin' | 'unknown'
/** Where a tool stands under a level's edits; `unknown` until the engine has described it. */
export type ToolWhere = 'carried' | 'deferred' | 'off' | 'unknown'

export type ToolRow = {
  /** As the model calls it. */
  name: string
  /** Without its server's prefix, for an MCP tool; else the name. */
  short: string
  kind: ToolKind
  /** The MCP server or the plugin it comes from; '' for the engine's own and for one whose maker is not known. */
  from: string
  /** The server its row folds under in the list, as its name spells it; '' for any tool that is no MCP server's. */
  server: string
  /** The engine's own placement: true behind ToolSearch; null until `tool.describe` has given it. */
  engineDeferred: boolean | null
  /** Where `edits` puts it; undefined when they leave it to the engine. */
  place: ToolPlace | undefined
  where: ToolWhere
  /** Its own description, when the module has seen it. */
  original: string | null
  rewrite: string | undefined
  /** What is sent under `edits`: the rewrite, else its own description. */
  sent: string | null
  /** `$.tool.list()` was asked and does not name it, and it was never described: no tool of this session. */
  isMissing: boolean
}

function rowOf(name: string, listed: ToolListed | undefined, isListKnown: boolean, seen: ToolSeen | undefined, edits: AtlasPromptEdits): ToolRow {
  const parts = mcpParts(name)
  const provider = seen?.provider ?? ''
  const kind: ToolKind = provider === 'engine' ? 'engine' : provider.startsWith('mcp:') ? 'mcp' : provider ? 'plugin' : listed?.mcp || parts ? 'mcp' : 'unknown'
  const from = kind === 'mcp' ? (provider.startsWith('mcp:') ? provider.slice(4) : parts?.server ?? '') : kind === 'plugin' ? provider : ''
  const server = kind === 'mcp' ? parts?.server ?? from : ''
  const engineDeferred = seen ? seen.isDeferred : null
  const place = toolPlaceOf(edits, name)
  const where: ToolWhere = place === 'off' ? 'off' : place === 'pin' ? 'carried' : place === 'defer' ? 'deferred' : engineDeferred === null ? 'unknown' : engineDeferred ? 'deferred' : 'carried'
  const original = seen ? seen.text : null
  const rewrite = toolRewriteOf(edits, name)
  return {
    name,
    short: kind === 'mcp' && parts ? parts.tool : name,
    kind,
    from,
    server,
    engineDeferred,
    place,
    where,
    original,
    rewrite,
    sent: rewrite ?? original,
    isMissing: isListKnown && !listed && !seen,
  }
}

/** One tool under `edits`, known to this session or not. */
export function toolRow(name: string, listed: readonly ToolListed[] | null, seen: ReadonlyMap<string, ToolSeen>, edits: AtlasPromptEdits): ToolRow {
  return rowOf(name, listed?.find(t => t.name === name), listed !== null, seen.get(name), edits)
}

/**
 * Every tool the page knows of, under `edits`: the ones the engine lists in
 * its order, then the ones only seen described, then the ones only a level
 * names (`edits`' own, and `also`: the other levels').
 */
export function toolRows(listed: readonly ToolListed[] | null, seen: ReadonlyMap<string, ToolSeen>, edits: AtlasPromptEdits, also: readonly string[] = []): ToolRow[] {
  const byName = new Map((listed ?? []).map(t => [t.name, t]))
  const names = new Set([...byName.keys(), ...seen.keys(), ...toolNamesIn(edits), ...also])
  return [...names].filter(Boolean).map(name => rowOf(name, byName.get(name), listed !== null, seen.get(name), edits))
}

/** Where a tool comes from, in the page's words; '' when that is not known yet. */
export function toolOrigin(x: Pick<ToolRow, 'kind' | 'from'>): string {
  if (x.kind === 'engine') return '引擎自带'
  if (x.kind === 'mcp') return x.from ? `MCP：${x.from}` : 'MCP'
  return x.kind === 'plugin' ? `插件：${x.from}` : ''
}

export type ToolMark = { what: 'off' | 'rewritten' | 'pin' | 'defer'; text: string }

/** What the levels do to a tool, each with the levels that do it: `已关闭（本会话、全局）`, `已改写（本项目）`, `固定（本会话）`. */
export function toolMarks(all: Record<AtlasScope, AtlasPromptEdits>, tool: string): ToolMark[] {
  const at = (has: (e: AtlasPromptEdits) => boolean) => levelsText(levelsWhere(all, has))
  const marks: [ToolMark['what'], string, string][] = [
    ['off', '已关闭', at(e => toolPlaceOf(e, tool) === 'off')],
    ['rewritten', '已改写', at(e => toolRewriteOf(e, tool) !== undefined)],
    ['pin', '固定', at(e => toolPlaceOf(e, tool) === 'pin')],
    ['defer', '改成用到再加载', at(e => toolPlaceOf(e, tool) === 'defer')],
  ]
  return marks.filter(m => m[2]).map(([what, word, levels]) => ({ what, text: `${word}（${levels}）` }))
}

/** `已关闭（本会话、全局） · 已改写（本项目）`: every level that touches the tool; '' when none does. */
export function toolLevelsText(all: Record<AtlasScope, AtlasPromptEdits>, tool: string): string {
  return toolMarks(all, tool)
    .map(m => m.text)
    .join(' · ')
}

/** One level's word for a tool: where it puts it, whether it rewrites it; 没改 when it does neither. */
export function toolLevelState(e: AtlasPromptEdits, tool: string): string {
  const place = toolPlaceOf(e, tool)
  const where = place === 'pin' ? '一直带着' : place === 'defer' ? '用到再加载' : place === 'off' ? '已关闭' : ''
  return [where, toolRewriteOf(e, tool) === undefined ? '' : '说明已改写'].filter(Boolean).join('，') || '没改'
}

// ---------- Hooks: the settings files ----------

export type HookSource = 'user' | 'project' | 'local'
export const SOURCE_NAME: Record<HookSource, string> = { user: '全局', project: '项目', local: '项目本地' }

export type HookFile = {
  source: HookSource
  path: string
  /** null: there is no such file, or (`unreadable`) it is there and could not be read. */
  text: string | null
  error: string | null
  unreadable: boolean
}

export type HookRow = {
  id: string
  isOn: boolean
  source: HookSource | null
  file: string
  event: string
  matcher: string
  /** `command`, `prompt`, `agent`, `http`, or whatever the file says. */
  type: string
  /** The command, the prompt or the URL. */
  body: string
  timeout: number | null
  /** Where it stands in its file: the matcher group, the place in the group; -1 when parked. */
  g: number
  i: number
  json: string
}

export type HookScan = { files: HookFile[]; rows: HookRow[] }

/** The classic hook events a settings file may name, the common ones first. */
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'Stop',
  'Notification',
  'PermissionRequest',
  'PermissionDenied',
  'SessionStart',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PostToolBatch',
  'StopFailure',
  'UserPromptExpansion',
  'InstructionsLoaded',
  'ConfigChange',
  'CwdChanged',
  'DirectoryAdded',
  'FileChanged',
  'TaskCreated',
  'TaskCompleted',
  'TeammateIdle',
  'PreModelSwitch',
  'PostModelSwitch',
  'MessageDisplay',
  'Elicitation',
  'ElicitationResult',
  'WorktreeCreate',
  'WorktreeRemove',
  'Setup',
] as const

/** The settings files that can hold hooks for this session, each path once. */
export function settingsFiles(ctx: Pick<AtlasCtx, 'claudeDir' | 'cwd'>): { source: HookSource; path: string }[] {
  const out: { source: HookSource; path: string }[] = []
  const add = (source: HookSource, path: string) => {
    if (path && !out.some(f => f.path === path)) out.push({ source, path })
  }
  if (ctx.claudeDir) add('user', `${ctx.claudeDir}/settings.json`)
  if (ctx.cwd) {
    add('project', `${ctx.cwd}/.claude/settings.json`)
    add('local', `${ctx.cwd}/.claude/settings.local.json`)
  }
  return out
}

export function rowId(source: HookSource, event: string, g: number, i: number): string {
  return `${source}:${event}:${g}:${i}`
}

export function bodyKey(hook: Record<string, unknown>): 'command' | 'prompt' | 'url' {
  if (typeof hook.command === 'string') return 'command'
  if (typeof hook.prompt === 'string') return 'prompt'
  if (typeof hook.url === 'string') return 'url'
  return hook.type === 'prompt' || hook.type === 'agent' ? 'prompt' : hook.type === 'http' ? 'url' : 'command'
}

function describe(hook: Record<string, unknown>): Pick<HookRow, 'type' | 'body' | 'timeout' | 'json'> {
  const body = hook[bodyKey(hook)]
  return {
    type: typeof hook.type === 'string' ? hook.type : 'command',
    body: typeof body === 'string' ? body : '',
    timeout: typeof hook.timeout === 'number' ? hook.timeout : null,
    json: JSON.stringify(hook),
  }
}

/** The hooks one settings file holds, in the file's order; `error` when it does not parse. */
export function parseHooks(file: { source: HookSource; path: string; text: string | null }): { rows: HookRow[]; error: string | null } {
  if (file.text === null || !file.text.trim()) return { rows: [], error: null }
  let doc: unknown
  try {
    doc = JSON.parse(file.text)
  } catch (err) {
    return { rows: [], error: `不是合法的 JSON：${err instanceof Error ? err.message : String(err)}` }
  }
  if (!isObj(doc)) return { rows: [], error: '最外层不是一个对象' }
  if (doc.hooks === undefined) return { rows: [], error: null }
  if (!isObj(doc.hooks)) return { rows: [], error: '"hooks" 不是一个对象' }
  const rows: HookRow[] = []
  for (const [event, groups] of Object.entries(doc.hooks)) {
    if (!Array.isArray(groups)) continue
    groups.forEach((group, g) => {
      if (!isObj(group) || !Array.isArray(group.hooks)) return
      const matcher = typeof group.matcher === 'string' ? group.matcher : ''
      group.hooks.forEach((hook, i) => {
        if (!isObj(hook)) return
        rows.push({ id: rowId(file.source, event, g, i), isOn: true, source: file.source, file: file.path, event, matcher, g, i, ...describe(hook) })
      })
    })
  }
  return { rows, error: null }
}

export function parkedOf(prefs: AtlasPrefs): AtlasParkedHook[] {
  return prefs.hooksOff ?? []
}

export function normalizeParked(raw: unknown): AtlasParkedHook[] {
  if (!Array.isArray(raw)) return []
  const out: AtlasParkedHook[] = []
  for (const x of raw) {
    if (!isObj(x) || typeof x.id !== 'string' || typeof x.file !== 'string' || typeof x.event !== 'string' || typeof x.json !== 'string') continue
    if (out.some(o => o.id === x.id)) continue
    out.push({ id: x.id, file: x.file, event: x.event, matcher: typeof x.matcher === 'string' ? x.matcher : '', json: x.json })
  }
  return out
}

export function parkedRow(p: AtlasParkedHook, files: readonly { source: HookSource; path: string }[]): HookRow {
  let hook: Record<string, unknown> = {}
  try {
    const v: unknown = JSON.parse(p.json)
    if (isObj(v)) hook = v
  } catch {
    // shown with an empty body
  }
  const source = files.find(f => f.path === p.file)?.source ?? null
  return { id: p.id, isOn: false, source, file: p.file, event: p.event, matcher: p.matcher, g: -1, i: -1, ...describe(hook), json: p.json }
}

export function scanHooks(
  files: readonly { source: HookSource; path: string; text: string | null; readError?: string | null }[],
  parked: readonly AtlasParkedHook[],
): HookScan {
  const outFiles: HookFile[] = []
  const rows: HookRow[] = []
  for (const f of files) {
    if (f.readError) {
      outFiles.push({ source: f.source, path: f.path, text: null, error: f.readError, unreadable: true })
      continue
    }
    const parsed = parseHooks(f)
    outFiles.push({ source: f.source, path: f.path, text: f.text, error: parsed.error, unreadable: false })
    rows.push(...parsed.rows)
  }
  for (const p of parked) rows.push(parkedRow(p, files))
  return { files: outFiles, rows }
}

export function parkedId(taken: readonly string[], nowMs: number): string {
  let id = `off:${nowMs.toString(36)}`
  for (let n = 2; taken.includes(id); n++) id = `off:${nowMs.toString(36)}-${n}`
  return id
}

// ---------- Hooks: rewriting a settings file ----------

type Group = { matcher?: unknown; hooks: unknown[] } & Record<string, unknown>

/** The matcher groups `removeAt` took the last hook out of, for `editSettings` to drop. */
const emptied = new WeakSet<object>()
export type HooksTable = Record<string, unknown>

function groupsOf(table: HooksTable, event: string): Group[] | null {
  const groups = table[event]
  return Array.isArray(groups) ? (groups as Group[]) : null
}

function isGroup(v: unknown): v is Group {
  return isObj(v) && Array.isArray(v.hooks)
}

/**
 * The settings text with its hooks table changed by `change`; everything
 * else in the file is kept as parsed, the hooks `change` leaves alone too. Throws when the file is not a settings
 * object: nothing is written over a file it cannot read.
 */
export function editSettings(text: string | null, change: (hooks: HooksTable) => void): string {
  let doc: unknown = {}
  if (text !== null && text.trim()) {
    try {
      doc = JSON.parse(text)
    } catch {
      throw new Error('这个 settings 文件不是合法的 JSON，先手动修好它')
    }
  }
  if (!isObj(doc)) throw new Error('这个 settings 文件最外层不是一个对象')
  if (doc.hooks !== undefined && !isObj(doc.hooks)) throw new Error('这个 settings 文件的 "hooks" 不是一个对象')
  const had = doc.hooks !== undefined
  const table: HooksTable = isObj(doc.hooks) ? doc.hooks : {}
  change(table)
  // the groups this change emptied go, and an event left with none; an empty one the file already had stays
  for (const [event, groups] of Object.entries(table)) {
    if (!Array.isArray(groups)) continue
    const kept = groups.filter(g => !(isGroup(g) && g.hooks.length === 0 && emptied.has(g)))
    if (kept.length === groups.length) continue
    if (kept.length === 0) delete table[event]
    else table[event] = kept
  }
  if (had || Object.keys(table).length > 0) doc.hooks = table
  return JSON.stringify(doc, null, 2) + '\n'
}

/** Takes the hook at a place out of the table; throws when another hook stands there now. */
export function removeAt(table: HooksTable, row: Pick<HookRow, 'event' | 'g' | 'i' | 'json'>): Record<string, unknown> {
  const group = groupsOf(table, row.event)?.[row.g]
  const hook = isGroup(group) ? group.hooks[row.i] : undefined
  if (!isGroup(group) || !isObj(hook) || JSON.stringify(hook) !== row.json) throw new Error('这个 hook 在文件里的位置变了，请重新读取后再试')
  group.hooks.splice(row.i, 1)
  // left in place, so the places of the hooks around it hold until the write
  if (group.hooks.length === 0) emptied.add(group)
  return hook
}

/** Adds a hook under its event, into the group with the same matcher or a new one; answers its place. */
export function addHook(table: HooksTable, event: string, matcher: string, hook: Record<string, unknown>): { g: number; i: number } {
  if (table[event] !== undefined && !Array.isArray(table[event])) throw new Error(`settings 里 "${event}" 的写法不对（不是一个列表），先手动修好它`)
  let groups = groupsOf(table, event)
  if (!groups) {
    groups = []
    table[event] = groups
  }
  const at = groups.findIndex(g => isGroup(g) && (typeof g.matcher === 'string' ? g.matcher : '') === matcher)
  const found = groups[at]
  if (at >= 0 && isGroup(found)) {
    found.hooks.push(hook)
    return { g: at, i: found.hooks.length - 1 }
  }
  groups.push(matcher ? { matcher, hooks: [hook] } : { hooks: [hook] })
  return { g: groups.length - 1, i: 0 }
}

export type HookPatch = { matcher?: string; body?: string; timeout?: string }

/** `timeout` as typed: seconds, or empty for none. Null when it is neither. */
export function parseTimeout(s: string): number | undefined | null {
  const t = s.trim()
  if (!t) return undefined
  if (!/^\d+(\.\d+)?$/.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Changes the hook at a place; a new matcher moves it to that matcher's group. Answers its place after. */
export function updateAt(table: HooksTable, row: Pick<HookRow, 'event' | 'g' | 'i' | 'json' | 'matcher'>, patch: HookPatch): { g: number; i: number } {
  const group = groupsOf(table, row.event)?.[row.g]
  const hook = isGroup(group) ? group.hooks[row.i] : undefined
  if (!isGroup(group) || !isObj(hook) || JSON.stringify(hook) !== row.json) throw new Error('这个 hook 在文件里的位置变了，请重新读取后再试')
  if (patch.body !== undefined) {
    if (!patch.body.trim()) throw new Error('内容不能为空；不想要这个 hook 就关闭或删除它')
    hook[bodyKey(hook)] = patch.body
  }
  if (patch.timeout !== undefined) {
    const t = parseTimeout(patch.timeout)
    if (t === null) throw new Error('timeout 要填一个正数（秒），或者留空')
    if (t === undefined) delete hook.timeout
    else hook.timeout = t
  }
  if (patch.matcher === undefined || patch.matcher === row.matcher) return { g: row.g, i: row.i }
  if (group.hooks.length === 1) {
    if (patch.matcher) group.matcher = patch.matcher
    else delete group.matcher
    return { g: row.g, i: row.i }
  }
  group.hooks.splice(row.i, 1)
  return addHook(table, row.event, patch.matcher, hook)
}

export function draftHook(d: AtlasHookDraft): Record<string, unknown> {
  if (!d.event.trim()) throw new Error('先选一个事件')
  if (!d.command.trim()) throw new Error('command 不能为空')
  const t = parseTimeout(d.timeout)
  if (t === null) throw new Error('timeout 要填一个正数（秒），或者留空')
  return t === undefined ? { type: 'command', command: d.command } : { type: 'command', command: d.command, timeout: t }
}

/** The first script file a hook's command names, as an absolute path; null when it names none. */
export function scriptPath(command: string, home: string, cwd: string): string | null {
  // the variables a hook command spells its paths with, quoted or bare, and a leading ~
  const flat = command
    .replace(/"\$\{?CLAUDE_PROJECT_DIR\}?"|\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR\b/g, cwd)
    .replace(/"\$\{?HOME\}?"|\$\{HOME\}|\$HOME\b/g, home)
    .replace(/(^|[\s"'=])~(?=\/)/g, (_, lead: string) => lead + home)
  const m = /(?:^|[\s"'=])(\/[^\s"';|&<>]*\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|php))(?=$|[\s"';|&<>])/.exec(flat)
  return m && m[1] ? m[1] : null
}

export function firesText(event: string): string {
  const f = heldM.fires.get(event)
  return f ? `本会话触发 ${f.count} 次` : ''
}
