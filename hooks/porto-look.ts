// atlas: the look the 海岸小镇 skin's paper pieces share: the pieces between
// the rows of a page (paper.ts) and the page's illustration (porto.ts). A
// harbour town on the coast between the south of France and Italy: houses in
// terracotta, ochre, pink and coral crowding down to the water, green
// shutters, a teal sea with a boat on it, warm cream paper. The strong
// colours are the houses'; whatever carries reading is pale. Pure; no `$`.

export const PORTO = {
  paper: '#FFF9EF',
  paperEdge: '#EAD9BF',
  /** Ink, the deep slate of the water at dusk. */
  ink: '#263640',
  inkSoft: '#55626B',
  sky: '#EAF5F7',
  sea: '#2F8FA6',
  seaDeep: '#1F6F8B',
  seaPale: '#BFE3E6',
  sun: '#F5C453',
  /** Roof tiles, and what is written large. */
  roof: '#B5533A',
  roofDeep: '#8E3F2B',
  shutter: '#3F7A5E',
  window: '#3D5A66',
  door: '#6B4B3A',
  /** The quay the houses stand on. */
  quay: '#D8C7A8',
  /** Lilac deep enough for small writing and a 1px line on the paper: 5.7:1. */
  lilacDeep: '#6B56A8',
} as const

/** The walls of the town, in the order houses take them. */
export const PORTO_WALLS = ['#D9714E', '#E9B24F', '#F09C92', '#F8E7C4', '#E0604F', '#F5BE91', '#A9CFE0', '#EFA36B'] as const

/** The pale colours a page takes in turn: each a deeper tone, a pale one of the same hue, and ink that reads on the pale one. */
export const PORTO_TONES = {
  peach: { deep: '#EDBE9A', pale: '#FDEFE3', ink: '#6A3A1C' },
  rose: { deep: '#E9ACA6', pale: '#FBE8E6', ink: '#74302B' },
  sand: { deep: '#DFCFA8', pale: '#F9F3E6', ink: '#55461F' },
  foam: { deep: '#96CBC4', pale: '#E4F3F1', ink: '#17504A' },
  sky: { deep: '#A3C2E3', pale: '#E6EFF8', ink: '#1F4470' },
  lilac: { deep: '#C3B3DF', pale: '#EFEAF7', ink: '#463670' },
} as const

// A warm old-style face for what is written large: Cochin or Hoefler on a Mac, Georgia on Windows; 宋体 for Chinese
export const PORTO_DISPLAY = "'Cochin','Hoefler Text','Georgia','Songti SC','STSong','SimSun','Noto Serif CJK SC',serif"
// What stands small beside it. Not Gill Sans, for all it suits the coast: its 1 is a bare stroke, and a date reads as "II 月 I4 日"
export const PORTO_SANS = "'Avenir Next','Helvetica Neue','Segoe UI','PingFang SC','Microsoft YaHei',sans-serif"

function n(v: number): string {
  const r = Math.round(v * 10) / 10
  return Number.isFinite(r) ? String(r === 0 ? 0 : r) : '0'
}

function rect(x: number, y: number, w: number, h: number, fill: string): string {
  return `<rect x="${n(x)}" y="${n(y)}" width="${n(Math.max(0, w))}" height="${n(Math.max(0, h))}" fill="${fill}"/>`
}

/**
 * One house standing on `base`, its left wall at x, `w` wide and `h` tall to
 * the eaves, the `index`-th of its row: the index picks its wall, whether its
 * roof is pitched or a flat cornice, and nothing else. Windows with green
 * shutters come with the room for them, a door with the height for one.
 */
