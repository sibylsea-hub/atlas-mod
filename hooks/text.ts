// Pure helpers: widths, times, paths, line edits, frontmatter, MEMORY.md
// index lines, the skill listing filter and a line diff. No `$` here.

// ---------- widths ----------

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

/** Terminal cells a string takes (CJK and emoji count two). */
export function cellWidth(s: string): number {
  let w = 0
  for (const ch of s) w += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
  return w
}

/** Cuts `s` to at most `cols` cells, ending with … when cut. */
export function fit(s: string, cols: number): string {
  const flat = s.replace(/[\r\n\t]+/g, ' ')
  if (cols <= 0) return ''
  if (cellWidth(flat) <= cols) return flat
  let out = ''
  let w = 0
  for (const ch of flat) {
    const cw = isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
    if (w + cw > cols - 1) break
    out += ch
    w += cw
  }
  return out + '…'
}

// ---------- times ----------

const pad = (n: number) => String(n).padStart(2, '0')

function shifted(ms: number, tzMin: number): Date {
  return new Date(ms + tzMin * 60_000)
}

export function fmtMD(ms: number, tzMin: number): string {
  if (!ms) return '--'
  const d = shifted(ms, tzMin)
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

export function fmtHM(ms: number, tzMin: number): string {
  if (!ms) return '--:--'
  const d = shifted(ms, tzMin)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

export function fmtMDHM(ms: number, tzMin: number): string {
  return `${fmtMD(ms, tzMin)} ${fmtHM(ms, tzMin)}`
}

/** `+0800` → 480; null when it does not parse. */
export function parseTzOffset(s: string): number | null {
  const m = /^([+-])(\d\d)(\d\d)$/.exec(s.trim())
  if (!m) return null
  const sign = m[1] === '-' ? -1 : 1
  return sign * (Number(m[2]) * 60 + Number(m[3]))
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// ---------- paths ----------

/**
 * A path as atlas keeps it: forward slashes only. Windows takes them, so one
 * way of splitting and comparing holds on every system.
 */
export function slashes(p: string): string {
  return p.replace(/\\/g, '/')
}

/** `C:/…`: a path on a Windows drive, which compares without regard to case. */
const DRIVE = /^[A-Za-z]:(\/|$)/

export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || DRIVE.test(p)
}

export function shortPath(p: string, home: string): string {
  if (home && isInside(p, home)) return '~' + p.slice(home.length)
  return p
}

export function basename(p: string): string {
  const i = p.replace(/\/+$/, '').lastIndexOf('/')
  return i < 0 ? p : p.slice(i + 1)
}

export function dirname(p: string): string {
  const s = p.replace(/\/+$/, '')
  const i = s.lastIndexOf('/')
  if (i <= 0) return /^[A-Za-z]:$/.test(s) ? s + '/' : '/'
  const dir = s.slice(0, i)
  // a drive's own folder keeps its slash: `C:/x` is in `C:/`
  return /^[A-Za-z]:$/.test(dir) ? dir + '/' : dir
}

/** Absolute, `~` expanded, `.` and `..` folded; no links resolved. */
export function normalizePath(p: string, cwd: string, home: string): string {
  let s = slashes(p.trim())
  if (s === '~') s = home
  else if (s.startsWith('~/')) s = home + s.slice(1)
  if (!isAbsolutePath(s)) s = (cwd.endsWith('/') ? cwd : cwd + '/') + s
  const drive = DRIVE.test(s) ? s.slice(0, 2) : ''
  const out: string[] = []
  for (const part of (drive ? s.slice(2) : s).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return drive + '/' + out.join('/')
}

export function isInside(p: string, root: string): boolean {
  const r = root.replace(/\/+$/, '')
  if (DRIVE.test(p) || DRIVE.test(r)) {
    const a = p.toLowerCase()
    const b = r.toLowerCase()
    return a === b || a.startsWith(b + '/')
  }
  return p === r || p.startsWith(r + '/')
}

/** The folder name Claude Code keeps a project's transcripts under. */
export function slugify(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

// ---------- lines ----------

export type Line = { text: string; eol: string }

/**
 * The lines of a text as an editor shows them: each with its own ending, the
 * empty piece after a final newline left out, so `join(split(s)) === s`.
 */
export function splitLines(s: string): Line[] {
  const out: Line[] = []
  let i = 0
  for (;;) {
    const j = s.indexOf('\n', i)
    if (j === -1) {
      out.push({ text: s.slice(i), eol: '' })
      break
    }
    const cr = j > i && s[j - 1] === '\r'
    out.push({ text: s.slice(i, cr ? j - 1 : j), eol: cr ? '\r\n' : '\n' })
    i = j + 1
  }
  const last = out[out.length - 1]
  if (out.length > 1 && last && last.text === '' && last.eol === '') out.pop()
  return out
}

export function joinLines(lines: readonly Line[]): string {
  return lines.map(l => l.text + l.eol).join('')
}

export function dominantEol(lines: readonly Line[]): string {
  let crlf = 0
  let lf = 0
  for (const l of lines) {
    if (l.eol === '\r\n') crlf++
    else if (l.eol === '\n') lf++
  }
  return crlf > lf ? '\r\n' : '\n'
}

export function replaceLine(s: string, index: number, text: string): string {
  const lines = splitLines(s)
  const line = lines[index]
  if (!line) return s
  lines[index] = { text: text.replace(/[\r\n]+/g, ' '), eol: line.eol }
  return joinLines(lines)
}

export function insertLineAfter(s: string, index: number, text = ''): string {
  const lines = splitLines(s)
  const line = lines[index]
  if (!line) return s
  if (line.eol === '') {
    lines[index] = { text: line.text, eol: dominantEol(lines) }
    lines.splice(index + 1, 0, { text, eol: '' })
  } else {
    lines.splice(index + 1, 0, { text, eol: line.eol })
  }
  return joinLines(lines)
}

export function deleteLine(s: string, index: number): string {
  const lines = splitLines(s)
  const line = lines[index]
  if (!line) return s
  lines.splice(index, 1)
  if (lines.length === 0) return ''
  const prev = lines[index - 1]
  if (line.eol === '' && index === lines.length && prev) lines[index - 1] = { text: prev.text, eol: '' }
  return joinLines(lines)
}

// ---------- frontmatter ----------

export type FmField = { line: number; key: string; indent: string; raw: string; value: string }

export type Frontmatter = {
  /** Index of the closing `---` line. */
  end: number
  name: FmField | null
  description: FmField | null
  /** `metadata.type` when present, else top-level `type`. */
  type: FmField | null
  metadataLine: number | null
}

export function unquote(raw: string): string {
  const v = raw.trim()
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string
    } catch {
      return v.slice(1, -1)
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
  return v
}

export function parseFrontmatter(s: string): Frontmatter | null {
  const lines = splitLines(s)
  if (lines[0]?.text.trimEnd() !== '---') return null
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i]?.text.trimEnd()
    if (t === '---' || t === '...') {
      end = i
      break
    }
  }
  if (end < 0) return null
  const fm: Frontmatter = { end, name: null, description: null, type: null, metadataLine: null }
  let inMeta = false
  let topType: FmField | null = null
  let metaType: FmField | null = null
  for (let i = 1; i < end; i++) {
    const text = lines[i]?.text ?? ''
    const top = /^([A-Za-z_][\w.-]*):(.*)$/.exec(text)
    if (top) {
      const key = top[1] ?? ''
      const raw = top[2] ?? ''
      inMeta = key === 'metadata' && raw.trim() === ''
      if (inMeta) fm.metadataLine = i
      const field = { line: i, key, indent: '', raw, value: unquote(raw) }
      if (key === 'name') fm.name = field
      else if (key === 'description') fm.description = field
      else if (key === 'type') topType = field
      continue
    }
    const nested = /^(\s+)([A-Za-z_][\w.-]*):(.*)$/.exec(text)
    if (nested && inMeta && nested[2] === 'type') {
      metaType = { line: i, key: 'type', indent: nested[1] ?? '  ', raw: nested[3] ?? '', value: unquote(nested[3] ?? '') }
    }
  }
  fm.type = metaType ?? topType
  return fm
}

const NEEDS_QUOTE = /^[\s#\-[\]{}&*!|>'"%@`,?:]|\s$|: | #/

function formatValue(value: string, raw: string): string {
  const t = raw.trim()
  if (t.startsWith('"')) return JSON.stringify(value)
  if (t.startsWith("'")) return `'${value.replace(/'/g, "''")}'`
  if (value === '' || NEEDS_QUOTE.test(value)) return JSON.stringify(value)
  return value
}

/** Sets one frontmatter field, every other byte as it was. */
export function setFrontmatterField(s: string, key: 'name' | 'description' | 'type', value: string): string {
  const fm = parseFrontmatter(s)
  if (!fm) return s
  const lines = splitLines(s)
  const field = fm[key]
  const clean = value.replace(/[\r\n]+/g, ' ')
  if (field) {
    const line = lines[field.line]
    if (!line) return s
    const lead = field.raw.match(/^\s*/)?.[0] ?? ' '
    lines[field.line] = { text: `${field.indent}${field.key}:${lead || ' '}${formatValue(clean, field.raw)}`, eol: line.eol }
    return joinLines(lines)
  }
  const eol = lines[fm.end - 1]?.eol || dominantEol(lines)
  if (key === 'type') {
    if (fm.metadataLine !== null) {
      lines.splice(fm.metadataLine + 1, 0, { text: `  type: ${formatValue(clean, '')}`, eol })
    } else {
      lines.splice(fm.end, 0, { text: 'metadata:', eol }, { text: `  type: ${formatValue(clean, '')}`, eol })
    }
  } else {
    lines.splice(fm.end, 0, { text: `${key}: ${formatValue(clean, '')}`, eol })
  }
  return joinLines(lines)
}

/** Puts a frontmatter block in front of a file that has none; the rest untouched. */
export function addFrontmatter(s: string, draft: { name: string; description: string; type: string }): string {
  const eol = dominantEol(splitLines(s))
  const rows = ['---', `name: ${formatValue(draft.name, '')}`, `description: ${formatValue(draft.description, '')}`]
  if (draft.type) rows.push('metadata:', `  type: ${formatValue(draft.type, '')}`)
  rows.push('---')
  const head = rows.join(eol) + eol
  return s === '' ? head : head + (s.startsWith('\n') || s.startsWith('\r\n') ? '' : eol) + s
}

/** The first non-empty body line, for a description guess. */
export function firstBodyLine(s: string): string {
  const fm = parseFrontmatter(s)
  const lines = splitLines(s)
  for (let i = fm ? fm.end + 1 : 0; i < lines.length; i++) {
    const t = (lines[i]?.text ?? '').replace(/^#+\s*/, '').trim()
    if (t) return t.slice(0, 200)
  }
  return ''
}

/** Markdown for reading: the frontmatter as a yaml block, the body as is. */
export function readableMarkdown(s: string): string {
  const fm = parseFrontmatter(s)
  if (!fm) return s
  const lines = splitLines(s)
  const head = lines.slice(0, fm.end + 1).map(l => l.text).join('\n')
  const body = joinLines(lines.slice(fm.end + 1))
  return '```yaml\n' + head + '\n```\n\n' + body
}

// ---------- MEMORY.md index lines ----------

const LINK = /\]\(([^)\s]+?)\)/g

export function linkTargets(line: string): string[] {
  const out: string[] = []
  for (const m of line.matchAll(LINK)) {
    const t = (m[1] ?? '').replace(/^\.\//, '')
    if (t.endsWith('.md')) out.push(t)
  }
  return out
}

export function indexLine(file: string, title: string, description: string): string {
  const desc = description.replace(/[\r\n]+/g, ' ').trim()
  return `- [${title.replace(/[\r\n\]]+/g, ' ').trim() || file}](${file})${desc ? ` — ${desc}` : ''}`
}

export function appendLine(s: string, line: string): string {
  if (s === '') return line + '\n'
  const lines = splitLines(s)
  const eol = dominantEol(lines)
  return /\r?\n$/.test(s) ? s + line + eol : s + eol + line
}

/** Drops the lines that link `file`; every other line byte-identical. */
export function removeIndexLinks(s: string, file: string): string {
  const lines = splitLines(s)
  let out = s
  for (let i = lines.length - 1; i >= 0; i--) {
    if (linkTargets(lines[i]?.text ?? '').includes(file)) out = deleteLine(out, i)
  }
  return out
}

/**
 * Puts the link lines of `order` (file names) into that order, in the slots
 * the link lines already hold; every other line stays where and as it was.
 */
export function reorderIndexLinks(s: string, order: readonly string[]): string {
  const lines = splitLines(s)
  const slots: number[] = []
  const byFile = new Map<string, string>()
  const slotFiles: string[] = []
  lines.forEach((l, i) => {
    const target = linkTargets(l.text)[0]
    if (target !== undefined && !byFile.has(target)) {
      slots.push(i)
      byFile.set(target, l.text)
      slotFiles.push(target)
    }
  })
  const wanted = order.filter(f => byFile.has(f))
  const rest = slotFiles.filter(f => !wanted.includes(f))
  const next = [...wanted, ...rest]
  slots.forEach((slot, k) => {
    const line = lines[slot]
    const file = next[k]
    if (line && file !== undefined) lines[slot] = { text: byFile.get(file) ?? line.text, eol: line.eol }
  })
  return joinLines(lines)
}

export function generateIndex(files: readonly { name: string; title: string; description: string }[]): string {
  return files.map(f => indexLine(f.name, f.title, f.description)).join('\n') + (files.length ? '\n' : '')
}

// ---------- the skill listing ----------

function entryName(line: string): string {
  const rest = line.slice(2)
  const i = rest.indexOf(': ')
  return (i >= 0 ? rest.slice(0, i) : rest.replace(/:\s*$/, '')).trim()
}

/**
 * Drops the `- <name>: ...` entries of `off` from a skill listing. An entry
 * runs to the next line that begins `- ` (or a blank line); every other byte
 * stays as it was.
 */
export function filterSkillListing(text: string, off: ReadonlySet<string>): string {
  if (off.size === 0) return text
  let out = ''
  let skipping = false
  let i = 0
  while (i < text.length) {
    const j = text.indexOf('\n', i)
    const piece = j === -1 ? text.slice(i) : text.slice(i, j + 1)
    const line = piece.replace(/\r?\n$/, '')
    if (line.startsWith('- ')) skipping = off.has(entryName(line))
    else if (line.trim() === '') skipping = false
    if (!skipping) out += piece
    i += piece.length
  }
  return out
}

// ---------- diff ----------

/** A unified diff of two texts by lines, three lines of context. */
export function lineDiff(a: string, b: string, context = 3): string {
  const x = a === '' ? [] : splitLines(a).map(l => l.text)
  const y = b === '' ? [] : splitLines(b).map(l => l.text)
  const n = x.length
  const m = y.length
  type Op = { t: ' ' | '-' | '+'; s: string; ai: number; bi: number }
  const ops: Op[] = []
  if (n * m > 4_000_000) {
    x.forEach((s, i) => ops.push({ t: '-', s, ai: i, bi: 0 }))
    y.forEach((s, i) => ops.push({ t: '+', s, ai: n, bi: i }))
  } else {
    const w = m + 1
    const dp = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = x[i] === y[j] ? (dp[(i + 1) * w + j + 1] ?? 0) + 1 : Math.max(dp[(i + 1) * w + j] ?? 0, dp[i * w + j + 1] ?? 0)
      }
    }
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && x[i] === y[j]) {
        ops.push({ t: ' ', s: x[i] ?? '', ai: i, bi: j })
        i++
        j++
      } else if (i < n && (j >= m || (dp[(i + 1) * w + j] ?? 0) >= (dp[i * w + j + 1] ?? 0))) {
        ops.push({ t: '-', s: x[i] ?? '', ai: i, bi: j })
        i++
      } else {
        ops.push({ t: '+', s: y[j] ?? '', ai: i, bi: j })
        j++
      }
    }
  }
  const changed = ops.map((o, k) => (o.t !== ' ' ? k : -1)).filter(k => k >= 0)
  if (changed.length === 0) return ''
  const hunks: string[] = []
  let k = 0
  while (k < changed.length) {
    const first = changed[k] ?? 0
    let last = first
    while (k + 1 < changed.length && (changed[k + 1] ?? 0) - last <= context * 2) {
      k++
      last = changed[k] ?? last
    }
    k++
    const from = Math.max(0, first - context)
    const to = Math.min(ops.length - 1, last + context)
    const slice = ops.slice(from, to + 1)
    const head = slice[0]
    const aStart = (head?.ai ?? 0) + 1
    const bStart = (head?.bi ?? 0) + 1
    const aLen = slice.filter(o => o.t !== '+').length
    const bLen = slice.filter(o => o.t !== '-').length
    hunks.push(`@@ -${aLen ? aStart : aStart - 1},${aLen} +${bLen ? bStart : bStart - 1},${bLen} @@`)
    for (const o of slice) hunks.push(o.t + o.s)
  }
  return hunks.join('\n')
}

/** Strips a fence the model wrapped the whole file in. */
export function stripFence(s: string): string {
  const m = /^```[\w-]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(s.trim())
  return m ? (m[1] ?? '') + '\n' : s
}
