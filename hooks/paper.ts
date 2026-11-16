// atlas: the paper a list lies on. Small SVG pieces drawn between the rows of
// a page: a band of paper above each row, and a section's heading written on
// the same paper. Four hands draw them (a skin says which): washi, dot-grid
// paper with a strip of washi tape across some bands; folio, ivory archive
// paper with fine gold rules and small ornaments; riviera, a magazine's white
// page with blue rules, tiles and waves; porto, cream paper with rows of
// small coloured houses, the sea and a boat. Pure; no `$`.
//
// A row itself is a native box and takes one flat colour: the texture is in
// what stands around it.

import { serifWidth } from './folio'
import { FOLIO, FOLIO_FONT, hairline, lozenge, ornamentRule, spark } from './folio-look'
import { PORTO, PORTO_DISPLAY, boat, house, swell, town } from './porto-look'
import { displayWidth } from './riviera'
import { RIVIERA, RIVIERA_DISPLAY, fineRule, scotchRule, tileStrip, waves } from './riviera-look'
import type { PaperStyle } from './skins'
import { cellWidth, fit } from './text'

type Piece = { source: string; alt: string; width: number; height: number }

const PAPER = '#FBF6EA'
const DOT = '#DDD1B6'
const INK = '#4A3B2A'
// 手札体 on a Mac; on Windows, Segoe Print for Latin and digits and 楷体 for Chinese
const FONT = "'Hannotate SC','Segoe Print','KaiTi','Chalkboard SE','Marker Felt','Kaiti SC','Songti SC',serif"

/** Tape: a body colour and the lighter colour of its print. */
const TAPES = [
  { body: '#F4C0D1', print: '#FBEAF0' },
  { body: '#9FE1CB', print: '#E1F5EE' },
  { body: '#FAC775', print: '#FAEEDA' },
  { body: '#AFA9EC', print: '#EEEDFE' },
  { body: '#85B7EB', print: '#E6F1FB' },
] as const

const PRINTS = ['stripe', 'dot', 'check'] as const

