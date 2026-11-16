// atlas: skins. A skin is everything about how the desktop pane looks that is
// a matter of taste: the fills and edges of rows, the ink on them, the marks,
// the card a set of choices sits in, the make of each kind of button, the
// board's coloured sheets, and which paper pieces are drawn, if any (the
// illustration over a page, headings written on paper, the bands between
// rows). The pane reads all of it from the skin in force. A paper style's
// own colours are with what draws it: washi's in paper.ts and journal.ts,
// folio's in folio-look.ts, riviera's in riviera-look.ts, porto's in
// porto-look.ts.
//
// To keep a look: add a Skin here and list it in SKINS. The one in force is
// kept per machine in the mod's own store (`prefs.skin`). Pure; no `$`.

import { FOLIO, FOLIO_TONES } from './folio-look'
import { PORTO, PORTO_TONES } from './porto-look'
import { RIVIERA, RIVIERA_TONES } from './riviera-look'

export type ChipTone = 'off' | 'rewritten' | 'name' | 'note' | 'on'

/**
 * What a button does, which decides its make, so the same job always looks the same:
 *   pick    one of several (a page's tab, a mode, a level); the chosen one is the surface's own primary button
 *   look    looks or goes somewhere and changes nothing (refresh, open, copy, page, back)
 *   make    adds or writes something (new, add, save, rewrite, apply)
 *   switch  turns something off or on, or folds it away
 *   remove  deletes or clears
 *   back    takes a step back (cancel, undo)
 */
export type ButtonKind = 'pick' | 'look' | 'make' | 'switch' | 'remove' | 'back'

/** A border the surface draws round a box: one line with round corners, one with square corners, two lines, or dashes. */
export type Border = 'round' | 'single' | 'double' | 'dashed'

export type ButtonMake = { fill: string; edge: string; ink: string; border: Border; weight: 'medium' | 'semibold' }

/**
 * Whose hand draws a page's paper pieces:
 *   washi  cream dot-grid paper, strips of washi tape, handwriting
 *   folio  ivory archive paper, fine gold rules with small ornaments, wine tabs, a classical serif
 *   riviera  a magazine's white page: thick-and-thin blue rules, large numerals in a display serif, a strip of tiles
 *   porto  a postcard from a harbour town: rows of small coloured houses, a line of sea, a sailing boat
 */
export type PaperStyle = 'washi' | 'folio' | 'riviera' | 'porto'

export type Skin = {
  id: string
  /** What the picker calls it. */
  name: string
  /** One line on what it looks like. The picker is a folded menu and shows names only; this is for a reader of the list. */
  about: string
  /** The page's paper pieces (the illustration over a page, headings on paper, the bands between rows) and whose hand draws them; null: none are drawn. */
  paper: PaperStyle | null
  /** What the fold button calls the illustration over a page. */
  pageName: string
  /** What the illustration is headed. */
  pageTitle: string
  /** The board's columns in turn, each a deeper heading over a pale sheet of the same colour; none: plain rows. */
  sheets: readonly { head: string; body: string }[]
  /** Each list row's fill and edge, taken in turn down a page; none: rows have no fill. */
  rows: readonly { tint: string; edge: string }[]
  /** Ink for what stands on the skin's own fills; null: the surface's own text colour (which follows its theme). */
  ink: string | null
  inkSoft: string | null
  /** The marks on a row, each a fill with its own ink: readable on a light and a dark theme alike. */
  chips: Record<ChipTone, { bg: string; fg: string }>
  /** The card a set of choices sits in; null: a plain bordered box. */
  card: { fill: string; edge: string; border: Border } | null
  /** A button's make by what it does; null: the surface's own buttons. */
  buttons: Record<ButtonKind, ButtonMake> | null
}

const INK = '#3A2F22'
const INK_SOFT = '#6B5D4B'

