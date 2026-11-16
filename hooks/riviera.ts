// A 地中海 page as one SVG string: the page journal.ts draws, set as a page of
// a magazine by the sea. White paper under an awning's stripes, a masthead
// (a letter-spaced kicker over a very large title, a sun over the sea beside
// them) closed by a thick-and-thin rule, figures in columns, thin flat bars,
// square tags, a strip of tiles at the foot. Everything stands on one left
// edge. It takes journal's spec and keeps journal's contract. Pure: no `$`,
// no clock, no randomness.

import { ALT_CELLS, MAX_BARS, MAX_CELLS, MAX_NOTES, MAX_STAMPS, MAX_W, MIN_W, clampWidth, clean, esc, list, num, pick, plainNumber, rectEl, worth } from './journal'
import type { JournalSpec, JournalStamp, JournalTone } from './journal'
import { RIVIERA, RIVIERA_DISPLAY, RIVIERA_SANS, awning, fineRule, scotchRule, tileStrip, waves } from './riviera-look'
import { fit } from './text'

// ---------- the look ----------

/** The bar over a figure for each of journal's note tones, and the order they come in when none is asked for. */
const FIGURE_COLORS: Record<JournalTone, string> = { yellow: RIVIERA.lemon, pink: RIVIERA.coral, mint: RIVIERA.aqua, blue: RIVIERA.azure, purple: RIVIERA.periwinkle }
const FIGURE_ORDER: readonly JournalTone[] = ['yellow', 'pink', 'mint', 'blue', 'purple']

const BAR_COLORS: readonly string[] = [RIVIERA.cobalt, RIVIERA.azure, RIVIERA.sky, RIVIERA.aqua, RIVIERA.periwinkle, RIVIERA.lemon]

type StampTone = NonNullable<JournalStamp['tone']>
/** A tag's line and its writing: the deep tones, which read on white where the bright ones do not. */
const TAG_COLORS: Record<StampTone, string> = { coral: RIVIERA.coralDeep, purple: RIVIERA.periwinkleDeep, teal: RIVIERA.aquaDeep }
const TAG_ORDER: readonly StampTone[] = ['coral', 'purple', 'teal']

/** How tall the awning is, how far it and the tiles stand from the paper's edge, and a tile's side. */
const AWNING_H = 9
const EDGE = 2
const TILE = 12

// ---------- text ----------

/** A face's measure: how wide each of ASCII's printing characters (space to ~) runs in it, in hundredths of an em. */
type Face = readonly number[]

/**
 * The display stack: per character, the widest of Didot, Bodoni 72 and
 * Georgia, each in its roman, its italic and its bold, as the faces measure.
 */
const DISPLAY: Face = [
  28, 38, 57, 71, 67, 88, 86, 36, 45, 45, 60, 71, 33, 38, 33, 54, 71, 57, 63, 63, 65, 60, 65, 57, 68, 65, 39, 39, 71, 71, 71, 55,
  99, 76, 76, 73, 84, 73, 69, 81, 92, 45, 60, 82, 73, 103, 84, 84, 71, 84, 80, 67, 71, 84, 77, 113, 81, 74, 69, 45, 58, 45, 71, 71,
  52, 60, 65, 54, 67, 58, 40, 58, 68, 36, 35, 64, 35, 102, 69, 64, 66, 65, 52, 52, 40, 68, 57, 87, 59, 57, 53, 50, 52, 50, 71,
]

/**
 * The sans stack, in its regular weight: per character, the wider of Avenir
 * Next and Helvetica Neue as they measure, raised to Segoe UI's where that
 * face is known to run wider (it was not at hand to measure).
 */
