// A 手帐 page as one SVG string: cream dot-grid paper, washi tape, sticky
// notes, a hand-drawn bar chart, stamp tags. Pure: a few numbers in, markup
// and its `alt` out. No `$`, no clock, no randomness.

import { cellWidth, fit } from './text'

export type JournalTone = 'yellow' | 'pink' | 'mint' | 'blue' | 'purple'
export type JournalNote = { big: string; label: string; tone?: JournalTone }
/** `text` is what is written after the bar; left out, the value. */
export type JournalBar = { label: string; value: number; text?: string }
export type JournalStamp = { text: string; tone?: 'coral' | 'purple' | 'teal' }
export type JournalSpec = {
  title: string
  subtitle: string
  /** Sticky notes in a row: the first three are drawn. */
  notes: JournalNote[]
  barsTitle?: string
  /** Drawn in the order given: the first six. */
  bars?: JournalBar[]
  /** Stamp-style tags in a row under everything: the first four. */
  stamps?: JournalStamp[]
  /** Logical width in px, clamped to 320..680; default 460. */
  width?: number
}

// ---------- the look ----------

export const MIN_W = 320
export const MAX_W = 680
const DEFAULT_W = 460

// 手札体 first: one hand for Chinese, Latin and digits, and its 1 reads as a 1 (Noteworthy's is a bare stroke)
const FONT = "'Hannotate SC','Segoe Print','KaiTi','Chalkboard SE','Marker Felt','Kaiti SC','Songti SC',serif"

const PAPER = '#FBF6EA'
const PAPER_EDGE = '#E6DCC6'
const DOT = '#E3D9C3'
const INK = '#4A3B2A'
const INK_SOFT = '#8A7A63'
const TAPE_PINK = '#F4C0D1'
const TAPE_STRIPE = '#FBEAF0'
const TAPE_TEAL = '#9FE1CB'
const TAPE_PLAIN = '#E8DFC9'
const HIGHLIGHT = '#FAC775'
const STAR = '#EF9F27'
const SQUIGGLE = '#D4537E'
const SEAL = '#D85A30'

type NoteLook = { paper: string; big: string; label: string }

const NOTE_LOOKS: Record<JournalTone, NoteLook> = {
  yellow: { paper: '#FDE9A8', big: '#633806', label: '#854F0B' },
  pink: { paper: '#F9D2DE', big: '#72243E', label: '#993556' },
  mint: { paper: '#CDEBDD', big: '#085041', label: '#0F6E56' },
  blue: { paper: '#CFE3F8', big: '#0C447C', label: '#185FA5' },
  purple: { paper: '#DDDAF8', big: '#3C3489', label: '#534AB7' },
}
const NOTE_ORDER: readonly JournalTone[] = ['yellow', 'pink', 'mint', 'blue', 'purple']

const BAR_COLORS: readonly string[] = ['#F0997B', '#85B7EB', '#97C459', '#AFA9EC', '#FAC775', '#F4C0D1']

type StampTone = NonNullable<JournalStamp['tone']>
const STAMP_COLORS: Record<StampTone, string> = { coral: '#D85A30', purple: '#534AB7', teal: '#0F6E56' }
const STAMP_ORDER: readonly StampTone[] = ['coral', 'purple', 'teal']

/**
 * The hand of each bar by its index: how far the right end's top corner, the
 * right edge and the right end's bottom corner sit off the ruler, in px.
 */
const WOBBLE: readonly (readonly [number, number, number])[] = [
  [2, -1, 2],
  [-1, 1, 1],
  [1, 0, -1],
  [-2, -1, 0],
  [1, 1, 2],
  [0, -1, -2],
]

export const MAX_NOTES = 3
export const MAX_BARS = 6
export const MAX_STAMPS = 4
/** No box on the widest page holds this many cells; longer text is cut to it first. */
export const MAX_CELLS = 240
/** What `alt` keeps of one piece of text. */
export const ALT_CELLS = 80

// ---------- text ----------

/** One line of plain text: no control or direction characters, no lone surrogates. */
export function clean(v: unknown): string {
  const s = typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v)
  return s
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff\ufffe\uffff]/g, '')
    .replace(/[\ud800-\udfff]/gu, '')
    .trim()
}

/**
 * Text as XML character data. `=` and the `h` of `http` are written as
 * character references too, so nothing in the data can spell a handler
 * attribute or a URL in the source, however a reader of it scans.
 */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/=/g, '&#61;')
    .replace(/h(?=ttp)/gi, c => `&#${c.charCodeAt(0)};`)
}

