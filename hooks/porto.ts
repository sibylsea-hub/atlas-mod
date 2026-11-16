// A 海岸小镇 page as one SVG string: the page journal.ts draws, as a postcard
// from a harbour town. Cream paper; across its top the view (a pale sky with
// the sun in it, the town's houses shoulder to shoulder on the quay, the sea
// under them with a boat or two); under the view a masthead closed by a line
// of swell, cards like pale house fronts under a tiled roof, flat bars in the
// walls' colours, rounded tags. The strong colours are the houses'; what is
// read is quiet. It takes journal's spec and keeps journal's contract. Pure:
// no `$`, no clock, no randomness.

import { ALT_CELLS, MAX_BARS, MAX_CELLS, MAX_NOTES, MAX_STAMPS, MAX_W, MIN_W, clampWidth, clean, esc, list, num, pick, plainNumber, rectEl, worth } from './journal'
import type { JournalSpec, JournalStamp, JournalTone } from './journal'
import { PORTO, PORTO_DISPLAY, PORTO_SANS, PORTO_TONES, PORTO_WALLS, boat, house, swell, town } from './porto-look'
import { fit } from './text'

// ---------- the look ----------

type Tone = keyof typeof PORTO_TONES

/** A card's pale tone for each of journal's note tones, and the order they come in when none is asked for. */
const CARD_TONES: Record<JournalTone, Tone> = { yellow: 'peach', pink: 'rose', mint: 'foam', blue: 'sky', purple: 'lilac' }
const CARD_ORDER: readonly JournalTone[] = ['yellow', 'pink', 'mint', 'blue', 'purple']

/** The bars in the town's colours: terracotta, ochre, pink, the sea, coral, peach. */
const BAR_COLORS: readonly string[] = [PORTO_WALLS[0], PORTO_WALLS[1], PORTO_WALLS[2], PORTO.sea, PORTO_WALLS[4], PORTO_WALLS[5]]

type StampTone = NonNullable<JournalStamp['tone']>
/** A tag's line and its writing: one colour, deep enough to read on the paper. */
const TAG_COLORS: Record<StampTone, string> = { coral: PORTO.roof, purple: PORTO.lilacDeep, teal: PORTO.seaDeep }
const TAG_ORDER: readonly StampTone[] = ['coral', 'purple', 'teal']

/** The paper left round the view, as round the picture on a postcard. */
const MAT = 5

// ---------- text ----------

/** A face's measure: how wide each of ASCII's printing characters (space to ~) runs in it, in hundredths of an em. */
type Face = readonly number[]

/**
 * The display stack: per character, the widest of Cochin, Hoefler Text and
 * Georgia, each in its roman and its italic, as the faces measure.
 */
const DISPLAY: Face = [
  25, 39, 42, 73, 61, 90, 87, 23, 45, 45, 50, 65, 27, 38, 27, 47, 62, 50, 56, 56, 57, 53, 57, 51, 60, 57, 39, 39, 65, 65, 65, 50,
  93, 77, 69, 74, 84, 69, 63, 82, 87, 45, 63, 79, 65, 98, 86, 84, 63, 84, 74, 60, 72, 80, 77, 113, 79, 78, 71, 45, 61, 45, 65, 65,
  50, 58, 56, 47, 58, 49, 34, 58, 59, 30, 32, 55, 29, 89, 60, 54, 58, 56, 47, 44, 37, 58, 55, 83, 52, 56, 46, 45, 38, 45, 65,
]

/**
 * The sans stack, in its regular weight: per character, the widest of Gill
 * Sans and Avenir Next as they measure. Segoe UI was not at hand to measure:
 * the table is raised to Helvetica Neue, which runs wider than it nearly
 * everywhere, and to Segoe UI's own widths where that face is known to run
 * wider still.
 */
const SANS: Face = [
  28, 33, 43, 60, 58, 100, 80, 28, 33, 33, 45, 69, 28, 40, 28, 39, 58, 58, 58, 58, 58, 58, 58, 58, 58, 58, 30, 30, 69, 69, 69, 56,
  101, 70, 69, 73, 76, 62, 58, 78, 73, 27, 52, 67, 56, 90, 79, 85, 65, 85, 69, 65, 61, 73, 63, 105, 71, 65, 65, 34, 38, 34, 69, 56,
  34, 54, 64, 54, 64, 58, 32, 64, 59, 25, 26, 52, 26, 89, 59, 62, 64, 64, 40, 50, 34, 59, 50, 76, 52, 50, 48, 34, 26, 34, 69,
]

