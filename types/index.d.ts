// atlas: the values it keeps in $.state (small; the big index lives in the
// hooks module and is re-read after a reload).

export type AtlasTab = 'memory' | 'sessions' | 'skills' | 'prompt' | 'tools' | 'hooks' | 'structure' | 'health' | 'trash'

export type AtlasRoute =
  | { kind: 'project'; slug: string; from?: string }
  | { kind: 'custom'; name: string; from?: string }
  | { kind: 'file'; path: string; from?: string; line?: number }
  /** By the transcript's path: a renamed project keeps copies under the same id. */
  | { kind: 'session'; path: string; from?: string }
  | { kind: 'skill'; name: string; from?: string }
  /** One section of the system prompt, by its id (an own section's starts `atlas:`). */
  | { kind: 'section'; id: string; from?: string }
  /** One settings hook, by its row id (a parked one's starts `off:`). */
  | { kind: 'hook'; id: string; from?: string }
  | { kind: 'hooknew'; from?: string }
  /** One kind of message the engine injects into the conversation (a system reminder), by its type. */
  | { kind: 'inject'; type: string; from?: string }
  /** One tool the model is given, by the name the model calls it. */
  | { kind: 'tool'; name: string; from?: string }
  /** The tools of one MCP server, by the server's name as the tools' names spell it. */
  | { kind: 'toolserver'; server: string; from?: string }

/** Which store a drag on the switch boards writes. */
export type AtlasScope = 'session' | 'project' | 'global'

export type AtlasView = {
  tab: AtlasTab
  stack: AtlasRoute[]
  /** How many rows a long list shows, by list name. */
  limits: Record<string, number>
  showSkillNames: boolean
  memoryMode: 'overview' | 'sort'
  skillsMode: 'board' | 'list'
  /** Group ids the 记忆整理 board shows; null = the default pick. */
  sortColumns: string[] | null
  /** Page of each board, by board id. */
  boardPage: Record<string, number>
  scope: AtlasScope
  /** 结构: the project whose tree shows (null: this session's), the view. */
  treeSlug: string | null
  /** Node ids whose open state differs from their default (roots open, the rest closed). */
  treeToggled: string[]
  structureMode: 'tree' | 'cross'
  showArchived: boolean
  /** Keep period for the next 删除, in days ("1" | "7" | "30" | "90"); '' = the option's default. */
  trashDays: string
  /** The control waiting for its second press (删除 → 确认删除, 立即清空 → 确认永久删除). */
  pending: string | null
  /** The hook being written on the 新 hook page; absent or null when none is. */
  hookDraft?: AtlasHookDraft | null
  /** The 手帐 illustration over each page is folded away; absent = shown. */
  journalOff?: boolean
}

/** A section the person added to the system prompt themselves. */
export type AtlasPromptExtra = { id: string; name: string; text: string; off: boolean }

/** The edits to the system prompt at one level: this session, a project's default, the global default. */
export type AtlasPromptEdits = {
  /** Ids of the engine's sections left out. */
  off: string[]
  /** Engine section id → the text sent in its place. */
  rewrite: Record<string, string>
  extra: AtlasPromptExtra[]
  /** Kinds of injected message (system reminder) left out; absent = none. */
  injectOff?: string[]
  /** The name written wherever the instructions say "the user"; absent = they are left as they are. */
  rename?: string
  /**
   * Where a tool waits, by the name the model calls it: `pin` in the prompt's
   * list, `defer` behind ToolSearch, `off` behind it with every call refused.
   * A tool not named here stays where the engine puts it; absent = none is named.
   */
  toolPlace?: Record<string, 'pin' | 'defer' | 'off'>
  /** Tool name → the description sent in place of its own; absent = none. */
  toolRewrite?: Record<string, string>
}

/** A settings hook switched off: taken out of its settings file and kept here until switched on. */
export type AtlasParkedHook = {
  id: string
  /** The settings file it came from, and goes back to. */
  file: string
  event: string
  matcher: string
  /** The hook object as it stood in the file, as JSON text. */
  json: string
}

export type AtlasHookDraft = { file: string; event: string; matcher: string; command: string; timeout: string }

export type AtlasLoad = { status: 'idle' | 'loading' | 'ready' | 'error'; error: string | null; atMs: number }

/** The 提示词, 工具 and Hooks pages' load states (what they show lives in the module). */
export type AtlasManage = {
  prompt: AtlasLoad
  hooks: AtlasLoad
  /** What the last settings write can be undone to; null when nothing can. */
  hooksUndo: string | null
  /** The 工具 page's; absent on a value an earlier version stored (then: not read yet). */
  tools?: AtlasLoad
}

export type AtlasScan = {
  status: 'idle' | 'scanning' | 'done' | 'error'
  /** Goes up by one whenever the module's index is replaced. */
  dataVersion: number
  error: string | null
  generatedAtMs: number
  elapsedMs: number
  /** Minutes east of UTC, from `date +%z`; null until read. */
  tzOffsetMin: number | null
}

