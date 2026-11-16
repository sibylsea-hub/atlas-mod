// A 档案 page as one SVG string: the page journal.ts draws, in the look of an
// archive sheet. Ivory paper in a double gold frame with notched corners, a
// centred serif title between a brass plate and a wax seal, index cards under
// numbered wine tabs, fabric swatches with a pinked end for bars, ticket
// stubs for tags. It takes journal's spec and keeps journal's contract.
// Pure: no `$`, no clock, no randomness.

import { FOLIO, FOLIO_FONT, FOLIO_TONES, hairline, lozenge, ornamentRule, spark } from './folio-look'
import { ALT_CELLS, MAX_BARS, MAX_CELLS, MAX_NOTES, MAX_STAMPS, MAX_W, MIN_W, clampWidth, clean, esc, list, num, pick, plainNumber, rectEl, worth } from './journal'
import type { JournalSpec, JournalStamp, JournalTone } from './journal'
import { fit } from './text'

// ---------- the look ----------

type Tone = keyof typeof FOLIO_TONES

/** A card's colour for each of journal's note tones, and the order they come in when none is asked for. */
const CARD_TONES: Record<JournalTone, Tone> = { yellow: 'oat', pink: 'rose', mint: 'sage', blue: 'haze', purple: 'mauve' }
const CARD_ORDER: readonly JournalTone[] = ['yellow', 'pink', 'mint', 'blue', 'purple']

const SWATCH_ORDER: readonly Tone[] = ['rose', 'sage', 'oat', 'haze', 'taupe', 'mauve']

type StampTone = NonNullable<JournalStamp['tone']>
const STUB_COLORS: Record<StampTone, string> = { coral: FOLIO.wine, purple: FOLIO.mauveDeep, teal: FOLIO.sageDeep }
const STUB_ORDER: readonly StampTone[] = ['coral', 'purple', 'teal']

/** The wax seal's edge: how far out each of its twelve points sits, as a share of the radius. */
const SEAL_EDGE: readonly number[] = [1.04, 0.97, 1.03, 0.99, 1.05, 0.96, 1.02, 1, 1.05, 0.97, 1.03, 0.98]

const PLATE_W = 92
const SIDE_H = 34
const SEAL_R = SIDE_H / 2
/** How near the plate and the seal may come to what is written between them. */
const SIDE_CLEAR = 10

// ---------- text ----------

/**
 * How wide each of ASCII's printing characters (space to ~) runs in the
 * serif, in hundredths of an em: the wider of Baskerville's and Georgia's, as
 * the two faces measure. Journal's widths are for a hand that runs wider in
 * digits and spaces and narrower in capitals: here a rule is drawn right
 * after a text, so the measure has to be the face's own.
 */
const SERIF_ASCII: readonly number[] = [
  25, 34, 42, 67, 61, 88, 71, 22, 38, 38, 48, 67, 27, 38, 27, 53, 62, 50, 56, 56, 57, 53, 57, 51, 60, 57, 32, 32, 67, 67, 67, 48,
  93, 68, 66, 72, 76, 66, 60, 78, 82, 39, 52, 79, 61, 93, 77, 83, 61, 83, 73, 57, 70, 78, 73, 98, 78, 68, 64, 38, 53, 38, 65, 65,
  50, 51, 56, 46, 58, 49, 33, 51, 59, 30, 30, 54, 29, 89, 60, 54, 58, 56, 41, 44, 35, 58, 50, 74, 51, 50, 45, 48, 51, 48, 67,
]

/** How wide one character runs in the serif, in ems: never under what either face gives it. */
function serifEm(ch: string): number {
  const c = ch.codePointAt(0) ?? 0
  if (c >= 0x20 && c <= 0x7e) return (SERIF_ASCII[c - 0x20] ?? 100) / 100
  if (ch === '·' || ch === '‘' || ch === '’') return 0.34
  if (ch === '“' || ch === '”') return 0.46
  const isLower = ch !== ch.toUpperCase()
  const isUpper = ch !== ch.toLowerCase()
  // Chinese, kana, punctuation, signs, emoji: a full square
  if (!isLower && !isUpper) return 1
  // letters with accents; past them Greek and Cyrillic, whose capitals run wider than a square
  if (c < 0x250) return isLower ? 0.82 : 1
  return isLower ? 0.88 : 1.15
}