/**
 * How wide one character runs, in ems. Never under its cells' half em each;
 * more where the handwriting faces run wide (digits, capitals, m and w).
 */
function glyphEm(ch: string): number {
  if (cellWidth(ch) >= 2) return 1
  const c = ch.codePointAt(0) ?? 0
  if (c >= 0x30 && c <= 0x39) return 0.74
  if (ch === '@') return 1.05
  if (ch === 'M' || ch === 'W' || ch === '%' || ch === '&') return 0.9
  if (ch === 'm' || ch === 'w' || ch === '…') return 0.75
  if (c === 0x2014 || c === 0x2015 || (c >= 0x2190 && c <= 0x2bff)) return 1
  if (c < 0x80) {
    if (c >= 0x41 && c <= 0x5a) return 0.7
    if ('#$+?_~'.includes(ch)) return 0.65
    return 0.5
  }
  return ch !== ch.toLowerCase() ? 0.75 : 0.6
}

function ems(s: string): number {
  let w = 0
  for (const ch of s) w += glyphEm(ch)
  return w
}

function inkWidth(s: string, fs: number): number {
  return ems(s) * fs
}

/** About how wide `s` really runs: for what is drawn under text, not for fitting it. */
function looseWidth(s: string, fs: number): number {
  let w = 0
  for (const ch of s) w += cellWidth(ch) >= 2 ? 1 : glyphEm(ch) * 0.84
  return w * fs
}

/** `s` cut with `fit` until it runs no wider than `maxPx` at `fs`. */
function fitText(s: string, fs: number, maxPx: number): string {
  if (!s || maxPx <= 0) return ''
  if (inkWidth(s, fs) <= maxPx) return s
  let cols = Math.floor((maxPx * 2) / fs)
  let out = fit(s, cols)
  while (cols > 0 && inkWidth(out, fs) > maxPx) {
    cols--
    out = fit(s, cols)
  }
  return out.replace(/ +…$/, '…')
}

/**
 * `s` on one line when it fits, else on two of about the same length, the
 * break at a space when one is near; the second line is cut to fit.
 */
function twoLines(s: string, fs: number, maxPx: number): string[] {
  if (!s) return []
  const total = inkWidth(s, fs)
  if (total <= maxPx) return [s]
  const chars = Array.from(s)
  const target = total <= maxPx * 2 ? total / 2 : maxPx
  let w = 0
  let cut = 0
  while (cut < chars.length && w < target) {
    const g = glyphEm(chars[cut] ?? '') * fs
    if (w + g > maxPx) break
    w += g
    cut++
  }
  if (cut === 0) return [fitText(s, fs, maxPx)]
  for (let i = cut; i >= cut / 3 && i > 0; i--) {
    if (chars[i] === ' ') {
      cut = i
      break
    }
  }
  const first = chars.slice(0, cut).join('').trimEnd()
  const rest = fitText(chars.slice(cut).join('').trimStart(), fs, maxPx)
  return rest ? [first, rest] : [first]
}

// ---------- markup ----------

/** A coordinate: one decimal at most, never NaN or Infinity. */
export function num(v: number): string {
  const r = Math.round(v * 10) / 10
  return Number.isFinite(r) ? String(r === 0 ? 0 : r) : '0'
}

function textEl(x: number, y: number, fs: number, fill: string, s: string, anchor?: 'middle' | 'end'): string {
  if (!s) return ''
  const a = anchor ? ` text-anchor="${anchor}"` : ''
  return `<text x="${num(x)}" y="${num(y)}" font-size="${fs}" fill="${fill}"${a}>${esc(s)}</text>`
}

export function rectEl(x: number, y: number, w: number, h: number, rest: string): string {
  return `<rect x="${num(x)}" y="${num(y)}" width="${num(Math.max(0, w))}" height="${num(Math.max(0, h))}" ${rest}/>`
}

export function pick<K extends string, V>(table: Record<K, V>, key: unknown, fallback: K): V {
  return typeof key === 'string' && Object.hasOwn(table, key) ? table[key as K] : table[fallback]
}

export function list<T>(v: readonly T[] | undefined, max: number): T[] {
  return Array.isArray(v) ? v.slice(0, max).filter(x => typeof x === 'object' && x !== null) : []
}