/** How wide one character runs in a face, in ems: never under what any face of its stack gives it. */
function glyphEm(ch: string, face: Face): number {
  const c = ch.codePointAt(0) ?? 0
  if (c >= 0x20 && c <= 0x7e) return (face[c - 0x20] ?? 100) / 100
  if (ch === '·' || ch === '‘' || ch === '’') return 0.34
  if (ch === '“' || ch === '”') return 0.46
  const isLower = ch !== ch.toUpperCase()
  const isUpper = ch !== ch.toLowerCase()
  // Chinese, kana, punctuation, signs, emoji: a full square; letters past ASCII run to one, their capitals past it
  if (!isLower && !isUpper) return 1
  return isLower ? 1 : 1.15
}

function measure(s: string, fs: number, face: Face, spacing: number): number {
  let w = 0
  for (const ch of s) w += glyphEm(ch, face) * fs + spacing
  return w
}

/** How wide `s` runs at `fs` in the display face, `spacing` px after each letter: what the layout takes it to be. */
export function displayWidth(s: string, fs: number, spacing = 0): number {
  return measure(s, fs, DISPLAY, spacing)
}

/** How wide `s` runs at `fs` in the sans, `spacing` px after each letter: what the layout takes it to be. */
export function sansWidth(s: string, fs: number, spacing = 0): number {
  return measure(s, fs, SANS, spacing)
}

/** `s` whole when it runs no wider than `maxPx`, else cut to end with … inside it. */
function cut(s: string, fs: number, maxPx: number, face: Face, spacing = 0): string {
  if (!s || maxPx <= 0) return ''
  if (measure(s, fs, face, spacing) <= maxPx) return s
  const room = maxPx - measure('…', fs, face, spacing)
  if (room < 0) return ''
  let out = ''
  let w = 0
  for (const ch of s) {
    const g = glyphEm(ch, face) * fs + spacing
    if (w + g > room) break
    out += ch
    w += g
  }
  return out.trimEnd() + '…'
}

/**
 * `s` on one line when it fits, else on two of about the same length, the
 * break at a space when one is near; the second line is cut to fit.
 */
function twoLines(s: string, fs: number, maxPx: number, face: Face): string[] {
  if (!s) return []
  const total = measure(s, fs, face, 0)
  if (total <= maxPx) return [s]
  const chars = Array.from(s)
  const target = total <= maxPx * 2 ? total / 2 : maxPx
  let w = 0
  let at = 0
  while (at < chars.length && w < target) {
    const g = glyphEm(chars[at] ?? '', face) * fs
    if (w + g > maxPx) break
    w += g
    at++
  }
  if (at === 0) return [cut(s, fs, maxPx, face)].filter(Boolean)
  for (let i = at; i >= at / 3 && i > 0; i--) {
    if (chars[i] === ' ') {
      at = i
      break
    }
  }
  const first = chars.slice(0, at).join('').trimEnd()
  const rest = cut(chars.slice(at).join('').trimStart(), fs, maxPx, face)
  return rest ? [first, rest] : [first]
}

// ---------- markup ----------

/** How a text is set: in the sans (else the display face), slanted, `spacing` px after each letter, centred on its x. */
type Hand = { sans?: boolean; italic?: boolean; spacing?: number; centred?: boolean }

function write(x: number, y: number, fs: number, fill: string, s: string, hand: Hand = {}): string {
  if (!s) return ''
  const spacing = hand.spacing ?? 0
  // the spacing follows the last letter too: a centred line is set back by half of it
  const at = hand.centred ? x + spacing / 2 : x
  return (
    `<text x="${num(at)}" y="${num(y)}" font-size="${fs}" fill="${fill}"` +
    (hand.sans ? ` font-family="${PORTO_SANS}"` : '') +
    (hand.italic ? ` font-style="italic"` : '') +
    (hand.centred ? ` text-anchor="middle"` : '') +
    (spacing > 0 ? ` letter-spacing="${num(spacing)}"` : '') +
    `>${esc(s)}</text>`
  )
}

function line(d: string, stroke: string): string {
  return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1"/>`
}

/**
 * What the look drew, with its many small pieces of one colour made one path
 * each: every door, every shutter, every pane. A house draws these inside
 * its own wall and clear of its neighbours, so nothing drawn later lies over
 * them and the picture is the same; the markup is half as long.
 */
