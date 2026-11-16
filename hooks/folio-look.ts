// atlas: the look the 档案 skin's paper pieces share: the pieces between the
// rows of a page (paper.ts) and the page's illustration (folio.ts). An archive
// page in Morandi colours: ivory paper, fine gold rules with small ornaments,
// wine tabs written in cream, a brass plate. Pure; no `$`.

export const FOLIO = {
  paper: '#F4EFE6',
  paperEdge: '#DCCFB6',
  /** Fine rules, frames and corner pieces. */
  gold: '#B79A68',
  /** The second, fainter rule of a double line. */
  goldSoft: '#D9C9A6',
  ink: '#4A4039',
  inkSoft: '#6F6359',
  /** A tab's body, and what is written large. */
  wine: '#8E5560',
  wineDeep: '#74424D',
  /** What is pressed into wax: a lighter wine. */
  wineLight: '#C39AA2',
  /** A ticket stub's body in mauve and in sage, deep enough for cream writing (5.6:1 and 5.3:1). */
  mauveDeep: '#6F5A7A',
  sageDeep: '#566B50',
  /** What is written on a tab. */
  cream: '#FBF4EC',
  /** A brass plate: its light, its body and its shade. */
  brassLight: '#E6D3A3',
  brass: '#BE9E62',
  brassShade: '#8C6E3C',
  brassInk: '#3D2D12',
} as const

/** The Morandi colours a page takes in turn: each a deeper tone and a pale one of the same hue. */
export const FOLIO_TONES = {
  oat: { deep: '#CDB98F', pale: '#F1E8D6', ink: '#5C4A26' },
  rose: { deep: '#CFA59E', pale: '#F2E1DD', ink: '#6B3A36' },
  sage: { deep: '#A9B79A', pale: '#E4EADC', ink: '#3F4F36' },
  haze: { deep: '#A3B5C4', pale: '#E0E8EE', ink: '#33475A' },
  mauve: { deep: '#B9A8C1', pale: '#EAE2EC', ink: '#4F3F59' },
  taupe: { deep: '#B3A08C', pale: '#ECE4DA', ink: '#4F4132' },
} as const

// A classical face for Latin and digits, 宋体 for Chinese: Baskerville and Songti on a Mac, Georgia and SimSun on Windows
export const FOLIO_FONT = "'Baskerville','Georgia','Songti SC','STSong','SimSun','Noto Serif CJK SC',serif"

function n(v: number): string {
  const r = Math.round(v * 10) / 10
  return Number.isFinite(r) ? String(r === 0 ? 0 : r) : '0'
}

/** A small lozenge centred on (cx, cy), `r` from its centre to a point. */
export function lozenge(cx: number, cy: number, r: number, fill: string): string {
  return `<path d="M${n(cx)} ${n(cy - r)} L${n(cx + r)} ${n(cy)} L${n(cx)} ${n(cy + r)} L${n(cx - r)} ${n(cy)} Z" fill="${fill}"/>`
}

/** A four-pointed spark (✦) centred on (cx, cy), `r` from its centre to a point. */
export function spark(cx: number, cy: number, r: number, fill: string): string {
  const c = `${n(cx)} ${n(cy)}`
  return `<path d="M${n(cx)} ${n(cy - r)} Q${c} ${n(cx + r)} ${n(cy)} Q${c} ${n(cx)} ${n(cy + r)} Q${c} ${n(cx - r)} ${n(cy)} Q${c} ${n(cx)} ${n(cy - r)} Z" fill="${fill}"/>`
}

/** A hairline from x1 to x2 at height y. */
export function hairline(x1: number, x2: number, y: number, stroke: string, width = 1): string {
  if (x2 <= x1) return ''
  return `<path d="M${n(x1)} ${n(y)} H${n(x2)}" fill="none" stroke="${stroke}" stroke-width="${width}"/>`
}

/**
 * A rule with an ornament at its middle: a hairline broken around a spark
 * that two lozenges flank, a lozenge closing each end.
 */
export function ornamentRule(x1: number, x2: number, y: number): string {
  const mid = (x1 + x2) / 2
  if (x2 - x1 < 80) return hairline(x1, x2, y, FOLIO.gold)
  return (
    hairline(x1 + 5, mid - 22, y, FOLIO.gold) +
    hairline(mid + 22, x2 - 5, y, FOLIO.gold) +
    lozenge(x1 + 2, y, 2, FOLIO.gold) +
    lozenge(x2 - 2, y, 2, FOLIO.gold) +
    lozenge(mid - 14, y, 2, FOLIO.gold) +
    lozenge(mid + 14, y, 2, FOLIO.gold) +
    spark(mid, y, 6, FOLIO.wine)
  )
}