const CHIPS: Skin['chips'] = {
  off: { bg: '#F9D2DE', fg: '#72243E' },
  rewritten: { bg: '#DDDAF8', fg: '#3C3489' },
  name: { bg: '#CFE3F8', fg: '#0C447C' },
  note: { bg: '#FDE9A8', fg: '#633806' },
  on: { bg: '#CDEBDD', fg: '#085041' },
}

/**
 * 手帐: the first look, settled on 2026-11-13. Cream dot-grid paper with
 * washi tape, every list row a pale strip of its own colour with a deeper
 * edge, sticky-note marks, and six makes of button.
 */
export const JOURNAL: Skin = {
  id: 'journal',
  name: '手帐',
  about: '点阵纸、胶带、彩色色带，按钮按功能分六种制式',
  paper: 'washi',
  pageName: '手帐',
  pageTitle: 'Atlas 手帐',
  sheets: [
    { head: '#A9DBC2', body: '#E8F6EF' },
    { head: '#F2D98A', body: '#FFF8DE' },
    { head: '#EDB4C6', body: '#FDECF2' },
    { head: '#A9C8EC', body: '#EAF2FC' },
    { head: '#BDB5EA', body: '#F1EFFC' },
  ],
  rows: [
    { tint: '#FFF4CC', edge: '#E3CC7A' },
    { tint: '#FCE4EC', edge: '#E9AFC2' },
    { tint: '#DFF3E9', edge: '#9FD3B8' },
    { tint: '#E1EEFB', edge: '#A3C4EA' },
    { tint: '#ECE9FB', edge: '#B9B0E8' },
  ],
  ink: INK,
  inkSoft: INK_SOFT,
  chips: CHIPS,
  card: { fill: '#FBF6EA', edge: '#E6DCC6', border: 'round' },
  buttons: {
    pick: { fill: '#E7EDF6', edge: '#B4C4DA', ink: INK, border: 'round', weight: 'medium' },
    look: { fill: '#EEEAFB', edge: '#C3B8EC', ink: INK, border: 'round', weight: 'medium' },
    make: { fill: '#FFE8C4', edge: '#ECBC78', ink: INK, border: 'round', weight: 'semibold' },
    switch: { fill: '#FCE3EB', edge: '#E8ACC0', ink: INK, border: 'round', weight: 'medium' },
    remove: { fill: '#FCE0DB', edge: '#DD8A82', ink: '#7A1F1F', border: 'dashed', weight: 'medium' },
    back: { fill: '#FFFFFF', edge: '#CFC6B4', ink: INK_SOFT, border: 'round', weight: 'medium' },
  },
}

const F_INK = FOLIO.ink
// deeper than the paper pieces' soft ink: it also stands on the rows' tints, which are darker than the paper
const F_INK_SOFT = '#655950'
const T = FOLIO_TONES

/**
 * 档案: an archive page in Morandi colours, after a set of vintage journal
 * templates (their elements and palette, not their theatre theme). Ivory
 * paper, fine gold rules with small ornaments, numbered wine tabs, a classical
 * serif; rows in muted oat, rose, sage, haze blue and mauve; marks as deep
 * tabs written in cream; buttons pale, in the same families as 手帐's so each
 * job keeps its hue.
 */