function gathered(markup: string): string {
  const paths = new Map<string, string>([
    [PORTO.door, ''],
    [PORTO.shutter, ''],
    [PORTO.window, ''],
  ])
  const rest = markup
    .replace(/<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)" fill="(#[0-9A-Fa-f]{6})"\/>/g, (el: string, x: string, y: string, w: string, h: string, fill: string) => {
      const d = paths.get(fill)
      if (d === undefined) return el
      paths.set(fill, `${d}M${x} ${y}h${w}v${h}h-${w}z`)
      return ''
    })
    .replace(/<path d="([^"]*)" fill="(#[0-9A-Fa-f]{6})"\/>/g, (el: string, d: string, fill: string) => {
      if (fill !== PORTO.door) return el
      paths.set(fill, (paths.get(fill) ?? '') + d)
      return ''
    })
  let out = rest
  for (const [fill, d] of paths) if (d) out += `<path d="${d}" fill="${fill}"/>`
  return out
}

/**
 * The look's town across `span` px from `x`, standing on `base`: of the
 * house widths within two px of `unit`, the one whose whole houses leave the
 * least over, so the row runs from one side of the view to the other.
 */
function townAcross(x: number, span: number, base: number, height: number, unit: number): string {
  let best = { unit, over: Infinity }
  for (const u of [unit, unit - 1, unit + 1, unit - 2, unit + 2]) {
    // a town 1px tall is its walls alone, and its first wall stands half of what is left over from the start
    const first = /^<rect x="([\d.]+)"/.exec(town(0, span, 0, 1, u))?.[1]
    const over = first === undefined ? Infinity : Number(first) * 2
    if (over < best.over) best = { unit: u, over }
  }
  if (!Number.isFinite(best.over)) return ''
  const from = x + Math.floor(best.over / 2)
  return gathered(town(from, from + span - best.over, base, height, best.unit))
}

/** A line of the look's swell from `x`, running as near `span` px as whole waves about 16px long come. */
function swellAcross(x: number, span: number, y: number, stroke: string): string {
  let best = { length: 16, over: Infinity }
  // lengths whose quarter is a whole tenth of a px, so a long line does not drift
  for (let length = 14; length <= 18.01; length += 0.4) {
    const over = span - Math.floor(span / length + 1e-9) * length
    if (over < best.over - 1e-9) best = { length: Math.round(length * 10) / 10, over }
  }
  return swell(x, x + span + 0.01, y, best.length, 4, stroke)
}

/** How far a tile of a roof `w` wide hangs: half of its own width, the tiles about 7px wide and a whole number of them. */
function tileDrop(w: number): number {
  return w / Math.max(1, Math.round(w / 7)) / 2
}

/** A tile's measure: two decimals, so a row of them ends where it should. */
function fine(v: number): string {
  const r = Math.round(v * 100) / 100
  return Number.isFinite(r) ? String(r === 0 ? 0 : r) : '0'
}

/** A card's roof: a band of tiles `w` wide with its top at `y`, 4px of it solid, its lower edge scalloped. */
function tiledRoof(x: number, y: number, w: number): string {
  const r = tileDrop(w)
  return `<path d="M${num(x)} ${num(y)} h${num(w)} v4` + ` a${fine(r)} ${fine(r)} 0 0 1 ${fine(-r * 2)} 0`.repeat(Math.max(1, Math.round(w / 7))) + ` Z" fill="${PORTO.roof}"/>`
}

/** A small shuttered window, 12px wide and 9px tall, its corner at (x, y). */
function shutteredWindow(x: number, y: number): string {
  return rectEl(x, y, 12, 9, `fill="${PORTO.shutter}"`) + rectEl(x + 3, y, 6, 9, `fill="${PORTO.window}"`)
}

type Box = { x0: number; x1: number; y0: number; y1: number }

/** Two boxes keep `gap` px between them, across or up and down. */
function apart(a: Box, b: Box, gap: number): boolean {
  return a.x1 + gap <= b.x0 || b.x1 + gap <= a.x0 || a.y1 + gap <= b.y0 || b.y1 + gap <= a.y0
}

// ---------- the page ----------