/** How wide `s` runs at `fs`, with `spacing` px after each letter: what the layout takes a text to be. */
export function serifWidth(s: string, fs: number, spacing = 0): number {
  let w = 0
  for (const ch of s) w += serifEm(ch) * fs + spacing
  return w
}

/** `s` whole when it runs no wider than `maxPx`, else cut to end with … inside it. */
function cut(s: string, fs: number, maxPx: number, spacing = 0): string {
  if (!s || maxPx <= 0) return ''
  if (serifWidth(s, fs, spacing) <= maxPx) return s
  const room = maxPx - serifWidth('…', fs, spacing)
  if (room < 0) return ''
  let out = ''
  let w = 0
  for (const ch of s) {
    const g = serifEm(ch) * fs + spacing
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
function twoLines(s: string, fs: number, maxPx: number): string[] {
  if (!s) return []
  const total = serifWidth(s, fs)
  if (total <= maxPx) return [s]
  const chars = Array.from(s)
  const target = total <= maxPx * 2 ? total / 2 : maxPx
  let w = 0
  let at = 0
  while (at < chars.length && w < target) {
    const g = serifEm(chars[at] ?? '') * fs
    if (w + g > maxPx) break
    w += g
    at++
  }
  if (at === 0) return [cut(s, fs, maxPx)].filter(Boolean)
  for (let i = at; i >= at / 3 && i > 0; i--) {
    if (chars[i] === ' ') {
      at = i
      break
    }
  }
  const first = chars.slice(0, at).join('').trimEnd()
  const rest = cut(chars.slice(at).join('').trimStart(), fs, maxPx)
  return rest ? [first, rest] : [first]
}

// ---------- markup ----------

/** How a text is set: centred on its x, `spacing` px after each letter, in a heavier weight. */
type Hand = { centred?: boolean; spacing?: number; weight?: 600 }

function write(x: number, y: number, fs: number, fill: string, s: string, hand: Hand = {}): string {
  if (!s) return ''
  const spacing = hand.spacing ?? 0
  // the spacing follows the last letter too: a centred line is set back by half of it
  const at = hand.centred ? x + spacing / 2 : x
  return (
    `<text x="${num(at)}" y="${num(y)}" font-size="${fs}" fill="${fill}"` +
    (hand.centred ? ` text-anchor="middle"` : '') +
    (spacing > 0 ? ` letter-spacing="${num(spacing)}"` : '') +
    (hand.weight ? ` font-weight="${hand.weight}"` : '') +
    `>${esc(s)}</text>`
  )
}

function line(d: string, stroke: string, width: number): string {
  return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}"/>`
}

/**
 * A frame `g` px inside the box, each corner cut by an arc round the box's
 * own corner (`r` out from it, and `g` more): frames of one box nest evenly.
 */
function notchedFrame(x0: number, y0: number, x1: number, y1: number, r: number, g: number, stroke: string): string {
  const a = r + g
  const k = Math.sqrt(a * a - g * g)
  const arc = `A${num(a)} ${num(a)} 0 0 0`
  return line(
    `M${num(x0 + k)} ${num(y0 + g)} H${num(x1 - k)} ${arc} ${num(x1 - g)} ${num(y0 + k)}` +
      ` V${num(y1 - k)} ${arc} ${num(x1 - k)} ${num(y1 - g)}` +
      ` H${num(x0 + k)} ${arc} ${num(x0 + g)} ${num(y1 - k)}` +
      ` V${num(y0 + k)} ${arc} ${num(x0 + k)} ${num(y0 + g)} Z`,
    stroke,
    1,
  )
}

/**
 * A small fan in the notch of each of a box's corners: its point on the
 * corner, opening into the box, `r` long, two ribs down it.
 */
function cornerFans(x0: number, y0: number, x1: number, y1: number, r: number): string {
  const corners: readonly (readonly [number, number, number, number])[] = [
    [x0, y0, 1, 1],
    [x1, y0, -1, 1],
    [x1, y1, -1, -1],
    [x0, y1, 1, -1],
  ]
  const leaf = corners.map(([cx, cy, sx, sy]) => `M${num(cx)} ${num(cy)} L${num(cx + sx * r)} ${num(cy)} A${num(r)} ${num(r)} 0 0 ${sx * sy > 0 ? 1 : 0} ${num(cx)} ${num(cy + sy * r)} Z`)
  const ribs = corners.map(([cx, cy, sx, sy]) =>
    [30, 60].map(deg => `M${num(cx)} ${num(cy)} L${num(cx + sx * r * Math.cos((deg * Math.PI) / 180))} ${num(cy + sy * r * Math.sin((deg * Math.PI) / 180))}`).join(' '),
  )
  return `<path d="${leaf.join(' ')}" fill="${FOLIO.brassLight}" stroke="${FOLIO.gold}" stroke-width="1"/>` + line(ribs.join(' '), FOLIO.gold, 0.75)
}

/** A brass plate with a rivet at each end: ATLAS over ARCHIVE engraved on it. */
function brassPlate(x: number, y: number): string {
  const cy = y + SIDE_H / 2
  const rivet = (cx: number) => `<circle cx="${num(cx)}" cy="${num(cy)}" r="2" fill="${FOLIO.brassLight}" stroke="${FOLIO.brassShade}" stroke-width="0.75"/>`
  return (
    rectEl(x, y, PLATE_W, SIDE_H, `rx="4" fill="${FOLIO.brass}" stroke="${FOLIO.brassShade}" stroke-width="1"`) +
    rectEl(x + 2.5, y + 2.5, PLATE_W - 5, SIDE_H - 5, `rx="2" fill="none" stroke="${FOLIO.brassLight}" stroke-width="0.75"`) +
    rivet(x + 7.5) +
    rivet(x + PLATE_W - 7.5) +
    write(x + PLATE_W / 2, y + 14.5, 11, FOLIO.brassInk, 'ATLAS', { centred: true, spacing: 1.5, weight: 600 }) +
    write(x + PLATE_W / 2, y + 27, 11, FOLIO.brassInk, 'ARCHIVE', { centred: true, spacing: 1, weight: 600 })
  )
}

/** A wax seal centred on (cx, cy): a disc with an uneven edge, a ring pressed into it and a spark in the ring. */
function waxSeal(cx: number, cy: number): string {
  const pts = SEAL_EDGE.map((k, i) => {
    const a = (i / SEAL_EDGE.length) * Math.PI * 2
    return [cx + Math.cos(a) * SEAL_R * k, cy + Math.sin(a) * SEAL_R * k] as const
  })
  const at = (i: number) => pts[i % pts.length] ?? ([cx, cy] as const)
  const between = (i: number) => `${num((at(i)[0] + at(i + 1)[0]) / 2)} ${num((at(i)[1] + at(i + 1)[1]) / 2)}`
  let d = `M${between(pts.length - 1)}`
  pts.forEach((p, i) => {
    d += ` Q${num(p[0])} ${num(p[1])} ${between(i)}`
  })
  return (
    `<path d="${d} Z" fill="${FOLIO.wine}"/>` +
    `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(SEAL_R - 5)}" fill="none" stroke="${FOLIO.wineDeep}" stroke-width="1.25"/>` +
    spark(cx, cy, SEAL_R - 8.5, FOLIO.wineLight)
  )
}

/**
 * A swatch of cloth from `x` to `x + len`, `h` tall (a multiple of 4): flat,
 * its right end pinked into points 4px apart and `depth` px deep.
 */
function swatch(x: number, top: number, len: number, h: number, depth: number, fill: string): string {
  const end = depth > 0 ? ` l${num(depth)} 2 l${num(-depth)} 2`.repeat(h / 4) : ` v${num(h)}`
  return `<path d="M${num(x)} ${num(top)} H${num(x + len - depth)}${end} H${num(x)} Z" fill="${fill}"/>`
}

/** A ticket stub: a filled strip with a half-round bite out of each end, a fine rule along its top and its bottom. */
function stub(x: number, top: number, w: number, h: number, fill: string): string {
  const r = 4
  const mid = top + h / 2
  const bite = `A${r} ${r} 0 0 0`
  return (
    `<path d="M${num(x)} ${num(top)} H${num(x + w)} V${num(mid - r)} ${bite} ${num(x + w)} ${num(mid + r)} V${num(top + h)}` +
    ` H${num(x)} V${num(mid + r)} ${bite} ${num(x)} ${num(mid - r)} Z" fill="${fill}"/>` +
    line(`M${num(x + 3)} ${num(top + 2.5)} H${num(x + w - 3)} M${num(x + 3)} ${num(top + h - 2.5)} H${num(x + w - 3)}`, FOLIO.goldSoft, 0.75)
  )
}

type Box = { x0: number; x1: number; y0: number; y1: number }

/** Two boxes keep `gap` px between them, across or up and down. */
function apart(a: Box, b: Box, gap: number): boolean {
  return a.x1 + gap <= b.x0 || b.x1 + gap <= a.x0 || a.y1 + gap <= b.y0 || b.y1 + gap <= a.y0
}

// ---------- the page ----------

export function folioSvg(spec: JournalSpec): { source: string; alt: string; width: number; height: number } {
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
    tone: FOLIO_TONES[pick(CARD_TONES, n.tone, CARD_ORDER[i % CARD_ORDER.length] ?? 'yellow')],
  }))
  const bars = list(spec.bars, MAX_BARS).map(b => {
    const value = worth(b.value)
    return { label: clean(b.label), value, text: b.text === undefined ? plainNumber(value) : clean(b.text) }
  })
  const stamps = list(spec.stamps, MAX_STAMPS)
    .map((s, i) => ({ text: clean(s.text), color: pick(STUB_COLORS, s.tone, STUB_ORDER[i % STUB_ORDER.length] ?? 'coral') }))
    .filter(s => s.text !== '')
  const drawn = (s: string) => fit(s, MAX_CELLS)

  // The paper, and the frame a little inside it.
  const paperX = 6
  const paperTop = 6
  const frameIn = 6
  const frameGap = small ? 3 : 4
  const notch = grow(8, 11)
  const inner = grow(18, 34)
  const L = paperX + inner
  const R = W - paperX - inner
  const CW = R - L
  const mid = W / 2
  const gapY = grow(14, 22)
  const out: string[] = []

  // ---- the head: an ornament, the title, the subtitle between two short rules ----
  const ornY = paperTop + grow(20, 26)
  const ornArm = grow(22, 40)
  const titleFs = grow(20, 30)
  const subFs = small ? 12 : 13
  const subSpacing = 1
  const titleText = cut(drawn(title), titleFs, CW - 8)
  const subText = cut(drawn(subtitle), subFs, CW, subSpacing)
  const subW = serifWidth(subText, subFs, subSpacing)
  // a rule's lozenge and the gaps on its two sides take 13px
  const flank = Math.min(grow(16, 30), Math.floor((CW - subW) / 2) - 13)
  const hasFlanks = subText !== '' && flank >= 8

  const rows: Box[] = [{ x0: mid - 16 - ornArm, x1: mid + 16 + ornArm, y0: ornY - 5, y1: ornY + 5 }]
  let y = ornY + 6
  let titleBase = y
  if (titleText) {
    titleBase = y + grow(6, 9) + Math.round(titleFs * 0.78)
    y = titleBase + Math.round(titleFs * 0.22)
    const half = serifWidth(titleText, titleFs) / 2
    rows.push({ x0: mid - half, x1: mid + half, y0: titleBase - titleFs * 0.85, y1: y })
  }
  let subBase = y
  let subRow: Box | undefined
  if (subText) {
    subBase = y + grow(5, 7) + Math.round(subFs * 0.8)
    y = subBase + Math.round(subFs * 0.25)
    const half = subW / 2 + (hasFlanks ? flank + 13 : 0)
    subRow = { x0: mid - half, x1: mid + half, y0: subBase - subFs * 0.85, y1: y }
    rows.push(subRow)
  }

  // The plate at the far left and the seal at the far right: both or neither.
  const sideTopMost = paperTop + frameIn + frameGap + 5
  const plateBox = (cy: number): Box => ({ x0: L, x1: L + PLATE_W, y0: cy - SIDE_H / 2, y1: cy + SIDE_H / 2 })
  const sealBox = (cy: number): Box => ({ x0: R - SEAL_R * 2 - 1, x1: R, y0: cy - SIDE_H / 2 - 1, y1: cy + SIDE_H / 2 + 1 })
  let sideCy = titleText ? titleBase - titleFs * 0.33 : ornY
  // beside the title when the subtitle is clear of them there, else lifted above the subtitle
  if (subRow && !(apart(plateBox(sideCy), subRow, SIDE_CLEAR) && apart(sealBox(sideCy), subRow, SIDE_CLEAR))) {
    sideCy = Math.min(sideCy, Math.floor(subRow.y0 - SIDE_CLEAR - SIDE_H / 2 - 1))
  }
  sideCy = Math.round(Math.max(sideCy, sideTopMost + SIDE_H / 2))
  const hasSides = rows.every(row => apart(plateBox(sideCy), row, SIDE_CLEAR) && apart(sealBox(sideCy), row, SIDE_CLEAR))

  out.push(
    '<g class="head">',
    hairline(mid - 16 - ornArm, mid - 16, ornY, FOLIO.gold),
    lozenge(mid - 11, ornY, 2, FOLIO.gold),
    spark(mid, ornY, 5, FOLIO.wine),
    lozenge(mid + 11, ornY, 2, FOLIO.gold),
    hairline(mid + 16, mid + 16 + ornArm, ornY, FOLIO.gold),
    write(mid, titleBase, titleFs, FOLIO.wineDeep, titleText, { centred: true }),
    write(mid, subBase, subFs, FOLIO.inkSoft, subText, { centred: true, spacing: subSpacing }),
  )
  if (hasFlanks) {
    const ruleY = subBase - Math.round(subFs * 0.36)
    const left = mid - subW / 2 - 8
    const right = mid + subW / 2 + 8
    out.push(
      hairline(left - 5 - flank, left - 5, ruleY, FOLIO.gold),
      lozenge(left - 2, ruleY, 2, FOLIO.gold),
      lozenge(right + 2, ruleY, 2, FOLIO.gold),
      hairline(right + 5, right + 5 + flank, ruleY, FOLIO.gold),
    )
  }
  if (hasSides) {
    out.push('<g class="plate">', brassPlate(L, sideCy - SIDE_H / 2), '</g>', '<g class="seal">', waxSeal(R - SEAL_R - 0.5, sideCy), '</g>')
    y = Math.max(y, sideCy + SIDE_H / 2 + 2)
  }
  out.push('</g>')

  // ---- index cards ----
  if (notes.length > 0) {
    const gap = grow(6, 18)
    const pad = grow(9, 15)
    const n = notes.length
    const noteW = Math.min((CW - gap * (n - 1)) / n, 190)
    const rowX = L + (CW - noteW * n - gap * (n - 1)) / 2
    const box = noteW - pad * 2
    const maxBig = grow(21, 29)
    const minBig = small ? 12 : 14
    const labelFs = small ? 11 : 13
    const laid = notes.map(note => {
      const big = drawn(note.big)
      const unit = serifWidth(big, 1)
      const bigFs = unit > 0 ? Math.min(maxBig, Math.max(minBig, Math.floor(box / unit))) : maxBig
      return { tone: note.tone, bigFs, big: cut(big, bigFs, box), lines: twoLines(drawn(note.label), labelFs, box) }
    })
    const lineCount = Math.max(0, ...laid.map(l => l.lines.length))
    const tabW = 30
    const tabH = 16
    const top = y + gapY + tabH / 2
    const bigBase = top + tabH / 2 + grow(7, 10) + Math.round(maxBig * 0.8)
    const labelBase = bigBase + labelFs + grow(7, 11)
    const linePitch = labelFs + 4
    const bottom = lineCount > 0 ? labelBase + (lineCount - 1) * linePitch + grow(10, 16) : bigBase + grow(13, 18)
    out.push('<g class="cards">')
    laid.forEach((note, i) => {
      const x = rowX + i * (noteW + gap)
      const tabX = x + pad - 1
      out.push(
        '<g class="card">',
        rectEl(x, top, noteW, bottom - top, `rx="2" fill="${note.tone.pale}" stroke="${note.tone.deep}" stroke-width="1"`),
        rectEl(x + 3, top + 3, noteW - 6, bottom - top - 6, `fill="none" stroke="${FOLIO.gold}" stroke-width="0.75"`),
        rectEl(tabX, top - tabH / 2, tabW, tabH, `rx="2" fill="${FOLIO.wine}"`),
        write(tabX + tabW / 2, top + 4, 11, FOLIO.cream, `0${i + 1}.`, { centred: true, weight: 600 }),
        write(x + pad, bigBase, note.bigFs, note.tone.ink, note.big),
        ...note.lines.map((text, k) => write(x + pad, labelBase + k * linePitch, labelFs, note.tone.ink, text)),
        '</g>',
      )
    })
    out.push('</g>')
    y = bottom
  }

  // ---- the swatches ----
  if (bars.length > 0) {
    const fs = small ? 12 : 13
    y += gapY
    out.push('<g class="bars">')
    const headFs = grow(14, 17)
    // the heading leaves room for a short rule after it
    const heading = cut(drawn(barsTitle), headFs, CW - 16 - 36)
    if (heading) {
      y += headFs + 2
      const ruleY = y - Math.round(headFs * 0.34)
      const ruleX = L + 16 + Math.ceil(serifWidth(heading, headFs)) + 10
      out.push(
        spark(L + 5, ruleY, 5, FOLIO.wine),
        write(L + 16, y, headFs, FOLIO.wineDeep, heading),
        hairline(ruleX, R - 5, ruleY, FOLIO.gold),
        lozenge(R - 2, ruleY, 2, FOLIO.gold),
      )
      y += grow(11, 16)
    }
    const barH = small ? 16 : 20
    const pitch = barH + grow(9, 13)
    const labels = bars.map(b => cut(drawn(b.label), fs, Math.floor(CW * 0.36)))
    const texts = bars.map(b => cut(drawn(b.text), fs, Math.floor(CW * 0.3)))
    const labelW = Math.ceil(Math.max(0, ...labels.map(s => serifWidth(s, fs))))
    const textW = Math.ceil(Math.max(0, ...texts.map(s => serifWidth(s, fs))))
    const barX = L + (labelW > 0 ? labelW + 10 : 0)
    const room = R - barX - (textW > 0 ? textW + 8 : 0) - 2
    const most = Math.max(0, ...bars.map(b => b.value))
    bars.forEach((bar, i) => {
      const top = y + i * pitch
      const base = Math.round(top + barH / 2 + fs * 0.34)
      const color = FOLIO_TONES[SWATCH_ORDER[i % SWATCH_ORDER.length] ?? 'rose'].deep
      const len = most > 0 && bar.value > 0 ? Math.max(4, (bar.value / most) * room) : 0
      out.push('<g class="row">', write(L, base, fs, FOLIO.ink, labels[i] ?? ''))
      if (len > 0) {
        out.push(swatch(barX, top, len, barH, len < 8 ? 0 : len < 20 ? 1.5 : 3, color))
      } else {
        out.push(`<path d="M${num(barX)} ${num(top + 1)} V${num(top + barH - 1)}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>`)
      }
      out.push(write(barX + len + 8, base, fs, FOLIO.inkSoft, texts[i] ?? ''), '</g>')
    })
    out.push('</g>')
    y += (bars.length - 1) * pitch + barH
  }

  // ---- ticket stubs, to the right, wrapping to more rows when they must ----
  if (stamps.length > 0) {
    const fs = 12
    const h = 24
    const gap = 8
    const padX = grow(12, 15)
    /** The stubs in rows, none wider than `widest`. */
    const inRows = (widest: number) => {
      const tags = stamps.map(s => {
        const text = cut(drawn(s.text), fs, widest - padX * 2)
        return { text, color: s.color, w: Math.max(48, Math.ceil(serifWidth(text, fs)) + padX * 2) }
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
    out.push('<g class="stubs">')
    laid.forEach((row, k) => {
      const top = y + k * (h + gap)
      const width = row.reduce((sum, tag) => sum + tag.w, 0) + gap * (row.length - 1)
      let x = R - width
      const ruleW = Math.min(120, x - L - 16)
      if (k === 0 && ruleW >= 80) out.push(ornamentRule(L, L + ruleW, top + h / 2))
      for (const tag of row) {
        out.push(stub(x, top, tag.w, h, tag.color), write(x + tag.w / 2, top + 16.5, fs, FOLIO.cream, tag.text, { centred: true }))
        x += tag.w + gap
      }
    })
    out.push('</g>')
    y += laid.length * h + (laid.length - 1) * gap
  }

  const paperBottom = Math.ceil(y + grow(20, 26))
  const H = paperBottom + 6
  const paperW = W - paperX * 2
  const paperH = paperBottom - paperTop

  // The frame: a gold line and a fainter one inside it, a fan in each corner's notch.
  const fx0 = paperX + frameIn
  const fy0 = paperTop + frameIn
  const fx1 = W - paperX - frameIn
  const fy1 = paperBottom - frameIn

  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" font-family="${FOLIO_FONT}">` +
    `<title>${esc(fit(title, ALT_CELLS) || '档案')}</title>` +
    `<g class="paper">` +
    rectEl(paperX, paperTop, paperW, paperH, `rx="5" fill="${FOLIO.paper}" stroke="${FOLIO.paperEdge}" stroke-width="1"`) +
    `</g>` +
    `<g class="frame">` +
    notchedFrame(fx0, fy0, fx1, fy1, notch, 0, FOLIO.gold) +
    notchedFrame(fx0, fy0, fx1, fy1, notch, frameGap, FOLIO.goldSoft) +
    cornerFans(fx0, fy0, fx1, fy1, notch - 2.5) +
    `</g>` +
    out.join('') +
    `</svg>`

  // ---- the same page in words ----
  const said = (s: string) => fit(s, ALT_CELLS)
  const pair = (a: string, b: string) => [said(a), said(b)].filter(Boolean).join(' ')
  const parts = [`档案页插图「${said(title)}」${subtitle ? `（${said(subtitle)}）` : ''}`]
  const noteWords = notes.map(n => pair(n.big, n.label)).filter(Boolean)
  if (noteWords.length > 0) parts.push(`卡片：${noteWords.join('、')}`)
  const barWords = bars.map(b => pair(b.label, b.text)).filter(Boolean)
  if (barWords.length > 0) parts.push(`${said(barsTitle) || '条形图'}：${barWords.join('、')}`)
  if (stamps.length > 0) parts.push(`标签：${stamps.map(s => said(s.text)).join('、')}`)
  const alt = parts.join('；') + '。'

  return { source, alt, width: W, height: H }
}