/** A bar's worth: negative, NaN and infinite count as nothing. */
export function worth(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

export function plainNumber(v: number): string {
  return String(Number.isInteger(v) ? v : Math.round(v * 100) / 100)
}

export function clampWidth(v: unknown): number {
  const w = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : DEFAULT_W
  return Math.min(MAX_W, Math.max(MIN_W, w))
}

// ---------- the page ----------

export function journalSvg(spec: JournalSpec): { source: string; alt: string; width: number; height: number } {
  const W = clampWidth(spec.width)
  const t = (W - MIN_W) / (MAX_W - MIN_W)
  /** A measure that grows with the page, whole px. */
  const grow = (narrow: number, wide: number) => Math.round(narrow + (wide - narrow) * t)
  const small = W < 400

  // What is written, whole (for `alt`) and bounded (for drawing).
  const title = clean(spec.title)
  const subtitle = clean(spec.subtitle)
  const barsTitle = clean(spec.barsTitle)
  const notes = list(spec.notes, MAX_NOTES).map((n, i) => ({
    big: clean(n.big),
    label: clean(n.label),
    look: pick(NOTE_LOOKS, n.tone, NOTE_ORDER[i % NOTE_ORDER.length] ?? 'yellow'),
  }))
  const bars = list(spec.bars, MAX_BARS).map(b => {
    const value = worth(b.value)
    return { label: clean(b.label), value, text: b.text === undefined ? plainNumber(value) : clean(b.text) }
  })
  const stamps = list(spec.stamps, MAX_STAMPS)
    .map((s, i) => ({ text: clean(s.text), color: pick(STAMP_COLORS, s.tone, STAMP_ORDER[i % STAMP_ORDER.length] ?? 'coral') }))
    .filter(s => s.text !== '')
  const drawn = (s: string) => fit(s, MAX_CELLS)

  // The paper: a small margin all round, a little more on top for the tape.
  const paperX = 6
  const tapeW = grow(64, 120)
  const tapeH = grow(18, 22)
  const paperTop = Math.ceil(tapeH / 2 + (tapeW / 2) * 0.0872 - 4) + 2
  const inner = grow(14, 30)
  const L = paperX + inner
  const R = W - paperX - inner
  const CW = R - L
  const gapY = grow(14, 22)
  const out: string[] = []

  // ---- tape ----
  const tapeY = paperTop + 4 - tapeH / 2
  const pinkX = paperX + grow(18, 38)
  const tealW = Math.round(tapeW * 0.92)
  const tealX = W - paperX - grow(24, 36) - tealW
  const tape =
    `<g class="tape">` +
    `<g transform="rotate(-5 ${num(pinkX + tapeW / 2)} ${num(paperTop + 4)})">` +
    rectEl(pinkX, tapeY, tapeW, tapeH, `fill="${TAPE_PINK}"`) +
    rectEl(pinkX, tapeY, tapeW, tapeH, `fill="url(#atlas-journal-stripe)" opacity="0.6"`) +
    `</g>` +
    rectEl(tealX, tapeY, tealW, tapeH, `fill="${TAPE_TEAL}" transform="rotate(4 ${num(tealX + tealW / 2)} ${num(paperTop + 4)})"`) +
    `</g>`
  const tapeBottom = paperTop + 4 + tapeH / 2 + (tapeW / 2) * 0.0872

  // ---- title, subtitle, the round seal when there is room beside them ----
  const titleFs = grow(20, 30)
  const subFs = small ? 12 : 13
  const sealR = grow(26, 32)
  const sealRoom = sealR * 2 + 12
  const hasSeal = inkWidth(drawn(title), titleFs) + 8 <= CW - sealRoom && inkWidth(drawn(subtitle), subFs) <= CW - sealRoom
  const headW = hasSeal ? CW - sealRoom : CW
  const titleText = fitText(drawn(title), titleFs, headW - 8)
  const subText = fitText(drawn(subtitle), subFs, headW)
  const headTop = paperTop + Math.round(titleFs * 0.9)
  let y = headTop
  out.push('<g class="head">')
  if (titleText) {
    y += titleFs
    out.push(
      rectEl(L - 4, y - Math.round(titleFs / 2), looseWidth(titleText, titleFs) + 10, Math.round(titleFs * 0.56), `fill="${HIGHLIGHT}" opacity="0.55"`),
      textEl(L, y, titleFs, INK, titleText),
    )
  }
  if (subText) {
    y += titleText ? Math.round(titleFs * 0.5 + subFs * 0.75) : subFs
    out.push(textEl(L, y, subFs, INK_SOFT, subText))
  }
  y += Math.round(subFs * 0.4)
  if (hasSeal) {
    const cx = R - sealR
    const cy = Math.max(Math.round((headTop + y) / 2), Math.ceil(tapeBottom + 3 + sealR))
    out.push(
      `<circle cx="${num(cx)}" cy="${num(cy)}" r="${sealR}" fill="none" stroke="${SEAL}" stroke-width="2" stroke-dasharray="5 3"/>`,
      textEl(cx, cy - 3, 13, SEAL, 'ATLAS', 'middle'),
      textEl(cx, cy + 14, 11, SEAL, 'checked', 'middle'),
    )
    y = Math.max(y, cy + sealR + 2)
  }
  out.push('</g>')

  // ---- sticky notes ----
  if (notes.length > 0) {
    const gap = grow(6, 18)
    const pad = grow(7, 14)
    const n = notes.length
    const noteW = Math.min((CW - gap * (n - 1)) / n, 190)
    const box = noteW - pad * 2
    const maxBig = grow(21, 29)
    const minBig = small ? 12 : 14
    const labelFs = small ? 11 : 13
    const laid = notes.map(note => {
      const big = drawn(note.big)
      const unit = ems(big)
      const bigFs = unit > 0 ? Math.min(maxBig, Math.max(minBig, Math.floor(box / unit))) : maxBig
      return { look: note.look, bigFs, big: fitText(big, bigFs, box), lines: twoLines(drawn(note.label), labelFs, box) }
    })
    const lineCount = Math.max(0, ...laid.map(l => l.lines.length))
    const top = y + gapY + 6
    const bigBase = top + grow(10, 18) + maxBig
    const labelBase = bigBase + labelFs + grow(7, 11)
    const linePitch = labelFs + 4
    const bottom = lineCount > 0 ? labelBase + (lineCount - 1) * linePitch + grow(9, 16) : bigBase + grow(12, 18)
    const tabW = Math.min(46, Math.round(noteW * 0.36))
    const tabH = grow(11, 14)
    out.push('<g class="notes">')
    laid.forEach((note, i) => {
      const x = L + i * (noteW + gap)
      out.push(
        rectEl(x, top, noteW, bottom - top, `fill="${note.look.paper}"`),
        rectEl(x + (noteW - tabW) / 2, top - Math.round(tabH / 2), tabW, tabH, `fill="${TAPE_PLAIN}"`),
        textEl(x + pad, bigBase, note.bigFs, note.look.big, note.big),
        ...note.lines.map((line, k) => textEl(x + pad, labelBase + k * linePitch, labelFs, note.look.label, line)),
      )
    })
    out.push('</g>')
    y = bottom
  }

  // ---- the bar chart ----
  if (bars.length > 0) {
    const fs = small ? 12 : 13
    y += gapY
    out.push('<g class="bars">')
    const heading = fitText(drawn(barsTitle), grow(14, 17), CW - 22)
    if (heading) {
      const headFs = grow(14, 17)
      y += headFs + 2
      out.push(
        `<path d="M${num(L + 2)} ${num(y - 5)} l4 -9 l4 9 l-10 -6 h12 Z" fill="${STAR}"/>`,
        textEl(L + 22, y, headFs, INK, heading),
      )
      y += grow(11, 16)
    }
    const barH = grow(16, 21)
    const pitch = barH + grow(9, 13)
    const labels = bars.map(b => fitText(drawn(b.label), fs, Math.floor(CW * 0.36)))
    const texts = bars.map(b => fitText(drawn(b.text), fs, Math.floor(CW * 0.3)))
    const labelW = Math.ceil(Math.max(0, ...labels.map(s => inkWidth(s, fs))))
    const textW = Math.ceil(Math.max(0, ...texts.map(s => inkWidth(s, fs))))
    const barX = L + (labelW > 0 ? labelW + 10 : 0)
    const room = R - barX - (textW > 0 ? textW + 8 : 0) - 2
    const most = Math.max(0, ...bars.map(b => b.value))
    bars.forEach((bar, i) => {
      const top = y + i * pitch
      const base = Math.round(top + barH / 2 + fs * 0.36)
      const color = BAR_COLORS[i % BAR_COLORS.length] ?? '#F0997B'
      const len = most > 0 && bar.value > 0 ? Math.max(4, (bar.value / most) * room) : 0
      out.push('<g class="row">', textEl(L, base, fs, INK, labels[i] ?? ''))
      if (len > 0) {
        const hand = WOBBLE[i % WOBBLE.length] ?? [0, 0, 0]
        const tame = (d: number) => (len < 8 ? 0 : len < 20 ? Math.sign(d) * Math.min(1, Math.abs(d)) : d)
        const [a, b, c] = [tame(hand[0]), tame(hand[1]), tame(hand[2])]
        out.push(
          `<path d="M${num(barX)} ${num(top)} L${num(barX + len)} ${num(top + a)} L${num(barX + len + b)} ${num(top + barH + c)} L${num(barX)} ${num(top + barH)} Z" fill="${color}"/>`,
        )
      } else {
        out.push(`<path d="M${num(barX)} ${num(top + 1)} V${num(top + barH - 1)}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>`)
      }
      out.push(textEl(barX + len + 8, base, fs, INK_SOFT, texts[i] ?? ''), '</g>')
    })
    out.push('</g>')
    y += (bars.length - 1) * pitch + barH
  }

  // ---- stamp tags, to the right, wrapping to more rows when they must ----
  if (stamps.length > 0) {
    const fs = 12
    const h = 24
    const gap = 8
    const padX = grow(9, 12)
    /** The tags in rows, none wider than `widest`. */
    const inRows = (widest: number) => {
      const tags = stamps.map(s => {
        const text = fitText(drawn(s.text), fs, widest - padX * 2)
        return { text, color: s.color, w: Math.max(44, Math.ceil(inkWidth(text, fs)) + padX * 2) }
      })
      const laid: (typeof tags)[] = []
      let rowW = 0
      for (const tag of tags) {
        const row = laid[laid.length - 1]
        if (row && rowW + gap + tag.w <= CW) {
          row.push(tag)
          rowW += gap + tag.w
        } else {
          laid.push([tag])
          rowW = tag.w
        }
      }
      return laid
    }
    // Whole when that takes two rows at most; else each cut to half a row, which always does.
    let rows = inRows(CW)
    if (rows.length > 2) rows = inRows(Math.floor((CW - gap) / 2))
    y += gapY
    out.push('<g class="stamps">')
    rows.forEach((row, k) => {
      const top = y + k * (h + gap)
      const width = row.reduce((sum, tag) => sum + tag.w, 0) + gap * (row.length - 1)
      let x = R - width
      if (k === 0 && x - L >= 64 + 16) {
        out.push(`<path d="M${num(L)} ${num(top + h / 2 + 2)} q8 -5 16 0 t16 0 t16 0 t16 0" fill="none" stroke="${SQUIGGLE}" stroke-width="1.5"/>`)
      }
      for (const tag of row) {
        out.push(
          rectEl(x, top, tag.w, h, `rx="4" fill="none" stroke="${tag.color}" stroke-width="1.5"`),
          textEl(x + tag.w / 2, top + 17, fs, tag.color, tag.text, 'middle'),
        )
        x += tag.w + gap
      }
    })
    out.push('</g>')
    y += rows.length * h + (rows.length - 1) * gap
  }

  const paperBottom = Math.ceil(y + grow(14, 22))
  const H = paperBottom + 6
  const paperW = W - paperX * 2
  const paperH = paperBottom - paperTop

  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" font-family="${FONT}">` +
    `<title>${esc(fit(title, ALT_CELLS) || '手帐')}</title>` +
    `<defs>` +
    `<pattern id="atlas-journal-dots" x="${paperX + 6}" y="${paperTop + 6}" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="${DOT}"/></pattern>` +
    `<pattern id="atlas-journal-stripe" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="8" fill="${TAPE_STRIPE}"/></pattern>` +
    `</defs>` +
    `<g class="paper">` +
    rectEl(paperX, paperTop, paperW, paperH, `rx="8" fill="${PAPER}" stroke="${PAPER_EDGE}" stroke-width="1"`) +
    rectEl(paperX, paperTop, paperW, paperH, `rx="8" fill="url(#atlas-journal-dots)"`) +
    `</g>` +
    tape +
    out.join('') +
    `</svg>`

  // ---- the same page in words ----
  const said = (s: string) => fit(s, ALT_CELLS)
  const pair = (a: string, b: string) => [said(a), said(b)].filter(Boolean).join(' ')
  const parts = [`手帐插图「${said(title)}」${subtitle ? `（${said(subtitle)}）` : ''}`]
  const noteWords = notes.map(n => pair(n.big, n.label)).filter(Boolean)
  if (noteWords.length > 0) parts.push(`便签：${noteWords.join('、')}`)
  const barWords = bars.map(b => pair(b.label, b.text)).filter(Boolean)
  if (barWords.length > 0) parts.push(`${said(barsTitle) || '条形图'}：${barWords.join('、')}`)
  if (stamps.length > 0) parts.push(`标签：${stamps.map(s => said(s.text)).join('、')}`)
  const alt = parts.join('；') + '。'

  return { source, alt, width: W, height: H }
}