export function portoSvg(spec: JournalSpec): { source: string; alt: string; width: number; height: number } {
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
    tone: PORTO_TONES[pick(CARD_TONES, n.tone, CARD_ORDER[i % CARD_ORDER.length] ?? 'yellow')],
  }))
  const bars = list(spec.bars, MAX_BARS).map(b => {
    const value = worth(b.value)
    return { label: clean(b.label), value, text: b.text === undefined ? plainNumber(value) : clean(b.text) }
  })
  const stamps = list(spec.stamps, MAX_STAMPS)
    .map((s, i) => ({ text: clean(s.text), color: pick(TAG_COLORS, s.tone, TAG_ORDER[i % TAG_ORDER.length] ?? 'coral') }))
    .filter(s => s.text !== '')
  const drawn = (s: string) => fit(s, MAX_CELLS)

  // The paper, and the one left edge the writing stands on.
  const paperX = 6
  const paperTop = 6
  const inner = grow(20, 40)
  const L = paperX + inner
  const R = W - paperX - inner
  const CW = R - L
  const gapY = grow(18, 26)
  const out: string[] = []

  // ---- the view: sky and sun, the town on its quay, the sea with its swell and a boat or two ----
  const viewX = paperX + MAT
  const viewY = paperTop + MAT
  const viewW = W - viewX * 2
  const viewH = grow(100, 155)
  const seaH = grow(26, 42)
  const quayH = grow(3, 4)
  const quayY = viewY + viewH - seaH - quayH
  const seaY = quayY + quayH
  const sunR = grow(11, 17)
  const hull = grow(16, 26)
  const waves = (inset: number, y: number) => {
    const count = Math.floor((viewW - inset * 2) / 16)
    const from = viewX + (viewW - count * 16) / 2
    return swell(from, from + count * 16 + 0.5, y, 16, 4, PORTO.seaPale)
  }
  out.push(
    '<g class="view">',
    rectEl(viewX, viewY, viewW, viewH - seaH, `fill="${PORTO.sky}"`),
    `<circle cx="${num(viewX + viewW - grow(36, 76))}" cy="${num(viewY + sunR + grow(7, 10))}" r="${sunR}" fill="${PORTO.sun}"/>`,
    '<g class="town">',
    townAcross(viewX, viewW, quayY, grow(46, 78), grow(26, 44)),
    '</g>',
    rectEl(viewX, quayY, viewW, quayH, `fill="${PORTO.quay}"`),
    rectEl(viewX, seaY, viewW, seaH, `fill="${PORTO.sea}"`),
    waves(grow(8, 14), seaY + Math.round(seaH * 0.34)),
    waves(grow(22, 44), seaY + Math.round(seaH * 0.7)),
    '<g class="boat">',
    boat(viewX + Math.round(viewW * 0.27), seaY + seaH - 4, hull),
    '</g>',
  )
  if (!small) out.push('<g class="boat">', boat(viewX + Math.round(viewW * 0.71), seaY + seaH - grow(8, 13), Math.round(hull * 0.75), PORTO.ink), '</g>')
  out.push('</g>')

  // ---- the masthead: a kicker, the title large, a line of swell under them ----
  const kickFs = small ? 11 : 12
  const kickSpacing = small ? 1.5 : 2
  const kicker = cut(drawn(subtitle), kickFs, CW, SANS, kickSpacing)
  const titleMax = grow(32, 48)
  const titleUnit = displayWidth(drawn(title), 1)
  // a long title is set smaller before it is cut
  const titleFs = titleUnit > 0 ? Math.min(titleMax, Math.max(grow(22, 30), Math.floor(CW / titleUnit))) : titleMax
  const titleText = cut(drawn(title), titleFs, CW, DISPLAY)

  let y = viewY + viewH + grow(16, 24)
  let kickBase = y
  if (kicker) {
    kickBase = y + Math.round(kickFs * 0.8)
    y = kickBase + Math.round(kickFs * 0.25)
  }
  let titleBase = y
  if (titleText) {
    titleBase = y + (kicker ? grow(5, 8) : 0) + Math.round(titleFs * 0.8)
    y = titleBase + Math.round(titleFs * 0.22)
  }
  y += kicker || titleText ? grow(9, 13) : 0
  out.push(
    '<g class="masthead">',
    write(L, kickBase, kickFs, PORTO.seaDeep, kicker, { sans: true, spacing: kickSpacing }),
    write(L, titleBase, titleFs, PORTO.roofDeep, titleText),
    swellAcross(L, CW, y, PORTO.sea),
    '</g>',
  )
  y += 3

  // ---- cards like house fronts: a pale wall under a tiled roof, a shuttered window where the writing leaves room ----
  if (notes.length > 0) {
    const n = notes.length
    const gap = grow(10, 18)
    const pad = grow(9, 14)
    const cardW = (CW - gap * (n - 1)) / n
    const box = cardW - pad * 2
    const maxBig = grow(22, 32)
    const minBig = small ? 13 : 15
    const labelFs = small ? 11 : 12
    const laid = notes.map(note => {
      const big = drawn(note.big)
      const unit = displayWidth(big, 1)
      const bigFs = unit > 0 ? Math.min(maxBig, Math.max(minBig, Math.floor(box / unit))) : maxBig
      return { tone: note.tone, bigFs, big: cut(big, bigFs, box, DISPLAY), lines: twoLines(drawn(note.label), labelFs, box, SANS) }
    })
    const lineCount = Math.max(0, ...laid.map(l => l.lines.length))
    // the roof stands 2px proud of the wall on three sides, and its tiles hang 5px or so down the front
    const eaves = 2
    const top = y + grow(18, 24)
    const roofFoot = Math.ceil(top - eaves + 4 + tileDrop(cardW + eaves * 2))
    const bigBase = roofFoot + grow(7, 10) + Math.round(maxBig * 0.76)
    const labelBase = bigBase + grow(7, 10) + labelFs
    const linePitch = labelFs + 4
    const bottom = lineCount > 0 ? labelBase + (lineCount - 1) * linePitch + grow(9, 13) : bigBase + grow(11, 15)
    out.push('<g class="cards">')
    laid.forEach((note, i) => {
      const x = L + i * (cardW + gap)
      const texts: Box[] = []
      if (note.big) texts.push({ x0: x + pad, x1: x + pad + displayWidth(note.big, note.bigFs), y0: bigBase - note.bigFs * 0.85, y1: bigBase + note.bigFs * 0.22 })
      note.lines.forEach((text, k) => texts.push({ x0: x + pad, x1: x + pad + sansWidth(text, labelFs), y0: labelBase + k * linePitch - labelFs * 0.85, y1: labelBase + k * linePitch + labelFs * 0.22 }))
      const pane: Box = { x0: x + cardW - pad - 12, x1: x + cardW - pad, y0: roofFoot + 6, y1: roofFoot + 15 }
      out.push(
        '<g class="card">',
        rectEl(x + 0.5, top + 0.5, cardW - 1, bottom - top - 1, `fill="${note.tone.pale}" stroke="${note.tone.deep}" stroke-width="1"`),
        tiledRoof(x - eaves, top - eaves, cardW + eaves * 2),
        texts.every(text => apart(pane, text, 6)) && pane.y1 + 6 <= bottom ? shutteredWindow(pane.x0, pane.y0) : '',
        write(x + pad, bigBase, note.bigFs, note.tone.ink, note.big),
        ...note.lines.map((text, k) => write(x + pad, labelBase + k * linePitch, labelFs, note.tone.ink, text, { sans: true })),
        '</g>',
      )
    })
    out.push('</g>')
    y = bottom
  }

  // ---- the bars ----
  if (bars.length > 0) {
    const fs = small ? 11 : 12
    const textFs = fs + 2
    y += gapY
    out.push('<g class="bars">')
    const headFs = grow(15, 19)
    // the heading leaves room for a short rule after it
    const heading = cut(drawn(barsTitle), headFs, CW - 18 - 30, DISPLAY)
    if (heading) {
      y += headFs
      const ruleY = y - Math.round(headFs * 0.32)
      out.push(
        // a small house for its bullet: an ochre wall under a pitched roof
        house(L + 1, y, 10, 8, 1),
        write(L + 18, y, headFs, PORTO.ink, heading),
        line(`M${num(L + 18 + Math.ceil(displayWidth(heading, headFs)) + 10)} ${num(ruleY + 0.5)} H${num(R)}`, PORTO.quay),
      )
      y += grow(12, 16)
    }
    const barH = small ? 10 : 12
    const pitch = barH + grow(11, 15)
    const labels = bars.map(b => cut(drawn(b.label), fs, Math.floor(CW * 0.36), SANS))
    const texts = bars.map(b => cut(drawn(b.text), textFs, Math.floor(CW * 0.3), DISPLAY))
    const labelW = Math.ceil(Math.max(0, ...labels.map(s => sansWidth(s, fs))))
    const textW = Math.ceil(Math.max(0, ...texts.map(s => displayWidth(s, textFs))))
    const barX = L + (labelW > 0 ? labelW + 12 : 0)
    // a slanted last letter leans a little past its own width
    const room = R - barX - (textW > 0 ? textW + 8 + 3 : 0)
    const most = Math.max(0, ...bars.map(b => b.value))
    bars.forEach((bar, i) => {
      const top = y + i * pitch
      const base = Math.round(top + barH / 2 + fs * 0.36)
      const color = BAR_COLORS[i % BAR_COLORS.length] ?? PORTO.sea
      const len = most > 0 && bar.value > 0 ? Math.max(4, (bar.value / most) * room) : 0
      out.push('<g class="row">', write(L, base, fs, PORTO.ink, labels[i] ?? '', { sans: true }))
      if (len > 0) out.push(rectEl(barX, top, len, barH, `fill="${color}"`))
      else out.push(`<path d="M${num(barX)} ${num(top)} V${num(top + barH)}" fill="none" stroke="${color}" stroke-width="1.5"/>`)
      out.push(write(barX + len + 8, base, textFs, PORTO.seaDeep, texts[i] ?? '', { italic: true }), '</g>')
    })
    out.push('</g>')
    y += (bars.length - 1) * pitch + barH
  }

  // ---- tags, to the right, wrapping to more rows when they must ----
  if (stamps.length > 0) {
    const fs = small ? 11 : 12
    const h = 24
    const gap = 8
    const padX = grow(10, 13)
    /** The tags in rows, none wider than `widest`. */
    const inRows = (widest: number) => {
      const tags = stamps.map(s => {
        const text = cut(drawn(s.text), fs, widest - padX * 2, SANS)
        return { text, color: s.color, w: Math.max(40, Math.ceil(sansWidth(text, fs)) + padX * 2) }
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
    let laid = inRows(CW)
    if (laid.length > 2) laid = inRows(Math.floor((CW - gap) / 2))
    y += gapY
    out.push('<g class="tags">')
    laid.forEach((row, k) => {
      const top = y + k * (h + gap)
      const width = row.reduce((sum, tag) => sum + tag.w, 0) + gap * (row.length - 1)
      let x = R - width
      // a boat on three waves of swell left of the first row, when they fit with room to spare
      if (k === 0 && x - L >= 48 + 16) out.push(swell(L, L + 48.5, top + h - 5, 16, 4, PORTO.sea), '<g class="boat">', boat(L + 24, top + h - 4, 14), '</g>')
      for (const tag of row) {
        out.push(
          rectEl(x + 0.5, top + 0.5, tag.w - 1, h - 1, `rx="6" fill="none" stroke="${tag.color}" stroke-width="1"`),
          write(x + tag.w / 2, top + Math.round(h / 2 + fs * 0.36), fs, tag.color, tag.text, { sans: true, centred: true }),
        )
        x += tag.w + gap
      }
    })
    out.push('</g>')
    y += laid.length * h + (laid.length - 1) * gap
  }

  // ---- the foot: paper ----
  const paperBottom = Math.ceil(y + grow(20, 28))
  const H = paperBottom + 6
  const paperW = W - paperX * 2
  const paperH = paperBottom - paperTop

  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" font-family="${PORTO_DISPLAY}">` +
    `<title>${esc(fit(title, ALT_CELLS) || '明信片')}</title>` +
    `<g class="paper">` +
    rectEl(paperX, paperTop, paperW, paperH, `rx="4" fill="${PORTO.paper}" stroke="${PORTO.paperEdge}" stroke-width="1"`) +
    `</g>` +
    out.join('') +
    `</svg>`

  // ---- the same page in words ----
  const said = (s: string) => fit(s, ALT_CELLS)
  const pair = (a: string, b: string) => [said(a), said(b)].filter(Boolean).join(' ')
  const parts = [`明信片插图「${said(title)}」${subtitle ? `（${said(subtitle)}）` : ''}`]
  const noteWords = notes.map(n => pair(n.big, n.label)).filter(Boolean)
  if (noteWords.length > 0) parts.push(`数字：${noteWords.join('、')}`)
  const barWords = bars.map(b => pair(b.label, b.text)).filter(Boolean)
  if (barWords.length > 0) parts.push(`${said(barsTitle) || '条形图'}：${barWords.join('、')}`)
  if (stamps.length > 0) parts.push(`标签：${stamps.map(s => said(s.text)).join('、')}`)
  const alt = parts.join('；') + '。'

  return { source, alt, width: W, height: H }
}