export type AtlasSearchHit = {
  path: string
  projectSlug: string | null
  scope: string
  line: number
  text: string
}

export type AtlasSearch = {
  status: 'idle' | 'searching' | 'done' | 'error'
  query: string
  error: string | null
  results: AtlasSearchHit[]
}

export type AtlasFmDraft = { name: string; description: string; type: string }

export type AtlasFile = {
  path: string
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** The text as last read from disk ('' for a file not yet made). */
  text: string
  isNew: boolean
  error: string | null
  size: number
  mtimeMs: number
  mode: 'read' | 'edit'
  /** The body line the editor's page should hold (pages follow the pane's rows). */
  anchor: number
  /** The disk changed under the editor: writes are refused until a reload. */
  stale: boolean
  note: string | null
  /** Frontmatter fields being written to a file that has none. */
  fmDraft: AtlasFmDraft | null
}

export type AtlasMemoryState = 'mount' | 'read' | 'off'

export type AtlasSwitches = {
  skillsOff: string[]
  /** The folder of each switched-off skill (from its SKILL.md path). */
  skillDirs: Record<string, string>
  /** Explicit memory-group states for this session; absent = default. */
  memory: Record<string, AtlasMemoryState>
  /** Instruction files this session loaded, by path: absent = loaded. */
  files: Record<string, 'read' | 'off'>
  /** This session's edits to the system prompt; absent = none (a value an earlier version stored). */
  prompt?: AtlasPromptEdits
  /** Send a changed section at the next turn, rebuilding the prompt cache, instead of waiting for a new thread. */
  promptNow?: boolean
}

export type AtlasLoadedFile = { path: string; kind: string; parent?: string; chars: number }

export type AtlasLoaded = {
  files: AtlasLoadedFile[]
  recordedAtMs: number
  added: string[]
  removed: string[]
  skipped: { path: string; reason: string }[]
}

export type AtlasCtx = {
  seeded: boolean
  /** This session's id: never offered for deletion, passed as --protect-session. */
  sessionId: string
  cwd: string
  home: string
  claudeDir: string
  /** This session runs on Windows; absent on a value an earlier version stored (then: not). Paths are kept with forward slashes there too. */
  win?: boolean
}

export type AtlasGroup = { id: string; name: string; paths: string[] }

export type AtlasPrefs = {
  skillsOff: { global: string[]; byProject: Record<string, string[]> }
  skillDirs: Record<string, string>
  memory: {
    defaults: {
      global: Record<string, AtlasMemoryState>
      byProject: Record<string, Record<string, AtlasMemoryState>>
    }
  }
  groups: AtlasGroup[]
  /** Hidden from the default lists; the files are untouched. */
  /** Sessions by transcript path, projects by slug. */
  archived: { sessions: string[]; projects: string[] }
  /** Default edits to the system prompt; absent = none. */
  prompt?: { global: AtlasPromptEdits; byProject: Record<string, AtlasPromptEdits> }
  /** Settings hooks switched off; absent = none. */
  hooksOff?: AtlasParkedHook[]
  /** The skin the desktop pane wears on this machine, by its id; absent = the first one (手帐). */
  skin?: string
  /** How long a deleted thing is kept on this machine, picked on the 回收站 page: days, or `never`; absent = the plugin's option. */
  trashDays?: string
}

export type AtlasTrashItem = {
  id: string
  originalPath: string
  kind: string
  label: string
  deletedAtMs: number
  /** When it is emptied by itself; 0 for one kept until it is emptied by hand. */
  expiresAtMs: number
  sizeBytes: number
  exists: boolean
}

export type AtlasTrash = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  items: AtlasTrashItem[]
  bytes: number
  error: string | null
}

export type AtlasMerge = {
  status: 'idle' | 'running' | 'ready' | 'error'
  source: string
  target: string
  base: string
  sourceBase: string
  proposal: string
  diff: string
  error: string | null
}

/** The last move / merge / reorder / fix, for its 撤销 line. */
export type AtlasOp = { id: number; label: string; canUndo: boolean; error: string | null }

export type AtlasExtra = {
  claudeMds: { slug: string; items: { path: string; exists: boolean }[] } | null
  skillFiles: {
    name: string
    status: 'loading' | 'ready' | 'error'
    files: { rel: string; path: string; size: number }[]
    error: string | null
  } | null
}

declare module 'claude-code' {
  interface PluginState {
    atlas: {
      scan: AtlasScan
      view: AtlasView
      search: AtlasSearch
      file: AtlasFile
      ctx: AtlasCtx
      switches: AtlasSwitches
      prefs: AtlasPrefs
      loaded: AtlasLoaded
      merge: AtlasMerge
      op: AtlasOp
      extra: AtlasExtra
      trash: AtlasTrash
      manage: AtlasManage
      /** Bumped when module-held data (undo texts) changes, to redraw. */
      tick: number
    }
  }
}