const SANS: Face = [
  28, 33, 43, 60, 58, 100, 80, 28, 31, 31, 45, 69, 28, 40, 28, 39, 58, 58, 58, 58, 58, 58, 58, 58, 58, 58, 30, 30, 69, 69, 69, 56,
  96, 70, 69, 73, 76, 62, 58, 78, 73, 27, 52, 67, 56, 90, 77, 85, 65, 85, 69, 65, 58, 73, 63, 98, 65, 65, 62, 31, 38, 31, 69, 50,
  27, 54, 64, 54, 64, 58, 32, 64, 59, 25, 26, 52, 26, 89, 59, 62, 64, 64, 36, 50, 34, 59, 50, 76, 52, 50, 48, 34, 24, 34, 69,
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

/** How a text is set: in the sans (else the display face), slanted, heavy, `spacing` px after each letter, centred on its x. */
type Hand = { sans?: boolean; italic?: boolean; bold?: boolean; spacing?: number; centred?: boolean }

function write(x: number, y: number, fs: number, fill: string, s: string, hand: Hand = {}): string {
  if (!s) return ''
  const spacing = hand.spacing ?? 0
  // the spacing follows the last letter too: a centred line is set back by half of it
  const at = hand.centred ? x + spacing / 2 : x
  return (
    `<text x="${num(at)}" y="${num(y)}" font-size="${fs}" fill="${fill}"` +
    (hand.sans ? ` font-family="${RIVIERA_SANS}"` : '') +
    (hand.italic ? ` font-style="italic"` : '') +
    (hand.bold ? ` font-weight="700"` : '') +
    (hand.centred ? ` text-anchor="middle"` : '') +
    (spacing > 0 ? ` letter-spacing="${num(spacing)}"` : '') +
    `>${esc(s)}</text>`
  )
}

/** A length a pattern repeats by: three decimals, so a row of them does not drift. */
function fine(v: number): string {
  const r = Math.round(v * 1000) / 1000
  return Number.isFinite(r) ? String(r === 0 ? 0 : r) : '0'
}

/**
 * A band `w` wide filled with what `piece` draws, repeated every `step` px:
 * a flat cobalt rect, and over it one the repeat fills. Drawn piece by piece
 * the awning and the tiles would be most of the page's markup; as two
 * repeats they are a few hundred characters.
 */
function repeated(id: string, x: number, y: number, w: number, h: number, step: number, piece: string): { def: string; band: string } {
  return {
    def: `<pattern id="${id}" x="${num(x)}" y="${num(y)}" width="${fine(step)}" height="${num(h)}" patternUnits="userSpaceOnUse">${piece}</pattern>`,
    band: rectEl(x, y, w, h, `fill="${RIVIERA.cobalt}"`) + rectEl(x, y, w, h, `fill="url(#${id})"`),
  }
}

/** A sun over the sea, centred on (cx, cy): a lemon disc, two lines of waves across its lower part, `reach` px to each side at their widest. */
function sun(cx: number, cy: number, r: number, reach: number): string {
  const length = (reach * 2) / 5
  return (
    `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}" fill="${RIVIERA.lemon}"/>` +
    waves(cx - reach, cx + reach + 0.5, cy + r * 0.3, length, 3, RIVIERA.cobalt, 1.5) +
    waves(cx - length * 1.5, cx + length * 1.5 + 0.5, cy + r * 0.68, length, 3, RIVIERA.azure, 1.5)
  )
}

type Box = { x0: number; x1: number; y0: number; y1: number }

/** Two boxes keep `gap` px between them, across or up and down. */
function apart(a: Box, b: Box, gap: number): boolean {
  return a.x1 + gap <= b.x0 || b.x1 + gap <= a.x0 || a.y1 + gap <= b.y0 || b.y1 + gap <= a.y0
}

// ---------- the page ----------

export function rivieraSvg(spec: JournalSpec): { source: string; alt: string; width: number; height: number } {
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
    color: pick(FIGURE_COLORS, n.tone, FIGURE_ORDER[i % FIGURE_ORDER.length] ?? 'yellow'),
  }))
  const bars = list(spec.bars, MAX_BARS).map(b => {
    const value = worth(b.value)
    return { label: clean(b.label), value, text: b.text === undefined ? plainNumber(value) : clean(b.text) }
  })
  const stamps = list(spec.stamps, MAX_STAMPS)
    .map((s, i) => ({ text: clean(s.text), color: pick(TAG_COLORS, s.tone, TAG_ORDER[i % TAG_ORDER.length] ?? 'coral') }))
    .filter(s => s.text !== '')
  const drawn = (s: string) => fit(s, MAX_CELLS)

  // The paper, and the one left edge everything stands on.
  const paperX = 6
  const paperTop = 6
  const inner = grow(20, 40)
  const L = paperX + inner
  const R = W - paperX - inner
  const CW = R - L
  const gapY = grow(18, 28)
  const out: string[] = []

  // ---- the awning: stripes across the top, cobalt at both ends ----
  const bandX = paperX + EDGE
  const bandW = W - bandX * 2
  const awningY = paperTop + EDGE
  const stripes = Math.round(bandW / 20) * 2 + 1
  const stripe = bandW / stripes
  const shade = repeated('atlas-riviera-awning', bandX, awningY, bandW, AWNING_H, stripe * 2, awning(0, 0, stripe * 2, AWNING_H, stripe))

  // ---- the masthead: a kicker, the title very large, a sun beside them, a thick-and-thin rule under all ----
  const kickFs = small ? 11 : 12
  const kickSpacing = small ? 1.5 : 2
  const kicker = cut(drawn(subtitle), kickFs, CW, SANS, kickSpacing)
  const titleMax = grow(40, 64)
  const titleUnit = displayWidth(drawn(title), 1)
  // a long title is set smaller before it is cut
  const titleFs = titleUnit > 0 ? Math.min(titleMax, Math.max(grow(26, 36), Math.floor(CW / titleUnit))) : titleMax
  const titleText = cut(drawn(title), titleFs, CW, DISPLAY)

  const mastTop = awningY + AWNING_H + grow(18, 28)
  let y = mastTop
  const written: Box[] = []
  let kickBase = y
  if (kicker) {
    kickBase = y + Math.round(kickFs * 0.8)
    y = kickBase + Math.round(kickFs * 0.25)
    written.push({ x0: L, x1: L + sansWidth(kicker, kickFs, kickSpacing), y0: kickBase - kickFs * 0.85, y1: y })
  }
  let titleBase = y
  if (titleText) {
    titleBase = y + (kicker ? grow(6, 9) : 0) + Math.round(titleFs * 0.8)
    y = titleBase + Math.round(titleFs * 0.2)
    written.push({ x0: L, x1: L + displayWidth(titleText, titleFs), y0: titleBase - titleFs * 0.85, y1: y })
  }
  const sunR = grow(15, 24)
  const sunReach = sunR + 5
  const sunCx = R - sunReach
  const sunCy = Math.round(Math.max(mastTop + sunR, titleText ? titleBase - titleFs * 0.36 : mastTop + sunR))
  const sunBox: Box = { x0: sunCx - sunReach, x1: R, y0: sunCy - sunR, y1: sunCy + sunR }
  const hasSun = written.every(box => apart(sunBox, box, 12))

  out.push('<g class="masthead">', write(L, kickBase, kickFs, RIVIERA.cobalt, kicker, { sans: true, spacing: kickSpacing }), write(L, titleBase, titleFs, RIVIERA.navy, titleText))
  if (hasSun) {
    out.push('<g class="sun">', sun(sunCx, sunCy, sunR, sunReach), '</g>')
    y = Math.max(y, sunCy + sunR + 2)
  }
  y += grow(10, 14)
  out.push(scotchRule(L, R, y), '</g>')
  y += 7

  // ---- figures, in columns of one width with a hairline between them ----
  if (notes.length > 0) {
    const n = notes.length
    const gap = grow(18, 32)
    const colW = (CW - gap * (n - 1)) / n
    const maxBig = grow(28, 44)
    const minBig = small ? 14 : 16
    const labelFs = small ? 11 : 12
    const laid = notes.map(note => {
      const big = drawn(note.big)
      const unit = displayWidth(big, 1)
      const bigFs = unit > 0 ? Math.min(maxBig, Math.max(minBig, Math.floor(colW / unit))) : maxBig
      return { color: note.color, bigFs, big: cut(big, bigFs, colW, DISPLAY), lines: twoLines(drawn(note.label), labelFs, colW, SANS) }
    })
    const lineCount = Math.max(0, ...laid.map(l => l.lines.length))
    const markH = 4
    const markW = grow(22, 32)
    const top = y + grow(16, 24)
    const bigBase = top + markH + grow(8, 12) + Math.round(maxBig * 0.76)
    const labelBase = bigBase + grow(8, 11) + labelFs
    const linePitch = labelFs + 4
    const bottom = lineCount > 0 ? labelBase + (lineCount - 1) * linePitch + 4 : bigBase + Math.round(maxBig * 0.22)
    out.push('<g class="figures">')
    laid.forEach((note, i) => {
      const x = L + i * (colW + gap)
      out.push('<g class="figure">')
      if (i > 0) out.push(`<path d="M${num(x - gap / 2)} ${num(top)} V${num(bottom)}" fill="none" stroke="${RIVIERA.rule}" stroke-width="1"/>`)
      out.push(
        rectEl(x, top, markW, markH, `fill="${note.color}"`),
        write(x, bigBase, note.bigFs, RIVIERA.navy, note.big),
        ...note.lines.map((text, k) => write(x, labelBase + k * linePitch, labelFs, RIVIERA.inkSoft, text, { sans: true })),
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
    const heading = cut(drawn(barsTitle), headFs, CW - 14 - 30, DISPLAY)
    if (heading) {
      y += headFs
      const ruleY = y - Math.round(headFs * 0.32)
      out.push(
        rectEl(L, ruleY - 3.5, 7, 7, `fill="${RIVIERA.cobalt}"`),
        write(L + 14, y, headFs, RIVIERA.navy, heading, { bold: true }),
        fineRule(L + 14 + Math.ceil(displayWidth(heading, headFs)) + 10, R, ruleY),
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
      const color = BAR_COLORS[i % BAR_COLORS.length] ?? RIVIERA.cobalt
      const len = most > 0 && bar.value > 0 ? Math.max(4, (bar.value / most) * room) : 0
      out.push('<g class="row">', write(L, base, fs, RIVIERA.navy, labels[i] ?? '', { sans: true }))
      if (len > 0) out.push(rectEl(barX, top, len, barH, `fill="${color}"`))
      else out.push(`<path d="M${num(barX)} ${num(top)} V${num(top + barH)}" fill="none" stroke="${color}" stroke-width="1.5"/>`)
      out.push(write(barX + len + 8, base, textFs, RIVIERA.cobalt, texts[i] ?? '', { italic: true }), '</g>')
    })
    out.push('</g>')
    y += (bars.length - 1) * pitch + barH
  }

  // ---- tags, to the right, wrapping to more rows when they must ----
  if (stamps.length > 0) {
    const fs = small ? 11 : 12
    const spacing = 0.6
    const h = 24
    const gap = 8
    const padX = grow(9, 12)
    /** The tags in rows, none wider than `widest`. */
    const inRows = (widest: number) => {
      const tags = stamps.map(s => {
        const text = cut(drawn(s.text), fs, widest - padX * 2, SANS, spacing)
        return { text, color: s.color, w: Math.max(40, Math.ceil(sansWidth(text, fs, spacing)) + padX * 2) }
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
      // a short line of waves left of the first row: whole waves, six at most, when three or more fit
      const crests = Math.min(6, Math.floor((x - L - 16) / 16))
      if (k === 0 && crests >= 3) out.push(waves(L, L + crests * 16 + 0.5, top + h / 2 + 1, 16, 4))
      for (const tag of row) {
        out.push(
          rectEl(x + 0.5, top + 0.5, tag.w - 1, h - 1, `fill="none" stroke="${tag.color}" stroke-width="1"`),
          write(x + tag.w / 2, top + Math.round(h / 2 + fs * 0.36), fs, tag.color, tag.text, { sans: true, spacing, centred: true }),
        )
        x += tag.w + gap
      }
    })
    out.push('</g>')
    y += laid.length * h + (laid.length - 1) * gap
  }

  // ---- the foot: a strip of whole tiles along the bottom, a cobalt one at both ends ----
  const fits = Math.floor(bandW / TILE)
  const tiles = fits % 2 === 0 ? fits - 1 : fits
  const tilesX = paperX + (W - paperX * 2 - tiles * TILE) / 2
  const tilesY = Math.ceil(y + grow(20, 28))
  const tiling = repeated('atlas-riviera-tiles', tilesX, tilesY, tiles * TILE, TILE, TILE * 2, tileStrip(0, 0, TILE, 2))

  const paperBottom = tilesY + TILE + EDGE
  const H = paperBottom + 6
  const paperW = W - paperX * 2
  const paperH = paperBottom - paperTop

  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" font-family="${RIVIERA_DISPLAY}">` +
    `<title>${esc(fit(title, ALT_CELLS) || '杂志页')}</title>` +
    `<defs>${shade.def}${tiling.def}</defs>` +
    `<g class="paper">` +
    rectEl(paperX, paperTop, paperW, paperH, `rx="3" fill="${RIVIERA.paper}" stroke="${RIVIERA.rule}" stroke-width="1"`) +
    `</g>` +
    `<g class="awning">${shade.band}</g>` +
    out.join('') +
    `<g class="foot">${tiling.band}</g>` +
    `</svg>`

  // ---- the same page in words ----
  const said = (s: string) => fit(s, ALT_CELLS)
  const pair = (a: string, b: string) => [said(a), said(b)].filter(Boolean).join(' ')
  const parts = [`杂志页插图「${said(title)}」${subtitle ? `（${said(subtitle)}）` : ''}`]
  const noteWords = notes.map(n => pair(n.big, n.label)).filter(Boolean)
  if (noteWords.length > 0) parts.push(`数字：${noteWords.join('、')}`)
  const barWords = bars.map(b => pair(b.label, b.text)).filter(Boolean)
  if (barWords.length > 0) parts.push(`${said(barsTitle) || '条形图'}：${barWords.join('、')}`)
  if (stamps.length > 0) parts.push(`标签：${stamps.map(s => said(s.text)).join('、')}`)
  const alt = parts.join('；') + '。'

  return { source, alt, width: W, height: H }
}
