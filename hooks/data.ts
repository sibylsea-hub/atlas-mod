// Types for the JSON that bin/atlas.py prints (docs/contract.md is the source).

export type Load = { path: string; type: string }

export type MemoryFile = {
  name: string
  path: string
  size: number
  mtimeMs: number
  hasFrontmatter: boolean
  title: string
  description: string
  type: string | null
  linked: boolean
}

export type MemoryIndex = {
  exists: boolean
  path: string
  lines: number
  bytes: number
  overLineLimit: boolean
  overByteLimit: boolean
  links: string[]
  deadLinks: string[]
  orphans: string[]
}

export type PathSeen = {
  path: string
  firstSeenMs: number | null
  lastSeenMs: number | null
  exists: boolean
  source: 'cwd' | 'relocated' | 'slug-match'
  launch: boolean
}

export type IoDir = {
  dir: string
  count: number
  lastMs: number
  class: 'claude' | 'project' | 'scratch' | 'external'
  via: 'tool' | 'bash'
}

export type Io = { writes: IoDir[]; reads: IoDir[] }

export type Project = {
  slug: string
  cwd: string | null
  label: string
  kind: 'project' | 'scratch' | 'tmp'
  /** v2 fields; absent from a v1 index. */
  pathHistory?: PathSeen[]
  resolvedCwd?: string | null
  resolution?: 'exists' | 'relocated' | 'slug-match' | 'related' | 'missing'
  relatedSlugs?: string[]
  io?: Io
  diskBytes?: number
  isCurrent: boolean
  sessionCount: number
  lastActiveMs: number
  memoryDir: string | null
  memoryFiles: MemoryFile[]
  index: MemoryIndex | null
  loads: Load[]
}

export type CustomMemory = {
  name: string
  path: string
  files: MemoryFile[]
  index: null
}

export type SkillUse = {
  name: string
  count: number
  via: 'tool' | 'command'
  inSubagent: boolean
}

export type Session = {
  id: string
  projectSlug: string
  path: string
  cwd: string | null
  title: string
  startedMs: number
  lastMs: number
  entrypoint: string | null
  version: string | null
  loads: Load[]
  skillsAvailable: string[]
  skillsInvoked: SkillUse[]
  memoryReads: string[]
  memoryWrites: string[]
  subagentCount: number
  io?: Io
  diskBytes?: number
}

export type SkillSource = 'user' | 'synced' | 'plugin' | 'project' | 'builtin'

export type Skill = {
  name: string
  source: SkillSource
  path: string | null
  description: string | null
  plugin: string | null
  projectCwd: string | null
  useCount: number
  sessionsUsing: number
  lastUsedMs: number | null
  listedIn: number
}

export type Severity = 'error' | 'warn' | 'info'

export type Issue = {
  severity: Severity
  kind: string
  projectSlug: string | null
  path: string
  message: string
}

export type DocNode = {
  id: string
  path: string
  kind: 'claude-md' | 'memory-index' | 'memory' | 'custom-memory' | 'skill' | 'doc'
  scope: 'global' | 'project' | 'shared-memory' | 'memory-archive' | 'external'
  projectSlug: string | null
  exists: boolean
  isSymlink: boolean
  realPath: string
  title: string
}

export type DocEdgeType = 'import' | 'link' | 'index' | 'wikilink' | 'nested' | 'symlink'

export type DocEdge = { from: string; to: string; type: DocEdgeType }

export type Docs = { nodes: DocNode[]; edges: DocEdge[]; truncated: boolean }

export type CrossEdge = { from: string; to: string; kind: string; count: number }

export type ScratchWorkspace = { path: string; sizeBytes: number; mtimeMs: number; projectSlug: string | null; sessionIds: string[] }

export type TrashMeta = {
  id: string
  originalPath: string
  kind: string
  pathClass: string
  label: string
  deletedAtMs: number
  expiresAtMs: number
  sizeBytes: number
  exists?: boolean
}

export type AtlasIndex = {
  version: number
  generatedAtMs: number
  elapsedMs: number
  claudeDir: string
  home: string
  warnings: string[]
  globalClaudeMd: { path: string; exists: boolean; lines: number; bytes: number }
  projects: Project[]
  customMemory: CustomMemory[]
  sessions: Session[]
  skills: Skill[]
  health: Issue[]
  /** v2 fields; absent from a v1 index. */
  docs?: Docs
  crossProject?: CrossEdge[]
  scratchWorkspaces?: ScratchWorkspace[]
  trash?: { path: string; items: number; bytes: number }
}

export type SearchHit = {
  path: string
  projectSlug: string | null
  scope: 'project' | 'custom' | 'global'
  line: number
  text: string
}

export type SearchOutput = { query: string; results: SearchHit[] }

/** What the indexer is checked for before the pane trusts it. */
export function isIndex(value: unknown): value is AtlasIndex {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return Array.isArray(v.projects) && Array.isArray(v.sessions) && Array.isArray(v.skills) && Array.isArray(v.health)
}