function esc(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function paperWidth(width: number): number {
  return Math.max(240, Math.min(900, Math.round(Number.isFinite(width) ? width : 460)))
}

function defs(tape: (typeof TAPES)[number], print: (typeof PRINTS)[number]): string {
  const dots = `<pattern id="d" width="12" height="12" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="${DOT}"/></pattern>`
  const p =
    print === 'stripe'
      ? `<pattern id="t" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="8" fill="${tape.print}"/></pattern>`
      : print === 'dot'
        ? `<pattern id="t" width="8" height="8" patternUnits="userSpaceOnUse"><circle cx="4" cy="4" r="1.6" fill="${tape.print}"/></pattern>`
        : `<pattern id="t" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="${tape.print}"/><rect x="4" y="4" width="4" height="4" fill="${tape.print}"/></pattern>`
  return `<defs>${dots}${p}</defs>`
}

function sheet(w: number, h: number): string {
  return `<rect width="${w}" height="${h}" fill="${PAPER}"/><rect width="${w}" height="${h}" fill="url(#d)"/>`
}

function tapePiece(x: number, y: number, w: number, h: number, tilt: number, tape: (typeof TAPES)[number]): string {
  const cx = Math.round(x + w / 2)
  const cy = Math.round(y + h / 2)
  return `<g transform="rotate(${tilt} ${cx} ${cy})"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${tape.body}" opacity="0.92"/><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#t)" opacity="0.7"/></g>`
}

function whole(index: number): number {
  return Math.max(0, Math.floor(Number.isFinite(index) ? index : 0))
}

/**
 * The band of paper above the `index`-th row of a list, in the hand `style`
 * names. washi: every third one has a strip of tape laid across it, its
 * colour, print, side and tilt taken from the index. folio: every third one
 * carries a rule with an ornament at its middle, the others three small
 * lozenges. riviera: a hairline, and on every third a short strip of tiles
 * or a line of waves by turns. porto: a pale line of sea, and on every third
 * a row of small houses or a boat by turns. Whichever, a page looks the same
 * each time it is drawn.
 */
export function paperBand(width: number, index: number, style: PaperStyle = 'washi'): Piece {
  if (style === 'folio') return folioBand(width, index)
  if (style === 'riviera') return rivieraBand(width, index)
  if (style === 'porto') return portoBand(width, index)
  const w = paperWidth(width)
  const h = 18
  const i = whole(index)
  const tape = TAPES[i % TAPES.length] ?? TAPES[0]
  const print = PRINTS[Math.floor(i / 3) % PRINTS.length] ?? PRINTS[0]
  const hasTape = i % 3 === 0
  const long = Math.min(w - 40, 70 + ((i * 37) % 60))
  const x = Math.floor(i / 3) % 2 === 0 ? 14 + ((i * 11) % 24) : w - long - 14 - ((i * 7) % 24)
  const piece = hasTape ? tapePiece(Math.max(4, x), 4, long, 10, i % 2 === 0 ? -1.5 : 1.5, tape) : ''
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"><title>纸</title>${defs(tape, print)}${sheet(w, h)}${piece}</svg>`
  // never an empty alt: a surface draws nothing for a picture that says nothing
  return { source, alt: hasTape ? '点阵纸和一段胶带' : '点阵纸', width: w, height: h }
}

/**
 * A section's heading on the paper, in the hand `style` names. washi: written
 * under a piece of tape that `index` picks. folio: after a wine tab that
 * numbers it (`index` + 1), a rule running on from it to a spark. riviera:
 * under a thick-and-thin rule, after its number set large in italics. porto:
 * beside a house (`index` picks its wall and its roof), the sea running
 * under both to a boat.
 */
export function paperHeading(width: number, text: string, index: number, style: PaperStyle = 'washi'): Piece {
  if (style === 'folio') return folioHeading(width, text, index)
  if (style === 'riviera') return rivieraHeading(width, text, index)
  if (style === 'porto') return portoHeading(width, text, index)
  const w = paperWidth(width)
  const h = 50
  const i = whole(index)
  const tape = TAPES[(i + 2) % TAPES.length] ?? TAPES[0]
  const print = PRINTS[i % PRINTS.length] ?? PRINTS[0]
  const size = 19
  const room = Math.max(8, Math.floor((w - 40) / (size / 2)))
  const said = fit(text.replace(/\s+/g, ' ').trim(), room)
  const long = Math.min(w - 40, Math.round(cellWidth(said) * (size / 2) * 1.08) + 12)
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" font-family="${FONT}"><title>${esc(said)}</title>` +
    `${defs(tape, print)}${sheet(w, h)}` +
    tapePiece(w - 96, 5, 78, 12, i % 2 === 0 ? 3 : -3, tape) +
    `<rect x="14" y="27" width="${long}" height="12" fill="#FAC775" opacity="0.5"/>` +
    `<text x="18" y="36" font-size="${size}" fill="${INK}">${esc(said)}</text>` +
    `</svg>`
  return { source, alt: text, width: w, height: h }
}

// ---------- folio ----------

function folioSheet(w: number, h: number): string {
  return `<rect width="${w}" height="${h}" fill="${FOLIO.paper}"/>`
}

function folioBand(width: number, index: number): Piece {
  const w = paperWidth(width)
  const h = 16
  const y = 8
  const i = whole(index)
  const isRuled = i % 3 === 0
  const mid = Math.round(w / 2)
  const mark = isRuled
    ? ornamentRule(18, w - 18, y)
    : lozenge(mid - 11, y, 1.6, FOLIO.goldSoft) + lozenge(mid, y, 2, FOLIO.gold) + lozenge(mid + 11, y, 1.6, FOLIO.goldSoft)
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"><title>纸</title>${folioSheet(w, h)}${mark}</svg>`
  return { source, alt: isRuled ? '象牙纸和一道花饰细线' : '象牙纸', width: w, height: h }
}

function folioHeading(width: number, text: string, index: number): Piece {
  const w = paperWidth(width)
  const h = 48
  const i = whole(index)
  const size = 19
  const number = String(i + 1).padStart(2, '0')
  const tabX = 14
  const tabW = 20 + number.length * 8
  const textX = tabX + tabW + 11
  // cut by cells first, then by the serif's own measure (folio.ts keeps it) until the words end inside the paper
  const room = Math.max(8, Math.floor((w - textX - 16) / (size / 2)))
  let said = fit(text.replace(/\s+/g, ' ').trim(), room)
  while (said.length > 1 && serifWidth(said, size) > w - textX - 16) said = fit(said, cellWidth(said) - 1)
  const ruleFrom = textX + Math.ceil(serifWidth(said, size)) + 12
  const ruleTo = w - 30
  const rule =
    ruleTo - ruleFrom >= 24
      ? hairline(ruleFrom, ruleTo, 23, FOLIO.gold) + hairline(ruleFrom, ruleTo, 26.5, FOLIO.goldSoft, 0.75) + spark(w - 20, 24.5, 6.5, FOLIO.wine)
      : ''
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" font-family="${FOLIO_FONT}"><title>${esc(said)}</title>` +
    folioSheet(w, h) +
    `<rect x="${tabX}" y="13" width="${tabW}" height="23" rx="3" fill="${FOLIO.wine}"/>` +
    `<rect x="${tabX + 2.5}" y="15.5" width="${tabW - 5}" height="18" rx="1.5" fill="none" stroke="${FOLIO.goldSoft}" stroke-width="0.75" opacity="0.7"/>` +
    `<text x="${tabX + tabW / 2}" y="29.5" font-size="13" letter-spacing="1" text-anchor="middle" fill="${FOLIO.cream}">${number}</text>` +
    `<text x="${textX}" y="31" font-size="${size}" fill="${FOLIO.wineDeep}">${esc(said)}</text>` +
    rule +
    `</svg>`
  return { source, alt: text, width: w, height: h }
}

// ---------- riviera ----------

function rivieraSheet(w: number, h: number): string {
  return `<rect width="${w}" height="${h}" fill="${RIVIERA.paper}"/>`
}

function rivieraBand(width: number, index: number): Piece {
  const w = paperWidth(width)
  const h = 18
  const y = 9
  const i = whole(index)
  const mid = Math.round(w / 2)
  const kind = i % 3 !== 0 ? 'rule' : Math.floor(i / 3) % 2 === 0 ? 'tiles' : 'waves'
  let mark: string
  if (kind === 'rule') mark = fineRule(12, w - 12, y)
  else if (kind === 'tiles') {
    const size = 12
    const count = 7
    const half = (size * count) / 2
    mark = fineRule(12, mid - half - 10, y) + tileStrip(mid - half, y - size / 2, size, count) + fineRule(mid + half + 10, w - 12, y)
  } else {
    const half = 40
    mark = fineRule(12, mid - half - 10, y) + waves(mid - half, mid + half, y + 1, 16, 4, RIVIERA.azure) + fineRule(mid + half + 10, w - 12, y)
  }
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"><title>纸</title>${rivieraSheet(w, h)}${mark}</svg>`
  const alt = kind === 'tiles' ? '白纸和一条蓝瓷砖花边' : kind === 'waves' ? '白纸和一道波浪线' : '白纸和一道细线'
  return { source, alt, width: w, height: h }
}

function rivieraHeading(width: number, text: string, index: number): Piece {
  const w = paperWidth(width)
  const h = 58
  const i = whole(index)
  const size = 20
  const number = String(i + 1).padStart(2, '0')
  const numberX = 12
  const textX = numberX + number.length * 18 + 12
  const room = Math.max(8, Math.floor((w - textX - 14) / (size / 2)))
  // cut by cells first, then by the display face's own measure (riviera.ts keeps it: the widest of its faces, bold included)
  let said = fit(text.replace(/\s+/g, ' ').trim(), room)
  while (said.length > 1 && displayWidth(said, size) > w - textX - 14) said = fit(said, cellWidth(said) - 1)
  // a small sun at the row's end, when the words leave it room
  const sun = textX + displayWidth(said, size) + 16 <= w - 26 ? `<circle cx="${w - 18}" cy="36" r="5.5" fill="${RIVIERA.lemon}"/>` : ''
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" font-family="${RIVIERA_DISPLAY}"><title>${esc(said)}</title>` +
    rivieraSheet(w, h) +
    scotchRule(0, w, 6) +
    `<text x="${numberX}" y="45" font-size="31" font-style="italic" fill="${RIVIERA.cobalt}">${number}</text>` +
    `<text x="${textX}" y="43" font-size="${size}" font-weight="700" fill="${RIVIERA.navy}">${esc(said)}</text>` +
    sun +
    `</svg>`
  return { source, alt: text, width: w, height: h }
}

// ---------- porto ----------

function portoSheet(w: number, h: number): string {
  return `<rect width="${w}" height="${h}" fill="${PORTO.paper}"/>`
}

function portoBand(width: number, index: number): Piece {
  const w = paperWidth(width)
  const h = 22
  const i = whole(index)
  const mid = Math.round(w / 2)
  const sea = 13
  const kind = i % 3 !== 0 ? 'sea' : Math.floor(i / 3) % 2 === 0 ? 'town' : 'boat'
  let mark: string
  if (kind === 'sea') mark = swell(14, w - 14, sea, 16, 4, PORTO.seaPale)
  else if (kind === 'town') {
    // a row of small houses on their quay, the sea to each side
    const half = Math.min(82, Math.floor((w - 120) / 2))
    const base = 20
    mark =
      swell(14, mid - half - 12, sea, 16, 4, PORTO.seaPale) +
      town(mid - half, mid + half, base, 13, 12, i) +
      `<rect x="${mid - half - 3}" y="${base}" width="${half * 2 + 6}" height="1.5" fill="${PORTO.quay}"/>` +
      swell(mid + half + 12, w - 14, sea, 16, 4, PORTO.seaPale)
  } else {
    mark = swell(14, mid - 44, sea, 16, 4, PORTO.seaPale) + swell(mid - 32, mid + 32, sea + 3, 16, 4, PORTO.sea) + boat(mid, sea + 3, 16) + swell(mid + 44, w - 14, sea, 16, 4, PORTO.seaPale)
  }
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"><title>纸</title>${portoSheet(w, h)}${mark}</svg>`
  const alt = kind === 'town' ? '奶油色的纸和一排彩色小房子' : kind === 'boat' ? '奶油色的纸和海上一只小帆船' : '奶油色的纸和一道海浪'
  return { source, alt, width: w, height: h }
}

function portoHeading(width: number, text: string, index: number): Piece {
  const w = paperWidth(width)
  const h = 62
  const i = whole(index)
  const size = 20
  const base = 47
  const houseX = 12
  const houseW = 24
  const textX = houseX + houseW + 12
  const room = Math.max(8, Math.floor((w - textX - 14) / (size / 2)))
  // cut by cells first, then by a display face's measure (riviera.ts keeps one that errs wide for this face too)
  let said = fit(text.replace(/\s+/g, ' ').trim(), room)
  while (said.length > 1 && displayWidth(said, size) > w - textX - 14) said = fit(said, cellWidth(said) - 1)
  const end = textX + displayWidth(said, size)
  // the sea runs under the house and the words; a boat rides it at the row's end, when the words leave it room
  const sail = end + 16 <= w - 40 ? boat(w - 26, base + 8, 16) : ''
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" font-family="${PORTO_DISPLAY}"><title>${esc(said)}</title>` +
    portoSheet(w, h) +
    house(houseX, base, houseW, 30, i) +
    `<rect x="${houseX - 4}" y="${base}" width="${houseW + 8}" height="2" fill="${PORTO.quay}"/>` +
    `<text x="${textX}" y="${base - 5}" font-size="${size}" font-weight="700" fill="${PORTO.ink}">${esc(said)}</text>` +
    swell(12, w - 12, base + 8, 16, 4, PORTO.sea) +
    sail +
    `</svg>`
  return { source, alt: text, width: w, height: h }
}