export function house(x: number, base: number, w: number, h: number, index: number): string {
  const i = Math.max(0, Math.floor(Number.isFinite(index) ? index : 0))
  const wall = PORTO_WALLS[i % PORTO_WALLS.length] ?? PORTO_WALLS[0]
  const top = base - h
  let out = rect(x, top, w, h, wall)
  // the roof
  if (i % 3 === 1) {
    const rise = Math.min(w * 0.32, 14)
    out += `<path d="M${n(x - 1)} ${n(top)} L${n(x + w / 2)} ${n(top - rise)} L${n(x + w + 1)} ${n(top)} Z" fill="${PORTO.roof}"/>`
  } else {
    out += rect(x - 1, top - Math.max(1.5, h * 0.06), w + 2, Math.max(1.5, h * 0.06), PORTO.roof)
  }
  // the door, when the house is tall enough to have one
  const hasDoor = h >= 26
  const doorH = hasDoor ? Math.min(h * 0.26, 16) : 0
  const doorW = hasDoor ? Math.min(w * 0.24, 10) : 0
  if (hasDoor) out += `<path d="M${n(x + w / 2 - doorW / 2)} ${n(base)} v${n(-doorH + doorW / 2)} a${n(doorW / 2)} ${n(doorW / 2)} 0 0 1 ${n(doorW)} 0 V${n(base)} Z" fill="${PORTO.door}"/>`
  // the windows: one or two to a floor, as many floors as fit above the door
  const perFloor = w >= 16 ? 2 : 1
  const paneW = Math.max(1.6, Math.min(w * 0.16, 7))
  const paneH = paneW * 1.5
  const floorH = paneH + Math.max(2.5, paneH * 0.9)
  const room = h - doorH - Math.max(2, paneH * 0.5)
  const floors = Math.max(h >= 7 ? 1 : 0, Math.min(4, Math.floor(room / floorH)))
  const hasShutters = paneW >= 4
  for (let f = 0; f < floors; f++) {
    const y = top + Math.max(2, paneH * 0.6) + f * floorH
    for (let k = 0; k < perFloor; k++) {
      const cx = x + (w * (k + 1)) / (perFloor + 1)
      if (hasShutters) out += rect(cx - paneW / 2 - paneW * 0.45, y, paneW * 0.45, paneH, PORTO.shutter) + rect(cx + paneW / 2, y, paneW * 0.45, paneH, PORTO.shutter)
      out += rect(cx - paneW / 2, y, paneW, paneH, PORTO.window)
    }
  }
  return out
}

const WIDE = [1, 0.8, 1.15, 0.9, 1.05, 0.75, 1, 0.85] as const
const TALL = [0.78, 1, 0.62, 0.9, 0.72, 1, 0.66, 0.86] as const

/**
 * A row of houses shoulder to shoulder on `base`, from x1 towards x2 (whole
 * houses only, the row centred in what is left over), the tallest `height`
 * to its eaves and a house about `unit` wide. `start` shifts which house the
 * row begins with, so two rows on a page are not twins.
 */
export function town(x1: number, x2: number, base: number, height: number, unit: number, start = 0): string {
  const s = Math.max(0, Math.floor(Number.isFinite(start) ? start : 0))
  const widths: number[] = []
  let total = 0
  for (let k = 0; k < 200; k++) {
    const w = Math.round(unit * (WIDE[(s + k) % WIDE.length] ?? 1))
    if (w < 1 || total + w > x2 - x1) break
    widths.push(w)
    total += w
  }
  let x = x1 + (x2 - x1 - total) / 2
  let out = ''
  widths.forEach((w, k) => {
    out += house(x, base, w, Math.round(height * (TALL[(s + k) % TALL.length] ?? 1)), s + k)
    x += w
  })
  return out
}

/** A line of waves from x1 towards x2 (whole waves only), each `length` px long and `height` px from trough to crest, about height y. */
export function swell(x1: number, x2: number, y: number, length = 16, height = 4, stroke: string = PORTO.sea, width = 1.25): string {
  const count = Math.floor((x2 - x1) / length)
  if (count < 1) return ''
  let d = `M${n(x1)} ${n(y)}`
  for (let k = 0; k < count; k++) d += ` q${n(length / 4)} ${n(-height)} ${n(length / 2)} 0 t${n(length / 2)} 0`
  return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round"/>`
}

/** A small sailing boat with its waterline at `base`, centred on cx, its hull `s` px long: a hull, a mast, a sail to each side. */
export function boat(cx: number, base: number, s: number, hull: string = PORTO.roof): string {
  const half = s / 2
  const deep = s * 0.2
  const mast = s * 0.85
  return (
    `<path d="M${n(cx - half)} ${n(base - deep)} H${n(cx + half)} L${n(cx + half * 0.62)} ${n(base)} H${n(cx - half * 0.62)} Z" fill="${hull}"/>` +
    `<path d="M${n(cx + 0.8)} ${n(base - deep - 1)} V${n(base - deep - mast)} L${n(cx + half * 0.8)} ${n(base - deep - 1)} Z" fill="${PORTO.paper}" stroke="${PORTO.ink}" stroke-width="0.6" stroke-linejoin="round"/>` +
    `<path d="M${n(cx - 0.8)} ${n(base - deep - 1)} V${n(base - deep - mast * 0.72)} L${n(cx - half * 0.6)} ${n(base - deep - 1)} Z" fill="${PORTO.sun}" stroke="${PORTO.ink}" stroke-width="0.6" stroke-linejoin="round"/>`
  )
}
