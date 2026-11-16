// atlas: the look the 地中海 skin's paper pieces share: the pieces between the
// rows of a page (paper.ts) and the page's illustration (riviera.ts). A page
// of a magazine by the sea: white paper, cobalt and sky blue, a little lemon,
// a high-contrast display serif over letter-spaced capitals, thick-and-thin
// rules, a strip of blue tiles, an awning's stripes. Pure; no `$`.

export const RIVIERA = {
  paper: '#FFFFFF',
  /** The palest wash of blue. */
  foam: '#F2F7FD',
  /** Hairlines and a page's edge. */
  rule: '#BFD4EE',
  sky: '#8DB7E8',
  azure: '#4E8FDD',
  /** The masthead's blue: rules, numerals, tiles. */
  cobalt: '#1F4FA3',
  /** Ink. */
  navy: '#14284B',
  inkSoft: '#46597A',
  /** The sun, and what is highlighted. */
  lemon: '#F4CF4E',
  lemonPale: '#FDF3C4',
  aqua: '#6FBDBA',
  periwinkle: '#8E97E0',
  /** The one warm accent, used sparingly. */
  coral: '#D4634A',
  /** Coral, periwinkle and aqua deep enough for small writing and a 1px line on the white paper: 5.0:1, 5.5:1 and 5.1:1. */
  coralDeep: '#BC4A32',
  periwinkleDeep: '#5560C0',
  aquaDeep: '#1F7A76',
} as const

/** The colours a page takes in turn: each a deeper tone, a pale one of the same hue, and ink that reads on the pale one. */
export const RIVIERA_TONES = {
  white: { deep: '#9DBBE3', pale: '#FFFFFF', ink: '#14284B' },
  sky: { deep: '#8DB7E8', pale: '#E9F2FC', ink: '#173E7C' },
  aqua: { deep: '#8CC9C6', pale: '#E5F4F3', ink: '#14514F' },
  lemon: { deep: '#E3C867', pale: '#FCF6DC', ink: '#5C4A0A' },
  /** Pale beach sand: the warm one among the rows, quiet where lemon would shout. */
  sand: { deep: '#D9CCAD', pale: '#F8F4EA', ink: '#4F4630' },
  periwinkle: { deep: '#A9B0E8', pale: '#ECEEFB', ink: '#2F3680' },
  coral: { deep: '#E7A493', pale: '#FCEAE5', ink: '#7C2B18' },
} as const

// The masthead's face: Didot or Bodoni on a Mac, Georgia on Windows; 宋体 for Chinese
export const RIVIERA_DISPLAY = "'Didot','Bodoni 72','Bodoni MT','Georgia','Songti SC','STSong','SimSun','Noto Serif CJK SC',serif"
// What stands small beside it: kickers in capitals, labels, figures' captions
export const RIVIERA_SANS = "'Avenir Next','Helvetica Neue','Segoe UI','PingFang SC','Microsoft YaHei',sans-serif"

function n(v: number): string {
  const r = Math.round(v * 10) / 10
  return Number.isFinite(r) ? String(r === 0 ? 0 : r) : '0'
}

/** A hairline from x1 to x2 at height y. */
export function fineRule(x1: number, x2: number, y: number, stroke: string = RIVIERA.rule, width = 1): string {
  if (x2 <= x1) return ''
  return `<path d="M${n(x1)} ${n(y)} H${n(x2)}" fill="none" stroke="${stroke}" stroke-width="${width}"/>`
}

/** A magazine's thick-and-thin rule: a cobalt bar `thick` px tall with its top at y, a hairline 3px under it. */
export function scotchRule(x1: number, x2: number, y: number, thick = 3): string {
  if (x2 <= x1) return ''
  return `<rect x="${n(x1)}" y="${n(y)}" width="${n(x2 - x1)}" height="${n(thick)}" fill="${RIVIERA.cobalt}"/>` + fineRule(x1, x2, y + thick + 3.5, RIVIERA.cobalt, 0.75)
}

/**
 * One glazed tile, `s` px square with its corner at (x, y). Two patterns take
 * turns: a cobalt tile with a white lozenge and a cobalt heart to it, and a
 * white tile edged in blue with a four-petalled flower.
 */
export function tile(x: number, y: number, s: number, isDark: boolean): string {
  const cx = x + s / 2
  const cy = y + s / 2
  if (isDark) {
    const r = s * 0.36
    return (
      `<rect x="${n(x)}" y="${n(y)}" width="${n(s)}" height="${n(s)}" fill="${RIVIERA.cobalt}"/>` +
      `<path d="M${n(cx)} ${n(cy - r)} L${n(cx + r)} ${n(cy)} L${n(cx)} ${n(cy + r)} L${n(cx - r)} ${n(cy)} Z" fill="${RIVIERA.paper}"/>` +
      `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(s * 0.11)}" fill="${RIVIERA.cobalt}"/>`
    )
  }
  const d = s * 0.2
  const r = s * 0.15
  return (
    `<rect x="${n(x + 0.5)}" y="${n(y + 0.5)}" width="${n(s - 1)}" height="${n(s - 1)}" fill="${RIVIERA.paper}" stroke="${RIVIERA.sky}" stroke-width="1"/>` +
    `<circle cx="${n(cx - d)}" cy="${n(cy)}" r="${n(r)}" fill="${RIVIERA.azure}"/>` +
    `<circle cx="${n(cx + d)}" cy="${n(cy)}" r="${n(r)}" fill="${RIVIERA.azure}"/>` +
    `<circle cx="${n(cx)}" cy="${n(cy - d)}" r="${n(r)}" fill="${RIVIERA.azure}"/>` +
    `<circle cx="${n(cx)}" cy="${n(cy + d)}" r="${n(r)}" fill="${RIVIERA.azure}"/>`
  )
}

/** A strip of `count` tiles in a row from x, the two patterns in turn. */
export function tileStrip(x: number, y: number, s: number, count: number): string {
  let out = ''
  for (let i = 0; i < Math.max(0, Math.floor(count)); i++) out += tile(x + i * s, y, s, i % 2 === 0)
  return out
}

/** A line of waves from x1 towards x2 (whole waves only), each `length` px long and `height` px from trough to crest, about height y. */
export function waves(x1: number, x2: number, y: number, length = 16, height = 4, stroke: string = RIVIERA.sky, width = 1.25): string {
  const count = Math.floor((x2 - x1) / length)
  if (count < 1) return ''
  let d = `M${n(x1)} ${n(y)}`
  for (let i = 0; i < count; i++) d += ` q${n(length / 4)} ${n(-height)} ${n(length / 2)} 0 t${n(length / 2)} 0`
  return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round"/>`
}

/** An awning's stripes: a band w wide and h tall with its corner at (x, y), cobalt and white by turns, each stripe `stripe` px wide. */
export function awning(x: number, y: number, w: number, h: number, stripe = 10): string {
  let out = `<rect x="${n(x)}" y="${n(y)}" width="${n(Math.max(0, w))}" height="${n(h)}" fill="${RIVIERA.paper}"/>`
  for (let at = 0; at < w; at += stripe * 2) out += `<rect x="${n(x + at)}" y="${n(y)}" width="${n(Math.min(stripe, w - at))}" height="${n(h)}" fill="${RIVIERA.cobalt}"/>`
  return out
}