export const ARCHIVE: Skin = {
  id: 'folio',
  name: '档案',
  about: '莫兰迪色的档案页：象牙纸、细金线和小花饰、酒红编号标签、衬线字',
  paper: 'folio',
  pageName: '档案页',
  pageTitle: 'Atlas 档案',
  sheets: [
    { head: T.sage.deep, body: T.sage.pale },
    { head: T.oat.deep, body: T.oat.pale },
    { head: T.rose.deep, body: T.rose.pale },
    { head: T.haze.deep, body: T.haze.pale },
    { head: T.mauve.deep, body: T.mauve.pale },
  ],
  rows: [
    { tint: T.oat.pale, edge: T.oat.deep },
    { tint: T.rose.pale, edge: T.rose.deep },
    { tint: T.sage.pale, edge: T.sage.deep },
    { tint: T.haze.pale, edge: T.haze.deep },
    { tint: T.mauve.pale, edge: T.mauve.deep },
  ],
  ink: F_INK,
  inkSoft: F_INK_SOFT,
  chips: {
    off: { bg: FOLIO.wine, fg: FOLIO.cream },
    rewritten: { bg: '#75637F', fg: FOLIO.cream },
    name: { bg: '#566C80', fg: FOLIO.cream },
    note: { bg: '#846838', fg: FOLIO.cream },
    on: { bg: '#5A7053', fg: FOLIO.cream },
  },
  card: { fill: FOLIO.paper, edge: FOLIO.gold, border: 'double' },
  buttons: {
    pick: { fill: '#DCE5EC', edge: T.haze.deep, ink: F_INK, border: 'round', weight: 'medium' },
    look: { fill: '#E8DFEA', edge: T.mauve.deep, ink: F_INK, border: 'round', weight: 'medium' },
    make: { fill: '#EAD9B5', edge: FOLIO.brass, ink: F_INK, border: 'round', weight: 'semibold' },
    switch: { fill: '#EFD9D4', edge: T.rose.deep, ink: F_INK, border: 'round', weight: 'medium' },
    remove: { fill: '#EDD3D3', edge: FOLIO.wine, ink: FOLIO.wineDeep, border: 'dashed', weight: 'medium' },
    back: { fill: '#FBF8F2', edge: '#CFC4B2', ink: F_INK_SOFT, border: 'round', weight: 'medium' },
  },
}

const R = RIVIERA
const RT = RIVIERA_TONES

/**
 * 地中海: a magazine page by the sea: blue and white, the layout grand and
 * the air fresh. White paper, cobalt rules thick
 * and thin, large numerals in a display serif, a strip of blue tiles, a
 * little lemon; rows in white, sky, aqua, sand and periwinkle; marks as
 * solid labels; a button's job keeps the hue family it has in the other
 * skins (pick blue, look violet, make warm, switch and remove red).
 *
 * Two things it learned in the pane: a lemon row was too bright (now sand),
 * and a red mark for "off" did not sit with the rest (now slate blue).
 */
export const RIVIERA_SKIN: Skin = {
  id: 'riviera',
  name: '地中海',
  about: '蓝白色的杂志页：钴蓝粗细线、大号衬线数字、蓝瓷砖花边、一点柠檬黄',
  paper: 'riviera',
  pageName: '封面',
  pageTitle: 'Atlas',
  sheets: [
    { head: RT.sky.deep, body: RT.sky.pale },
    { head: RT.aqua.deep, body: RT.aqua.pale },
    { head: RT.sand.deep, body: RT.sand.pale },
    { head: RT.periwinkle.deep, body: RT.periwinkle.pale },
    { head: RT.white.deep, body: R.foam },
  ],
  rows: [
    { tint: RT.white.pale, edge: RT.white.deep },
    { tint: RT.sky.pale, edge: RT.sky.deep },
    { tint: RT.aqua.pale, edge: RT.aqua.deep },
    { tint: RT.sand.pale, edge: RT.sand.deep },
    { tint: RT.periwinkle.pale, edge: RT.periwinkle.deep },
  ],
  ink: R.navy,
  inkSoft: R.inkSoft,
  chips: {
    off: { bg: '#566579', fg: '#FFFFFF' },
    rewritten: { bg: '#4A4FA6', fg: '#FFFFFF' },
    name: { bg: R.cobalt, fg: '#FFFFFF' },
    note: { bg: R.lemon, fg: R.navy },
    on: { bg: '#1B6F6C', fg: '#FFFFFF' },
  },
  card: { fill: R.foam, edge: R.cobalt, border: 'single' },
  buttons: {
    pick: { fill: '#FFFFFF', edge: R.azure, ink: R.cobalt, border: 'round', weight: 'medium' },
    look: { fill: RT.periwinkle.pale, edge: RT.periwinkle.deep, ink: R.navy, border: 'round', weight: 'medium' },
    make: { fill: '#FBE9A1', edge: '#DDBB45', ink: R.navy, border: 'round', weight: 'semibold' },
    switch: { fill: RT.coral.pale, edge: RT.coral.deep, ink: R.navy, border: 'round', weight: 'medium' },
    remove: { fill: '#FBD9D0', edge: '#C8553D', ink: RT.coral.ink, border: 'dashed', weight: 'medium' },
    back: { fill: '#EEF1F6', edge: '#C3CEDD', ink: R.inkSoft, border: 'round', weight: 'medium' },
  },
}

const P = PORTO
const PT = PORTO_TONES

/**
 * 海岸小镇: the coast between the south of France and Italy: many coloured
 * buildings and the sea. Cream paper, rows of small houses in
 * terracotta, ochre, pink and coral with green shutters, a teal sea and a
 * sailing boat. The strong colours stay with the houses: rows are pale walls
 * (peach, sea foam, rose, sky, sand), and the mark for "off" is slate, since
 * a bright yellow row and a red mark were out of place in 地中海.
 */
export const PORTO_SKIN: Skin = {
  id: 'porto',
  name: '海岸小镇',
  about: '南法和意大利海边的小镇：彩色房子一路排到水边、绿百叶窗、青蓝的海和小帆船',
  paper: 'porto',
  pageName: '明信片',
  pageTitle: 'Atlas',
  sheets: [
    { head: PT.peach.deep, body: PT.peach.pale },
    { head: PT.foam.deep, body: PT.foam.pale },
    { head: PT.rose.deep, body: PT.rose.pale },
    { head: PT.sky.deep, body: PT.sky.pale },
    { head: PT.sand.deep, body: PT.sand.pale },
  ],
  rows: [
    { tint: PT.peach.pale, edge: PT.peach.deep },
    { tint: PT.foam.pale, edge: PT.foam.deep },
    { tint: PT.rose.pale, edge: PT.rose.deep },
    { tint: PT.sky.pale, edge: PT.sky.deep },
    { tint: PT.sand.pale, edge: PT.sand.deep },
  ],
  ink: P.ink,
  inkSoft: P.inkSoft,
  chips: {
    off: { bg: '#5E6B74', fg: '#FFFFFF' },
    rewritten: { bg: '#7B5A9A', fg: '#FFFFFF' },
    name: { bg: P.seaDeep, fg: '#FFFFFF' },
    note: { bg: '#F6CFA0', fg: '#5A3A12' },
    on: { bg: '#2F6E55', fg: '#FFFFFF' },
  },
  card: { fill: P.paper, edge: '#E0A586', border: 'round' },
  buttons: {
    pick: { fill: '#FFFFFF', edge: '#7DB9C4', ink: P.seaDeep, border: 'round', weight: 'medium' },
    look: { fill: PT.lilac.pale, edge: PT.lilac.deep, ink: P.ink, border: 'round', weight: 'medium' },
    make: { fill: '#FCDDB7', edge: '#E8A866', ink: P.ink, border: 'round', weight: 'semibold' },
    switch: { fill: '#F8DAD4', edge: PT.rose.deep, ink: P.ink, border: 'round', weight: 'medium' },
    remove: { fill: '#F9D3CB', edge: '#C4513B', ink: '#7A2A1A', border: 'dashed', weight: 'medium' },
    back: { fill: '#F3EFE7', edge: '#CFC6B4', ink: P.inkSoft, border: 'round', weight: 'medium' },
  },
}

export const SKINS: readonly Skin[] = [JOURNAL, ARCHIVE, RIVIERA_SKIN, PORTO_SKIN]

/** The skin of that id; the first one (手帐) for an id that names none, or for none. */
export function skinOf(id: string | undefined): Skin {
  return SKINS.find(s => s.id === id) ?? JOURNAL
}
