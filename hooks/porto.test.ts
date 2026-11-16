import { describe, expect, test as engineTest } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { journalSvg } from './journal'
import type { JournalBar, JournalNote, JournalSpec, JournalStamp } from './journal'
import { displayWidth, portoSvg, sansWidth } from './porto'
import { PORTO, PORTO_DISPLAY, PORTO_SANS, PORTO_TONES, PORTO_WALLS, town as lookTown } from './porto-look'

// These tests draw every page at every width: quick on an idle machine, several times slower beside a build.
// So each may run half a minute, where a test has five seconds by default.
const test = (name: string, body: TestBody): void => engineTest(name, { timeoutMs: 30_000 }, body)

// ---------- a small XML reader: balance, attributes, entities ----------

type El = { name: string; attrs: Record<string, string>; kids: (El | string)[] }

const ENTITY = /&(amp|lt|gt|quot|#\d+);/g
const OPEN = /<([A-Za-z][A-Za-z0-9]*)((?:\s+[A-Za-z][A-Za-z0-9:-]*="[^"]*")*)\s*(\/?)>/y
const CLOSE = /<\/([A-Za-z][A-Za-z0-9]*)>/y
const ATTR = /([A-Za-z][A-Za-z0-9:-]*)="([^"]*)"/g

function decode(s: string): string {
  return s.replace(ENTITY, (_, e: string) =>
    e === 'amp' ? '&' : e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : String.fromCodePoint(Number(e.slice(1))),
  )
}

/**
 * Throws on a loose `<`, `>` or `&` and on a character XML has no place for:
 * character data holds entities and plain text only.
 */
function checkChars(s: string, where: string): void {
  if (/[<>]/.test(s)) throw new Error(`loose angle bracket in ${where}: ${s.slice(0, 60)}`)
  if (s.replace(ENTITY, '').includes('&')) throw new Error(`loose & in ${where}: ${s.slice(0, 60)}`)
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(s) || /[\ud800-\udfff]/u.test(s)) {
    throw new Error(`a character XML cannot hold in ${where}: ${JSON.stringify(s.slice(0, 60))}`)
  }
}

/** The document as a tree; throws unless it is one balanced `<svg>` of well-formed tags. */
function parse(source: string): El {
  const doc: El = { name: '#doc', attrs: {}, kids: [] }
  const stack: El[] = [doc]
  let i = 0
  while (i < source.length) {
    const top = stack[stack.length - 1]
    if (!top) throw new Error('closed past the document')
    if (source[i] !== '<') {
      const j = source.indexOf('<', i)
      const text = source.slice(i, j < 0 ? source.length : j)
      checkChars(text, `the text of <${top.name}>`)
      top.kids.push(decode(text))
      i += text.length
      continue
    }
    CLOSE.lastIndex = i
    const closing = CLOSE.exec(source)
    if (closing) {
      if (stack.length < 2 || top.name !== closing[1]) throw new Error(`</${closing[1]}> closes <${top.name}> at ${i}`)
      stack.pop()
      i = CLOSE.lastIndex
      continue
    }
    OPEN.lastIndex = i
    const opening = OPEN.exec(source)
    if (!opening) throw new Error(`not a tag at ${i}: ${source.slice(i, i + 60)}`)
    const el: El = { name: opening[1] ?? '', attrs: {}, kids: [] }
    for (const a of (opening[2] ?? '').matchAll(ATTR)) {
      const key = a[1] ?? ''
      if (Object.hasOwn(el.attrs, key)) throw new Error(`<${el.name}> repeats ${key}`)
      checkChars(a[2] ?? '', `${key} of <${el.name}>`)
      el.attrs[key] = decode(a[2] ?? '')
    }
    top.kids.push(el)
    if (opening[3] !== '/') stack.push(el)
    i = OPEN.lastIndex
  }
  if (stack.length !== 1) throw new Error(`<${stack[stack.length - 1]?.name}> is never closed`)
  const root = doc.kids[0]
  if (doc.kids.length !== 1 || !root || typeof root === 'string' || root.name !== 'svg') throw new Error('not one <svg> document')
  return root
}

function walk(el: El, visit: (el: El, above: readonly El[]) => void, above: readonly El[] = []): void {
  visit(el, above)
  for (const kid of el.kids) if (typeof kid !== 'string') walk(kid, visit, [...above, el])
}

function all(el: El | undefined, name?: string): El[] {
  const out: El[] = []
  if (el) {
    walk(el, e => {
      if (!name || e.name === name) out.push(e)
    })
  }
  return out
}

/** An element's own children of one name, not their children. */
function own(el: El | undefined, name: string): El[] {
  return (el?.kids ?? []).filter((kid): kid is El => typeof kid !== 'string' && kid.name === name)
}

function said(el: El): string {
  return el.kids.map(k => (typeof k === 'string' ? k : said(k))).join('')
}

function group(svg: El, cls: string): El | undefined {
  return all(svg, 'g').find(g => g.attrs.class === cls)
}

function groups(svg: El | undefined, cls: string): El[] {
  return all(svg, 'g').filter(g => g.attrs.class === cls)
}

// ---------- measures ----------

type Box = { x0: number; x1: number; y0: number; y1: number }

const NOWHERE: Box = { x0: NaN, x1: NaN, y0: NaN, y1: NaN }
const NOTHING: El = { name: '', attrs: {}, kids: [] }

const n = (el: El | undefined, key: string) => Number(el?.attrs[key])

const isSans = (el: El) => el.attrs['font-family'] !== undefined

/**
 * A text's box by the estimate the layout promises: its own stack's widths
 * and the spacing after each letter; a slanted line leans 3px past its end.
 */
function textBox(el: El): Box {
  const fs = n(el, 'font-size')
  const s = said(el)
  const spacing = el.attrs['letter-spacing'] === undefined ? 0 : n(el, 'letter-spacing')
  const w = isSans(el) ? sansWidth(s, fs, spacing) : displayWidth(s, fs, spacing)
  const x0 = el.attrs['text-anchor'] === 'middle' ? n(el, 'x') - w / 2 : n(el, 'x')
  return { x0, x1: x0 + w + (el.attrs['font-style'] === 'italic' ? 3 : 0), y0: n(el, 'y') - fs * 0.8, y1: n(el, 'y') + fs * 0.2 }
}

function rectBox(el: El | undefined): Box {
  return { x0: n(el, 'x'), x1: n(el, 'x') + n(el, 'width'), y0: n(el, 'y'), y1: n(el, 'y') + n(el, 'height') }
}

function circleBox(el: El | undefined): Box {
  return { x0: n(el, 'cx') - n(el, 'r'), x1: n(el, 'cx') + n(el, 'r'), y0: n(el, 'cy') - n(el, 'r'), y1: n(el, 'cy') + n(el, 'r') }
}

function numbers(d: string): number[] {
  return (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
}

/**
 * Every point a path names, subpath by subpath. A wave counts by its crest
 * and its trough, an arc by its end and by how far it bulges.
 */
function pathPoints(d: string): { x: number; y: number }[][] {
  const subs: { x: number; y: number }[][] = []
  let x = 0
  let y = 0
  let dy = 0
  const put = (px: number, py: number) => subs[subs.length - 1]?.push({ x: px, y: py })
  const to = (nx: number, ny: number) => {
    x = nx
    y = ny
    put(x, y)
  }
  for (const m of d.matchAll(/([A-Za-z])([^A-Za-z]*)/g)) {
    const cmd = m[1] ?? ''
    const p = numbers(m[2] ?? '')
    const at = (i: number) => p[i] ?? NaN
    if (cmd === 'M') {
      subs.push([])
      for (let i = 0; i + 1 < p.length; i += 2) to(at(i), at(i + 1))
    } else if (cmd === 'L') for (let i = 0; i + 1 < p.length; i += 2) to(at(i), at(i + 1))
    else if (cmd === 'H') for (const v of p) to(v, y)
    else if (cmd === 'V') for (const v of p) to(x, v)
    else if (cmd === 'h') for (const v of p) to(x + v, y)
    else if (cmd === 'v') for (const v of p) to(x, y + v)
    else if (cmd === 'q') {
      // q cx cy x y: the curve reaches half of cy off its line
      dy = at(1)
      put(x + at(0), y + dy / 2)
      to(x + at(2), y + at(3))
    } else if (cmd === 't') {
      // the mirror of the curve before it
      put(x + at(0) / 2, y - dy / 2)
      to(x + at(0), y + at(1))
    } else if (cmd === 'a') {
      for (let i = 0; i + 6 < p.length; i += 7) {
        // an arc bulges to the left of the way it runs when it turns clockwise, to the right when not: by its radius at most
        const dx = at(i + 5)
        const run = Math.hypot(dx, at(i + 6)) || 1
        const side = at(i + 4) === 1 ? 1 : -1
        put(x + dx / 2 + (side * at(i + 6) * at(i)) / run, y + at(i + 6) / 2 - (side * dx * at(i + 1)) / run)
        to(x + dx, y + at(i + 6))
      }
    } else if (cmd !== 'Z' && cmd !== 'z') throw new Error(`a path command this reader does not know: ${cmd}`)
  }
  return subs
}

function boxOf(points: readonly { x: number; y: number }[]): Box {
  return { x0: Math.min(...points.map(p => p.x)), x1: Math.max(...points.map(p => p.x)), y0: Math.min(...points.map(p => p.y)), y1: Math.max(...points.map(p => p.y)) }
}

function pathBox(d: string): Box {
  return boxOf(pathPoints(d).flat())
}

function shapeBox(el: El): Box | undefined {
  return el.name === 'rect' ? rectBox(el) : el.name === 'circle' ? circleBox(el) : el.name === 'path' ? pathBox(el.attrs.d ?? '') : undefined
}

function inside(inner: Box, outer: Box, slack = 0.05): boolean {
  return inner.x0 >= outer.x0 - slack && inner.x1 <= outer.x1 + slack && inner.y0 >= outer.y0 - slack && inner.y1 <= outer.y1 + slack
}

function overlap(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
}

/** How far apart two boxes are: 0 when they touch or overlap. */
function gap(a: Box, b: Box): number {
  const dx = Math.max(0, a.x0 - b.x1, b.x0 - a.x1)
  const dy = Math.max(0, a.y0 - b.y1, b.y0 - a.y1)
  return Math.hypot(dx, dy)
}

function finite(b: Box): boolean {
  return [b.x0, b.x1, b.y0, b.y1].every(Number.isFinite)
}

/** A measure that grows with the page as the layout's do: `narrow` at 320, `wide` at 680, whole px. */
function grow(width: number, narrow: number, wide: number): number {
  return Math.round(narrow + ((wide - narrow) * (width - 320)) / 360)
}

function paperBox(svg: El): Box {
  return rectBox(all(group(svg, 'paper'), 'rect')[0])
}

type View = { box: Box; sky: El | undefined; quay: El | undefined; sea: El | undefined; sun: El | undefined; swells: El[]; boats: El[]; town: El | undefined }

/** The view: its sky, the quay's line, the sea's strip, the sun, the two lines of swell, the boats, the town. */
function view(svg: El): View {
  const g = group(svg, 'view')
  const [sky, quay, sea] = own(g, 'rect')
  const top = rectBox(sky)
  const foot = rectBox(sea)
  return { box: { x0: top.x0, x1: top.x1, y0: top.y0, y1: foot.y1 }, sky, quay, sea, sun: own(g, 'circle')[0], swells: own(g, 'path'), boats: groups(g, 'boat'), town: group(svg, 'town') }
}

/** The town's walls, left to right. */
function walls(svg: El): Box[] {
  return all(group(svg, 'town'), 'rect')
    .filter(r => (PORTO_WALLS as readonly string[]).includes(r.attrs.fill ?? ''))
    .map(rectBox)
}

/** The content's column: from the one left edge, where the masthead's swell starts, to as far from the other side. */
function column(svg: El): { x0: number; x1: number } {
  const swell = all(group(svg, 'masthead'), 'path')[0]
  const x0 = numbers(swell?.attrs.d ?? '')[0] ?? NaN
  return { x0, x1: n(svg, 'width') - x0 }
}

/** Where the page's writing may stand: the column across, from under the view to the paper's foot. */
function field(svg: El): Box {
  const col = column(svg)
  return { x0: col.x0, x1: col.x1, y0: view(svg).box.y1, y1: paperBox(svg).y1 }
}

type Card = { sheet: El; roof: El | undefined; pane: El[]; big: El | undefined; lines: El[]; box: Box }

/** The cards: each one's wall, its roof, its window if it has one, its big text and the lines of its label. */
function cards(svg: El): Card[] {
  return groups(svg, 'card').map(g => {
    const [sheet, ...pane] = all(g, 'rect')
    if (!sheet) throw new Error('a card without its wall')
    const texts = all(g, 'text')
    // the wall's line is drawn half a px inside the card's box
    const r = rectBox(sheet)
    return { sheet, roof: all(g, 'path')[0], pane, big: texts.find(t => !isSans(t)), lines: texts.filter(isSans), box: { x0: r.x0 - 0.5, x1: r.x1 + 0.5, y0: r.y0 - 0.5, y1: r.y1 + 0.5 } }
  })
}

type Row = { label: string; text: string; labelEl: El | undefined; textEl: El | undefined; x: number; len: number; top: number; bottom: number; color: string; isTick: boolean }

/** The chart's rows: what is written, where the bar starts and how long it runs (0 for a tick). */
function chartRows(svg: El): Row[] {
  return groups(svg, 'row').map(row => {
    const texts = all(row, 'text')
    const bar = all(row, 'rect')[0]
    const tick = all(row, 'path')[0]
    if (!bar && !tick) throw new Error('a row without a bar')
    const box = bar ? rectBox(bar) : pathBox(tick?.attrs.d ?? '')
    const labelEl = texts.find(isSans)
    const textEl = texts.find(t => !isSans(t))
    return {
      label: labelEl ? said(labelEl) : '',
      text: textEl ? said(textEl) : '',
      labelEl,
      textEl,
      x: box.x0,
      len: bar ? box.x1 - box.x0 : 0,
      top: box.y0,
      bottom: box.y1,
      color: (bar ? bar.attrs.fill : tick?.attrs.stroke) ?? '',
      isTick: !bar,
    }
  })
}

/** The tags: each one's border and what is written in it, in the order drawn. */
function tags(svg: El): { box: Box; border: El; text: El | undefined }[] {
  const g = group(svg, 'tags')
  const texts = own(g, 'text')
  return own(g, 'rect').map((border, i) => {
    // the line is drawn half a px inside the tag's box
    const r = rectBox(border)
    return { box: { x0: r.x0 - 0.5, x1: r.x1 + 0.5, y0: r.y0 - 0.5, y1: r.y1 + 0.5 }, border, text: texts[i] }
  })
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * (c[0] ?? NaN) + 0.7152 * (c[1] ?? NaN) + 0.0722 * (c[2] ?? NaN)
}

function contrast(a: string, b: string): number {
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

// ---------- pages ----------

const WIDTHS = [320, 460, 680] as const

const SWEEP: number[] = []
for (let width = 320; width <= 680; width += 20) SWEEP.push(width)

const BASE: JournalSpec = {
  title: 'Atlas',
  subtitle: '11 月 14 日 · 提示词页',
  notes: [
    { big: '12', label: '段系统提示词' },
    { big: '9.8k', label: 'tokens 左右' },
    { big: '2 关 · 1 改', label: '这个会话的改动' },
  ],
  barsTitle: '谁最占地方',
  bars: [
    { label: 'doing_tasks', value: 2600, text: '2.6k' },
    { label: 'tools', value: 2100, text: '2.1k' },
    { label: 'memory', value: 1300, text: '1.3k' },
  ],
  stamps: [{ text: '已关闭 · 本会话' }, { text: '2 处改动', tone: 'purple' }],
}

const LONG: JournalSpec = {
  title: '这是一个特别特别长的明信片标题用来看看会不会被截断到纸的里面',
  subtitle: 'a very long latin subtitle that goes on and on and on, well past what any page of this size could ever hold in one line',
  notes: [
    { big: '一百二十三万四千五百六十七', label: '这个会话里被关闭的系统提示词段落还有很多很多别的东西' },
    { big: '1234567890123456789', label: 'tokens estimated for everything that was loaded here', tone: 'blue' },
    { big: 'WWWWMMMM@@@@', label: 'Supercalifragilisticexpialidocious_without_any_space', tone: 'purple' },
  ],
  barsTitle: '哪些段落占用的上下文最多最多最多最多最多最多最多最多最多最多最多最多最多',
  bars: [
    { label: '非常非常长的中文段落名字看看怎么截断才好', value: 5, text: '五千二百三十一个 tokens 左右吧大概也许' },
    { label: 'a_very_long_latin_label_for_a_section_name_indeed', value: 3, text: '3,141,592 tokens (approximately, give or take)' },
    { label: '短', value: 1 },
    { label: '零', value: 0 },
    { label: 'MMMMWWWW@@@@MMMMWWWW', value: 4.5, text: 'WWWWMMMMWWWWMMMM' },
    { label: '混合 mixed 标签 label 混合 mixed', value: 2.25 },
  ],
  stamps: [
    { text: '已关闭 · 本会话里的全部改动都在这里都在这里都在这里' },
    { text: 'a rather long latin stamp text that will not fit anywhere', tone: 'teal' },
    { text: '第三个标签也很长很长很长很长很长很长很长很长' },
    { text: '四' },
  ],
}

function allFields(s: string): JournalSpec {
  const notes: JournalNote[] = [0, 1, 2].map(() => ({ big: s, label: s }))
  const bars: JournalBar[] = [1, 2, 3, 4, 5, 6].map(value => ({ label: s, value, text: s }))
  const stamps: JournalStamp[] = [0, 1, 2, 3].map(() => ({ text: s }))
  return { title: s, subtitle: s, notes, barsTitle: s, bars, stamps }
}

const NASTY = [
  '<script>alert(1)</script>',
  '<foreignObject><iframe src="http://evil.example/"></iframe></foreignObject>',
  '" onload="alert(1)',
  "' onclick='alert(1)' x='",
  'onerror=alert(1)',
  '<image href="http://evil.example/x.png"/>',
  'HTTPS://EVIL.EXAMPLE/a.js',
  ']]><svg onload=alert(1)>',
  '&lt;script&gt; &#60;script&#62; &bogus;',
  'javascript:alert(1)',
  '<a xlink:href="http://x.example">x</a>',
  '" style="fill:url(http://x.example)" font-family="x',
  '<rect x="0" y="0" width="9" height="9" fill="#3F7A5E"/><path d="M0 0" fill="#6B4B3A"/>',
  'a\u0000b\u0008c\u001bd \ud800 e\r\n\tf',
]

const PAGES: readonly (readonly [string, JournalSpec])[] = [
  ['the usual page', BASE],
  ['long text', LONG],
  ['markup in every field', allFields('<b>&"\'')],
  ['capitals and wide letters', allFields('MWM@WMW HHOOQQ')],
  ['only a title', { title: 'Atlas', subtitle: '', notes: [] }],
  ['only a subtitle', { title: '', subtitle: '11 月 14 日 · 回收站', notes: [] }],
  ['nothing at all', { title: '', subtitle: '', notes: [] }],
  ['one note, bars without a title', { title: '记忆', subtitle: '7 条', notes: [{ big: '7', label: '条' }], bars: [{ label: 'a', value: 1 }, { label: '', value: 2, text: '' }] }],
  ['two notes and a lone stamp', { title: 'T', subtitle: 'S', notes: [{ big: '', label: '' }, { big: '1', label: '' }], stamps: [{ text: 'x' }] }],
  ['four stamps of mixed length', { title: 'Atlas', subtitle: '会话页', notes: [], stamps: [{ text: 'MEMORY.md 已对齐' }, { text: '3 条没链接', tone: 'purple' }, { text: '回收站 2', tone: 'teal' }, { text: 'a rather long latin stamp that goes on for a while' }] }],
]

const EVERY: readonly (readonly [string, JournalSpec])[] = [...PAGES, ...NASTY.map(s => ['nasty', allFields(s)] as const)]

const ELEMENTS = new Set(['svg', 'title', 'g', 'rect', 'circle', 'path', 'text'])
const ATTRIBUTES = new Set([
  'xmlns', 'width', 'height', 'viewBox', 'role', 'font-family', 'class', 'x', 'y', 'cx', 'cy', 'r', 'rx', 'd',
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'font-size', 'font-style', 'letter-spacing', 'text-anchor',
])
const CLASSES = new Set(['paper', 'view', 'town', 'boat', 'masthead', 'cards', 'card', 'bars', 'row', 'tags'])
const XMLNS = ' xmlns="http://www.w3.org/2000/svg"'

/** Every colour porto-look names: the page takes its colours from there and nowhere else. */
const PALETTE = new Set<string>([...Object.values(PORTO), ...PORTO_WALLS, ...Object.values(PORTO_TONES).flatMap(tone => [tone.deep, tone.pale, tone.ink])])

/** What must never be in the source, whatever the data: the names of what it finds. */
function forbidden(source: string): string[] {
  const s = source.replace(XMLNS, '')
  const found: string[] = []
  if (/<script/i.test(s)) found.push('<script')
  if (/<foreignObject/i.test(s)) found.push('<foreignObject')
  if (/\bon[a-z]+\s*=/i.test(s)) found.push('an on…= handler')
  if (/http/i.test(s)) found.push('http')
  // a style attribute or element; font-style is neither
  if (/\sstyle\s*=|<style/i.test(s)) found.push('style')
  if (/<(image|use|a|iframe|filter|animate|set|linearGradient|radialGradient|clipPath|mask)\b/i.test(s)) found.push('an element it may not hold')
  const svg = parse(source)
  walk(svg, el => {
    if (!ELEMENTS.has(el.name)) found.push(`<${el.name}>`)
    for (const [key, value] of Object.entries(el.attrs)) {
      // the page names nothing: an id would have to begin atlas-porto-, and it has none
      if (key === 'id') found.push(value.startsWith('atlas-porto-') ? `${el.name} id=` : `id="${value}"`)
      else if (!ATTRIBUTES.has(key)) found.push(`${el.name} ${key}=`)
      // nothing is filled from elsewhere: the page has no pattern, no gradient
      if (/url\(/i.test(value)) found.push(`${key}="${value}"`)
      if ((key === 'fill' || key === 'stroke') && value !== 'none' && !PALETTE.has(value)) found.push(`${key}="${value}"`)
      if (key === 'class' && !CLASSES.has(value)) found.push(`class="${value}"`)
      if (key === 'font-family' && value !== PORTO_DISPLAY && value !== PORTO_SANS) found.push(`font-family="${value}"`)
    }
  })
  return found
}

/** What the page writes of the spec: every text it holds (it writes no words of its own). */
function written(svg: El): string[] {
  return all(svg, 'text').map(said)
}

// ---------- the document ----------

describe('porto: the document', () => {
  test('the root tag agrees with the numbers returned', () => {
    for (const [, spec] of PAGES) {
      for (const width of WIDTHS) {
        const r = portoSvg({ ...spec, width })
        expect(r.source.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="${r.width}" height="${r.height}" viewBox="0 0 ${r.width} ${r.height}" role="img" font-family="${PORTO_DISPLAY}">`)).toBe(true)
        expect(r.source.endsWith('</svg>')).toBe(true)
        expect(r.width).toBe(width)
        expect(Number.isInteger(r.height) && r.height > 0).toBe(true)
        const svg = parse(r.source)
        expect(svg.attrs['font-family']).toBe(PORTO_DISPLAY)
        expect(svg.attrs.role).toBe('img')
        expect(all(svg, 'title')).toHaveLength(1)
        expect(svg.kids[0] === all(svg, 'title')[0]).toBe(true)
      }
    }
    expect(said(all(parse(portoSvg(BASE).source), 'title')[0] ?? NOTHING)).toBe('Atlas')
    expect(said(all(parse(portoSvg({ title: '', subtitle: '', notes: [] }).source), 'title')[0] ?? NOTHING)).toBe('明信片')
  })

  test('width is clamped to 320..680 and is 460 when not given', () => {
    expect(portoSvg(BASE).width).toBe(460)
    expect(portoSvg({ ...BASE, width: 100 }).width).toBe(320)
    expect(portoSvg({ ...BASE, width: -5 }).width).toBe(320)
    expect(portoSvg({ ...BASE, width: 319.4 }).width).toBe(320)
    expect(portoSvg({ ...BASE, width: 9999 }).width).toBe(680)
    expect(portoSvg({ ...BASE, width: Infinity }).width).toBe(460)
    expect(portoSvg({ ...BASE, width: -Infinity }).width).toBe(460)
    expect(portoSvg({ ...BASE, width: NaN }).width).toBe(460)
    expect(portoSvg({ ...BASE, width: 500.6 }).width).toBe(501)
    for (const width of [100, 9999, NaN, 500.6]) {
      const r = portoSvg({ ...BASE, width })
      expect(parse(r.source).attrs.viewBox).toBe(`0 0 ${r.width} ${r.height}`)
    }
  })

  test('it is well-formed: balanced tags, quoted attributes, no loose < > &', () => {
    expect(() => parse('<svg><g></svg>')).toThrow()
    expect(() => parse('<svg><text>a < b</text></svg>')).toThrow()
    expect(() => parse('<svg><text>a & b</text></svg>')).toThrow()
    expect(() => parse('<svg a="1" a="2"/>')).toThrow()
    expect(() => parse('<svg/><svg/>')).toThrow()
    expect(() => parse('<svg><text>a\u0000b</text></svg>')).toThrow()
    expect(() => parse('<svg><text>a\ud800b</text></svg>')).toThrow()
    expect(parse('<svg><text>a 😀 明信片 &amp;&#61;</text></svg>').kids).toHaveLength(1)
    for (const [, spec] of EVERY) {
      for (const width of WIDTHS) {
        const svg = parse(portoSvg({ ...spec, width }).source)
        // text sits in <text> and <title> only, never between shapes
        walk(svg, el => {
          if (el.name !== 'text' && el.name !== 'title') expect(el.kids.every(k => typeof k !== 'string')).toBe(true)
        })
      }
    }
    // control and direction characters, line breaks and half a surrogate pair never reach the markup
    const odd = portoSvg({ title: 'a\u0000b\u0008c\u001b\u202ed\ufeff\u2067\ud800e\r\n\tf', subtitle: '', notes: [], width: 680 })
    expect(written(parse(odd.source))).toEqual(['abcde f'])
    expect(odd.alt).toBe('明信片插图「abcde f」。')
  })

  test('text is escaped in every field and comes back whole', () => {
    const raw = '<b>&"\''
    for (const width of WIDTHS) {
      const r = portoSvg({ ...allFields(raw), width })
      expect(r.source).not.toContain('<b')
      const svg = parse(r.source)
      for (const el of all(svg)) expect(ELEMENTS.has(el.name)).toBe(true)
      const texts = written(svg)
      // subtitle, title, 3 cards × 2, the chart's title, 6 bars × 2, 4 tags
      expect(texts).toHaveLength(25)
      for (const s of texts) expect(s).toBe(raw)
      expect(said(all(svg, 'title')[0] ?? svg)).toBe(raw)
      expect(r.source.split('&lt;b&gt;&amp;&quot;&#39;')).toHaveLength(27)
      expect(r.alt).toContain(raw)
    }
  })

  test('no script, handler, style, link, name or outside reference, whatever the data holds', () => {
    const ns = 'xmlns="http://www.w3.org/2000/svg"'
    expect(forbidden(`<svg ${ns}><text onclick="x">a</text></svg>`)).not.toHaveLength(0)
    expect(forbidden(`<svg ${ns}><rect fill="url(#a)"/></svg>`)).not.toHaveLength(0)
    expect(forbidden(`<svg ${ns}><rect fill="red"/></svg>`)).not.toHaveLength(0)
    expect(forbidden(`<svg ${ns}><rect fill="#123456"/></svg>`)).not.toHaveLength(0)
    expect(forbidden(`<svg ${ns}><rect style="fill:#FFF9EF"/></svg>`)).toEqual(['style', 'rect style='])
    expect(forbidden(`<svg ${ns}><text font-style="italic">a</text></svg>`)).toEqual([])
    expect(forbidden(`<svg ${ns}><g id="other"/></svg>`)).toEqual(['id="other"'])
    expect(forbidden(`<svg ${ns}><g id="atlas-porto-a"/></svg>`)).toEqual(['g id='])
    expect(forbidden(`<svg ${ns}><use href="#a"/></svg>`)).not.toHaveLength(0)
    expect(forbidden(`<svg ${ns}><text href="#a">a</text></svg>`)).toEqual(['text href='])
    expect(forbidden(`<svg ${ns}><text transform="rotate(3)">a</text></svg>`)).toEqual(['text transform='])
    expect(forbidden(`<svg ${ns}><text font-family="Comic Sans MS">a</text></svg>`)).toEqual(['font-family="Comic Sans MS"'])
    expect(forbidden(`<svg ${ns}><g class="town"><rect fill="${PORTO.sea}"/></g></svg>`)).toEqual([])
    for (const [, spec] of PAGES) for (const width of WIDTHS) expect(forbidden(portoSvg({ ...spec, width }).source)).toEqual([])
    for (const nasty of NASTY) {
      for (const width of WIDTHS) {
        const r = portoSvg({ ...allFields(nasty), width })
        expect(forbidden(r.source)).toEqual([])
        expect(r.source.split('http').length).toBe(2)
      }
    }
    // the nasty text is still there to read, as text
    const shown = written(parse(portoSvg({ title: 'see http://a.example?x=1', subtitle: '', notes: [], width: 680 }).source))
    expect(shown).toEqual(['see http://a.example?x=1'])
  })

  test('no font under 11px, nothing turned, no gradients, patterns or filters', () => {
    for (const [, spec] of EVERY) {
      for (const width of SWEEP) {
        const r = portoSvg({ ...spec, width })
        const sizes = [...r.source.matchAll(/font-size="([^"]*)"/g)].map(m => Number(m[1]))
        for (const size of sizes) expect(size).toBeGreaterThanOrEqual(11)
        expect(r.source).not.toMatch(/font-size\s*:|font\s*:|\sstyle=/)
        expect(r.source).not.toMatch(/Gradient|<filter|filter=|blur|shadow|transform|opacity|<defs|<pattern/i)
        for (const el of all(parse(r.source), 'text')) {
          expect(Number.isFinite(n(el, 'font-size'))).toBe(true)
          expect(Number.isFinite(n(el, 'x')) && Number.isFinite(n(el, 'y'))).toBe(true)
        }
      }
    }
  })

  test('what is read is quiet: every text 4.5:1 on the paper or on a pale wall, none on a strong colour', () => {
    const pales = new Set<string>(Object.values(PORTO_TONES).map(tone => tone.pale))
    for (const [, spec] of PAGES) {
      for (const width of WIDTHS) {
        const svg = parse(portoSvg({ ...spec, width }).source)
        const paper = all(group(svg, 'paper'), 'rect')[0]?.attrs.fill ?? ''
        expect(paper).toBe(PORTO.paper)
        const onCards = new Set<El>()
        for (const card of cards(svg)) {
          // a card's wall is one of the pale tones, never a house's colour
          expect(pales.has(card.sheet.attrs.fill ?? '')).toBe(true)
          for (const el of [card.big, ...card.lines]) {
            if (!el) continue
            onCards.add(el)
            const ratio = contrast(el.attrs.fill ?? '', card.sheet.attrs.fill ?? '')
            if (!(ratio >= 4.5)) throw new Error(`"${said(el)}" is ${el.attrs.fill} on ${card.sheet.attrs.fill}: ${ratio.toFixed(2)}:1`)
          }
        }
        // every other text stands on the paper itself: none is written on a fill, and none in the view
        for (const el of all(svg, 'text')) {
          if (onCards.has(el)) continue
          const ratio = contrast(el.attrs.fill ?? '', paper)
          if (!(ratio >= 4.5)) throw new Error(`"${said(el)}" is ${el.attrs.fill} on ${paper}: ${ratio.toFixed(2)}:1`)
        }
        expect(all(group(svg, 'view'), 'text')).toHaveLength(0)
        for (const tag of tags(svg)) {
          expect(tag.border.attrs.fill).toBe('none')
          expect(contrast(tag.border.attrs.stroke ?? '', paper)).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
    for (const deep of [PORTO.roofDeep, PORTO.roof, PORTO.lilacDeep, PORTO.seaDeep, PORTO.ink]) expect(contrast(deep, PORTO.paper)).toBeGreaterThanOrEqual(4.5)
    for (const tone of Object.values(PORTO_TONES)) expect(contrast(tone.ink, tone.pale)).toBeGreaterThanOrEqual(4.5)
  })

  test('the same spec gives the same page, and the spec is left as it was', () => {
    for (const [, spec] of PAGES) {
      const before = JSON.stringify(spec)
      const a = portoSvg({ ...spec, width: 460 })
      const b = portoSvg({ ...spec, width: 460 })
      expect(a).toEqual(b)
      expect(portoSvg(spec)).toEqual(a)
      expect(JSON.stringify(spec)).toBe(before)
    }
  })

  test('a usual page is the view and a few thousand characters more, and the largest stays far under 131072', () => {
    for (const width of SWEEP) {
      const r = portoSvg({ ...BASE, width })
      const view = /<g class="view">.*?<\/g><\/g>/.exec(r.source)?.[0].length ?? NaN
      // the view is the town, house by house: most of a page's markup
      expect(view).toBeLessThan(10000)
      expect(r.source.length - view).toBeLessThan(8000)
    }
    for (const big of [`W&<>"'明信片`.repeat(5000), '\u{1F600}'.repeat(20000), 'i'.repeat(100000), '&'.repeat(100000), 'x '.repeat(50000)]) {
      const spec = allFields(big)
      spec.notes = [...spec.notes, ...spec.notes]
      spec.bars = [...(spec.bars ?? []), ...(spec.bars ?? [])]
      spec.stamps = [...(spec.stamps ?? []), ...(spec.stamps ?? [])]
      for (const width of WIDTHS) {
        const r = portoSvg({ ...spec, width })
        expect(r.source.length).toBeLessThan(26000)
        parse(r.source)
        expect(r.alt.length).toBeLessThan(4000)
        expect(r.alt.length).toBeGreaterThan(0)
      }
    }
    for (const [, page] of EVERY) for (const width of WIDTHS) expect(portoSvg({ ...page, width }).source.length).toBeLessThan(26000)
  })

  test('what is not a spec does not throw, and no number drawn is anything but a number', () => {
    const odd: unknown[] = [undefined, null, 0, -1, NaN, Infinity, -Infinity, true, {}, [], [[]], 'x', 12345678901234567890n]
    const MEASURES = ['x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'font-size', 'letter-spacing', 'stroke-width']
    const specs: unknown[] = [
      {},
      { title: null, subtitle: undefined, notes: null },
      { title: 7, subtitle: {}, notes: 'notes', bars: 'bars', stamps: 5, barsTitle: [], width: '460' },
      ...odd.map(v => ({ title: v, subtitle: v, barsTitle: v, width: v, notes: v, bars: v, stamps: v })),
      ...odd.map(v => ({ title: 't', subtitle: 's', notes: [v, { big: v, label: v, tone: v }], bars: [v, { label: v, value: v, text: v }], stamps: [v, { text: v, tone: v }] })),
      { title: 't', subtitle: '', notes: [{ big: '1', label: 'a', tone: 'constructor' }, { big: '2', label: 'b', tone: '__proto__' }], stamps: [{ text: 'x', tone: 'toString' }] },
      { title: 't', subtitle: '', notes: [], bars: [{ label: 'a', value: 1e308 }, { label: 'b', value: 5e-324 }, { label: 'c', value: -0 }, { label: 'd', value: '7' }] },
    ]
    for (const spec of specs) {
      for (const width of [undefined, ...WIDTHS]) {
        const page = (width === undefined ? spec : { ...(spec as object), width }) as JournalSpec
        const r = portoSvg(page)
        const svg = parse(r.source)
        expect(forbidden(r.source)).toEqual([])
        expect(r.alt.length).toBeGreaterThan(0)
        expect(r.alt.startsWith('明信片插图「')).toBe(true)
        expect(Number.isInteger(r.width) && Number.isInteger(r.height) && r.height > 0).toBe(true)
        expect(svg.attrs.viewBox).toBe(`0 0 ${r.width} ${r.height}`)
        walk(svg, el => {
          for (const key of MEASURES) if (el.attrs[key] !== undefined) expect(el.attrs[key], `${el.name} ${key}`).toMatch(/^-?\d+(\.\d+)?$/)
          if (el.attrs.d !== undefined) expect(el.attrs.d, 'a path').toMatch(/^M[MLHVZhvzaqt0-9 .-]*$/)
        })
        for (const el of all(svg, 'text')) expect(finite(textBox(el))).toBe(true)
      }
    }
    // a number that is none never becomes a length: a bar worth NaN is a tick, a width of NaN the usual one
    const none = portoSvg({ title: 't', subtitle: '', notes: [], bars: [{ label: 'a', value: NaN, text: 'x' }, { label: 'b', value: Infinity, text: 'y' }], width: NaN })
    expect(none.source).not.toMatch(/NaN|Infinity|undefined/)
    expect(none.width).toBe(460)
    // what is not a string is written as journal writes it: nothing for none, else its words
    expect(written(parse(portoSvg({ title: undefined, subtitle: null, notes: [] } as unknown as JournalSpec).source))).toEqual([])
    expect(written(parse(portoSvg({ title: 42, subtitle: true, notes: [] } as unknown as JournalSpec).source))).toEqual(['true', '42'])
  })
})

// ---------- what is drawn ----------

describe('porto: parts', () => {
  test('the first three notes, six bars and four stamps are drawn', () => {
    const notes: JournalNote[] = [1, 2, 3, 4, 5].map(i => ({ big: `N${i}`, label: `note${i}` }))
    const bars: JournalBar[] = [1, 2, 3, 4, 5, 6, 7, 8].map(i => ({ label: `bar${i}`, value: i, text: `val${i}` }))
    const stamps: JournalStamp[] = [1, 2, 3, 4, 5, 6].map(i => ({ text: `S${i}` }))
    for (const width of WIDTHS) {
      const r = portoSvg({ title: 'caps', subtitle: 'many', notes, barsTitle: 'bars', bars, stamps, width })
      const svg = parse(r.source)
      const shown = written(svg)
      expect(shown.filter(s => /^N\d$/.test(s))).toEqual(['N1', 'N2', 'N3'])
      expect(shown.filter(s => /^note\d$/.test(s))).toEqual(['note1', 'note2', 'note3'])
      expect(chartRows(svg).map(row => row.label)).toEqual(['bar1', 'bar2', 'bar3', 'bar4', 'bar5', 'bar6'])
      expect(chartRows(svg).map(row => row.text)).toEqual(['val1', 'val2', 'val3', 'val4', 'val5', 'val6'])
      expect(shown.filter(s => /^S\d$/.test(s))).toEqual(['S1', 'S2', 'S3', 'S4'])
      expect(tags(svg)).toHaveLength(4)
      // the longest bar is the sixth, not the eighth that is not drawn
      const lens = chartRows(svg).map(row => row.len)
      expect(Math.max(...lens)).toBe(lens[5] ?? NaN)
      for (const gone of ['N4', 'N5', 'note4', 'note5', 'bar7', 'bar8', 'val7', 'val8', 'S5', 'S6']) {
        expect(shown.join('\n')).not.toContain(gone)
        expect(r.alt).not.toContain(gone)
      }
    }
  })

  test('a part with no data is left out and the page is that much shorter; the view is always there, once', () => {
    for (const width of WIDTHS) {
      const full = portoSvg({ ...BASE, width })
      const fullSvg = parse(full.source)
      for (const cls of ['paper', 'view', 'town', 'masthead', 'cards', 'bars', 'tags']) expect(groups(fullSvg, cls)).toHaveLength(1)
      expect(groups(fullSvg, 'card')).toHaveLength(3)
      expect(groups(fullSvg, 'row')).toHaveLength(3)

      const noNotes = portoSvg({ ...BASE, notes: [], width })
      expect(group(parse(noNotes.source), 'cards')).toBeUndefined()
      expect(noNotes.height).toBeLessThan(full.height)
      expect(noNotes.alt).not.toContain('数字')

      for (const bars of [[], undefined]) {
        const noBars = portoSvg({ ...BASE, bars, width })
        expect(group(parse(noBars.source), 'bars')).toBeUndefined()
        expect(groups(parse(noBars.source), 'row')).toHaveLength(0)
        expect(noBars.source).not.toContain('谁最占地方')
        expect(noBars.alt).not.toContain('谁最占地方')
        expect(noBars.height).toBeLessThan(full.height)
      }

      for (const stamps of [[], undefined, [{ text: '' }, { text: '  ' }]]) {
        const noStamps = portoSvg({ ...BASE, stamps, width })
        expect(group(parse(noStamps.source), 'tags')).toBeUndefined()
        expect(noStamps.height).toBeLessThan(full.height)
        expect(noStamps.alt).not.toContain('标签')
      }

      const bare = portoSvg({ title: BASE.title, subtitle: BASE.subtitle, notes: [], barsTitle: BASE.barsTitle, width })
      const bareSvg = parse(bare.source)
      for (const cls of ['cards', 'card', 'bars', 'tags', 'row']) expect(groups(bareSvg, cls)).toHaveLength(0)
      expect(written(bareSvg)).toEqual([BASE.subtitle, BASE.title])
      for (const other of [noNotes, portoSvg({ ...BASE, bars: [], width }), portoSvg({ ...BASE, stamps: [], width })]) {
        expect(bare.height).toBeLessThan(other.height)
      }

      const untitled = portoSvg({ ...BASE, barsTitle: undefined, width })
      expect(untitled.height).toBeLessThan(full.height)
      expect(chartRows(parse(untitled.source))).toHaveLength(3)

      // the view and the line of swell are the page's own: they stay when nothing is written, and the view is the same
      const blank = portoSvg({ title: '', subtitle: '', notes: [], width })
      const blankSvg = parse(blank.source)
      expect(written(blankSvg)).toEqual([])
      for (const cls of ['paper', 'view', 'town', 'masthead']) expect(groups(blankSvg, cls)).toHaveLength(1)
      expect(blank.height).toBeLessThanOrEqual(bare.height)
      const picture = (source: string) => /<g class="view">.*?<\/g><\/g>/.exec(source)?.[0]
      expect(picture(blank.source)).toBe(picture(full.source))
      expect(picture(full.source)?.length ?? 0).toBeGreaterThan(3000)
    }
  })

  test('the paper is cream with a hairline edge, and fills the image with a small margin', () => {
    for (const [, spec] of PAGES) {
      for (const width of WIDTHS) {
        const r = portoSvg({ ...spec, width })
        const svg = parse(r.source)
        const paper = paperBox(svg)
        expect(inside(paper, { x0: 0, x1: r.width, y0: 0, y1: r.height })).toBe(true)
        expect(paper.x0).toBeLessThanOrEqual(12)
        expect(r.width - paper.x1).toBeLessThanOrEqual(12)
        expect(paper.y0).toBeLessThanOrEqual(12)
        expect(r.height - paper.y1).toBeLessThanOrEqual(12)
        const sheet = all(group(svg, 'paper'), 'rect')[0]
        expect(sheet?.attrs.fill).toBe(PORTO.paper)
        expect(sheet?.attrs.stroke).toBe(PORTO.paperEdge)
        expect(sheet?.attrs['stroke-width']).toBe('1')
        expect(n(sheet, 'rx')).toBeGreaterThan(0)
        expect(n(sheet, 'rx')).toBeLessThanOrEqual(6)
      }
    }
  })

  test('the view: sky and sun, the quay, the sea with two lines of swell and a boat or two, across the top inside the page', () => {
    const heights: number[] = []
    for (const width of SWEEP) {
      const svg = parse(portoSvg({ ...BASE, width }).source)
      const paper = paperBox(svg)
      const v = view(svg)
      const sky = rectBox(v.sky)
      const quay = rectBox(v.quay)
      const sea = rectBox(v.sea)
      const where = `at ${width}`
      // a mat of paper round it on three sides, as round a postcard's picture
      expect(v.box.x0 - paper.x0, where).toBe(5)
      expect(paper.x1 - v.box.x1, where).toBe(5)
      expect(v.box.y0 - paper.y0, where).toBe(5)
      for (const side of [v.box.x0, v.box.x1, v.box.y0, v.box.y1]) expect(Number.isInteger(side), where).toBe(true)
      heights.push(v.box.y1 - v.box.y0)
      expect(v.box.y1 - v.box.y0).toBe(grow(width, 100, 155))
      // the sky over the quay's line over the sea, each the view's whole width
      expect(v.sky?.attrs.fill).toBe(PORTO.sky)
      expect(v.quay?.attrs.fill).toBe(PORTO.quay)
      expect(v.sea?.attrs.fill).toBe(PORTO.sea)
      for (const band of [sky, quay, sea]) expect([band.x0, band.x1]).toEqual([v.box.x0, v.box.x1])
      expect(quay.y1).toBe(sea.y0)
      expect(sky.y1).toBe(sea.y0)
      expect(quay.y1 - quay.y0).toBeGreaterThanOrEqual(3)
      expect(quay.y1 - quay.y0).toBeLessThanOrEqual(4)
      expect(sea.y1 - sea.y0).toBeGreaterThanOrEqual(24)
      expect(sea.y1 - sea.y0).toBeLessThan((v.box.y1 - v.box.y0) / 3)
      // the sun: a disc in the sky, towards the right
      const sun = circleBox(v.sun)
      expect(v.sun?.attrs.fill).toBe(PORTO.sun)
      expect(inside(sun, { x0: sky.x0, x1: sky.x1, y0: sky.y0 + 4, y1: quay.y0 }), where).toBe(true)
      expect((sun.x0 + sun.x1) / 2).toBeGreaterThan(v.box.x0 + (v.box.x1 - v.box.x0) * 0.7)
      // two lines of swell in the pale sea colour, whole waves, the lower one shorter, both on the sea
      expect(v.swells).toHaveLength(2)
      const [upper, lower] = v.swells.map(p => pathBox(p.attrs.d ?? ''))
      for (const p of v.swells) {
        expect(p.attrs.stroke).toBe(PORTO.seaPale)
        expect(p.attrs.fill).toBe('none')
        expect((p.attrs.d ?? '').split('q').length).toBe((p.attrs.d ?? '').split('t').length)
      }
      for (const line of [upper ?? NOWHERE, lower ?? NOWHERE]) {
        expect(inside(line, { x0: sea.x0 + 4, x1: sea.x1 - 4, y0: sea.y0 + 3, y1: sea.y1 - 3 }), where).toBe(true)
        expect(Math.abs(line.x0 + line.x1 - v.box.x0 - v.box.x1), where).toBeLessThan(0.6)
        expect((line.x1 - line.x0) % 16).toBe(0)
      }
      expect((lower?.x1 ?? NaN) - (lower?.x0 ?? NaN)).toBeLessThan((upper?.x1 ?? NaN) - (upper?.x0 ?? NaN))
      expect(lower?.y0 ?? NaN).toBeGreaterThan(upper?.y1 ?? NaN)
      // one boat on a narrow page, two from 400 up: each whole on the sea, its hull, its two sails
      expect(v.boats).toHaveLength(width < 400 ? 1 : 2)
      for (const boat of v.boats) {
        expect(all(boat, 'path')).toHaveLength(3)
        for (const piece of all(boat, 'path')) expect(inside(pathBox(piece.attrs.d ?? ''), { x0: sea.x0 + 8, x1: sea.x1 - 8, y0: sea.y0 + 1, y1: sea.y1 - 2 }), where).toBe(true)
      }
      if (v.boats.length === 2) expect(gap(boxOf(all(v.boats[0], 'path').flatMap(p => pathPoints(p.attrs.d ?? '').flat())), boxOf(all(v.boats[1], 'path').flatMap(p => pathPoints(p.attrs.d ?? '').flat())))).toBeGreaterThan(40)
    }
    // roughly 100px tall on the narrowest page to 155px on the widest
    expect(heights[0]).toBe(100)
    expect(heights[heights.length - 1]).toBe(155)
  })

  test('the town: the look’s houses shoulder to shoulder on the quay, whole, from one side of the view to the other', () => {
    const strip = (markup: string) =>
      markup
        .replace(new RegExp(`<rect [^>]*fill="(${PORTO.shutter}|${PORTO.window})"/>`, 'g'), '')
        .replace(new RegExp(`<path [^>]*fill="(${PORTO.door}|${PORTO.shutter}|${PORTO.window})"/>`, 'g'), '')
    const rects = (markup: string, fill: string) => [...markup.matchAll(new RegExp(`<rect x="([\\d.-]+)" y="([\\d.-]+)" width="([\\d.]+)" height="([\\d.]+)" fill="${fill}"/>`, 'g'))].map(m => ({ x0: Number(m[1]), x1: Number(m[1]) + Number(m[3]), y0: Number(m[2]), y1: Number(m[2]) + Number(m[4]) }))
    for (let width = 320; width <= 680; width += 4) {
      const r = portoSvg({ ...BASE, width })
      const svg = parse(r.source)
      const v = view(svg)
      const quay = rectBox(v.quay)
      const houses = walls(svg)
      const where = `at ${width}`
      const first = houses[0] ?? NOWHERE
      const last = houses[houses.length - 1] ?? NOWHERE
      // whole houses, on whole px, wall to wall: no more than 12px of sky left at the two ends together
      expect(houses.length, where).toBeGreaterThanOrEqual(10)
      houses.forEach((house, i) => {
        expect(house.y1, where).toBe(quay.y0)
        expect(Number.isInteger(house.x0) && Number.isInteger(house.x1) && Number.isInteger(house.y0), where).toBe(true)
        const next = houses[i + 1]
        if (next) expect(next.x0, where).toBe(house.x1)
      })
      expect(first.x0, where).toBeGreaterThanOrEqual(v.box.x0)
      expect(last.x1, where).toBeLessThanOrEqual(v.box.x1)
      expect(first.x0 - v.box.x0 + (v.box.x1 - last.x1), where).toBeLessThanOrEqual(12)
      expect(v.box.x1 - last.x1 - (first.x0 - v.box.x0), where).toBeGreaterThanOrEqual(0)
      expect(v.box.x1 - last.x1 - (first.x0 - v.box.x0), where).toBeLessThanOrEqual(1)
      // the tallest is 46px to its eaves on the narrowest page, 78px on the widest; a house 26 to 44px wide, give or take a few
      const unit = grow(width, 26, 44)
      expect(Math.max(...houses.map(h => h.y1 - h.y0)), where).toBe(grow(width, 46, 78))
      for (const house of houses) {
        expect(house.x1 - house.x0, where).toBeGreaterThanOrEqual(Math.round((unit - 2) * 0.75))
        expect(house.x1 - house.x0, where).toBeLessThanOrEqual(Math.round((unit + 2) * 1.15))
      }
      // every roof is under the sky's top: nothing of the town leaves the view
      for (const el of all(v.town)) {
        const box = shapeBox(el)
        if (box) expect(inside(box, { x0: v.box.x0 - 1, x1: v.box.x1 + 1, y0: v.box.y0 + 6, y1: quay.y0 }), where).toBe(true)
      }
      // it is the look's own town: one of the house widths within two px of the usual gives this very row
      const mine = /<g class="town">(.*?)<\/g>/.exec(r.source)?.[1] ?? ''
      const theirs = [unit, unit - 1, unit + 1, unit - 2, unit + 2].map(u => lookTown(first.x0, last.x1, quay.y0, grow(width, 46, 78), u)).find(markup => strip(markup) === strip(mine))
      if (theirs === undefined) throw new Error(`${where}: not a town the look draws`)
      // its doors, shutters and panes are each gathered into one path, piece for piece where the look put them
      expect(mine).not.toContain(`<rect x="0" y="0"`)
      for (const fill of [PORTO.shutter, PORTO.window]) {
        expect(rects(mine, fill), `${where}: ${fill}`).toHaveLength(0)
        const paths = all(v.town, 'path').filter(p => p.attrs.fill === fill)
        expect(paths, `${where}: ${fill}`).toHaveLength(1)
        const pieces = pathPoints(paths[0]?.attrs.d ?? '').map(boxOf)
        const want = rects(theirs, fill)
        expect(pieces.length, `${where}: ${fill}`).toBe(want.length)
        expect(pieces.length).toBeGreaterThan(houses.length)
        pieces.forEach((piece, i) => {
          for (const side of ['x0', 'x1', 'y0', 'y1'] as const) expect(Math.abs(piece[side] - (want[i]?.[side] ?? NaN)), `${where}: ${fill} ${i}`).toBeLessThan(0.11)
          // inside its own house's wall and clear of the walls beside it: nothing drawn after it lies over it
          expect(houses.filter(house => inside(piece, { x0: house.x0 + 1.5, x1: house.x1 - 1.5, y0: house.y0, y1: house.y1 })), `${where}: ${fill} ${i}`).toHaveLength(1)
        })
      }
      const doors = all(v.town, 'path').filter(p => p.attrs.fill === PORTO.door)
      expect(doors).toHaveLength(1)
      expect(doors[0]?.attrs.d).toBe([...theirs.matchAll(new RegExp(`<path d="([^"]*)" fill="${PORTO.door}"/>`, 'g'))].map(m => m[1]).join(''))
      for (const door of pathPoints(doors[0]?.attrs.d ?? '').map(boxOf)) expect(houses.filter(house => inside(door, { x0: house.x0 + 1.5, x1: house.x1 - 1.5, y0: house.y0, y1: house.y1 }))).toHaveLength(1)
    }
  })

  test('the masthead: a letter-spaced kicker in the sans over a large title, a line of swell across the content under them', () => {
    const sizes: number[] = []
    for (const width of WIDTHS) {
      const svg = parse(portoSvg({ ...BASE, width }).source)
      const col = column(svg)
      const paper = paperBox(svg)
      const [kicker, title] = all(group(svg, 'masthead'), 'text')
      expect(all(group(svg, 'masthead'), 'text')).toHaveLength(2)
      expect(said(kicker ?? svg)).toBe(BASE.subtitle)
      expect(kicker?.attrs['font-family']).toBe(PORTO_SANS)
      expect(kicker?.attrs.fill).toBe(PORTO.seaDeep)
      expect(n(kicker, 'letter-spacing')).toBeGreaterThanOrEqual(1)
      expect(n(kicker, 'font-size')).toBeGreaterThanOrEqual(11)
      expect(n(kicker, 'font-size')).toBeLessThanOrEqual(13)
      expect(said(title ?? svg)).toBe('Atlas')
      expect(title?.attrs['font-family']).toBeUndefined()
      expect(title?.attrs.fill).toBe(PORTO.roofDeep)
      sizes.push(n(title, 'font-size'))
      // both on the one left edge, under the view, the kicker over the title
      expect(n(kicker, 'x')).toBe(col.x0)
      expect(n(title, 'x')).toBe(col.x0)
      expect(textBox(kicker ?? svg).y0).toBeGreaterThanOrEqual(view(svg).box.y1 + 14)
      expect(textBox(kicker ?? svg).y1).toBeLessThan(textBox(title ?? svg).y0 + n(title, 'font-size') * 0.1)
      // the swell: one line in the sea's colour, whole waves from the left edge to within 2px of the right one
      const lines = all(group(svg, 'masthead'), 'path')
      expect(lines).toHaveLength(1)
      expect(lines[0]?.attrs.stroke).toBe(PORTO.sea)
      expect(lines[0]?.attrs.fill).toBe('none')
      const d = lines[0]?.attrs.d ?? ''
      expect(d.split('q').length).toBe(d.split('t').length)
      const box = pathBox(d)
      expect(box.x0).toBe(col.x0)
      expect(col.x1 - box.x1).toBeGreaterThanOrEqual(-0.05)
      expect(col.x1 - box.x1).toBeLessThan(2)
      expect(box.y0).toBeGreaterThanOrEqual(textBox(title ?? svg).y1 + 4)
      // generous margins: the column stands well inside the paper, the same on both sides
      expect(col.x0 - paper.x0).toBeGreaterThanOrEqual(20)
      expect(Math.abs(col.x0 - paper.x0 - (paper.x1 - col.x1))).toBeLessThan(0.01)
    }
    // large: 32px on the narrowest page to 48px on the widest
    expect(sizes).toEqual([32, 38, 48])
    // a long title is set smaller before it is cut, and never under 22px
    for (const width of WIDTHS) {
      const svg = parse(portoSvg({ ...LONG, width }).source)
      const title = all(group(svg, 'masthead'), 'text')[1]
      expect(n(title, 'font-size')).toBeLessThan(32)
      expect(n(title, 'font-size')).toBeGreaterThanOrEqual(22)
      expect(said(title ?? svg).endsWith('…')).toBe(true)
      const fits = parse(portoSvg({ ...BASE, title: 'Atlas of the Sea', width }).source)
      const whole = all(group(fits, 'masthead'), 'text')[1]
      expect(said(whole ?? fits)).toBe('Atlas of the Sea')
      expect(textBox(whole ?? fits).x1).toBeLessThanOrEqual(column(fits).x1)
    }
    // with nothing written the swell still closes the head, under the view
    const blank = parse(portoSvg({ title: '', subtitle: '', notes: [], width: 460 }).source)
    expect(pathBox(all(group(blank, 'masthead'), 'path')[0]?.attrs.d ?? '').y0).toBeGreaterThanOrEqual(view(blank).box.y1 + 12)
  })

  test('cards are house fronts: a pale wall by tone with a deeper edge, a tiled roof along the top, the writing in the tone’s ink', () => {
    const fills = (spec: JournalSpec) => cards(parse(portoSvg(spec).source)).map(card => card.sheet.attrs.fill)
    const T = PORTO_TONES
    expect(fills(BASE)).toEqual([T.peach.pale, T.rose.pale, T.foam.pale])
    expect(fills({ ...BASE, notes: [{ big: '1', label: 'a', tone: 'blue' }, { big: '2', label: 'b', tone: 'purple' }, { big: '3', label: 'c', tone: 'yellow' }] })).toEqual([T.sky.pale, T.lilac.pale, T.peach.pale])
    expect(fills({ ...BASE, notes: [{ big: '1', label: 'a', tone: 'pink' }, { big: '2', label: 'b', tone: 'mint' }, { big: '3', label: 'c' }] })).toEqual([T.rose.pale, T.foam.pale, T.foam.pale])
    for (const width of SWEEP) {
      const page = cards(parse(portoSvg({ ...BASE, notes: [{ big: '7', label: 'x', tone: 'purple' }, { big: '8', label: 'y', tone: 'blue' }, { big: '9', label: 'z', tone: 'yellow' }], width }).source))
      const tones = [T.lilac, T.sky, T.peach]
      page.forEach((card, i) => {
        expect(card.sheet.attrs.fill).toBe(tones[i]?.pale)
        expect(card.sheet.attrs.stroke).toBe(tones[i]?.deep)
        expect(card.sheet.attrs['stroke-width']).toBe('1')
        expect(card.sheet.attrs.rx).toBeUndefined()
        expect(card.big?.attrs.fill).toBe(tones[i]?.ink)
        expect(card.big?.attrs['font-family']).toBeUndefined()
        for (const line of card.lines) {
          expect(line.attrs.fill).toBe(tones[i]?.ink)
          expect(line.attrs['font-family']).toBe(PORTO_SANS)
          expect(n(line, 'font-size')).toBeLessThan(n(card.big, 'font-size'))
        }
        // the roof: in the roof's colour, 2px proud of the wall on three sides, its lower edge a row of tiles about 7px wide
        const d = card.roof?.attrs.d ?? ''
        const roof = pathPoints(d)[0] ?? []
        expect(card.roof?.attrs.fill).toBe(PORTO.roof)
        expect(Math.abs((roof[0]?.x ?? NaN) - (card.box.x0 - 2))).toBeLessThan(0.06)
        expect(Math.abs((roof[1]?.x ?? NaN) - (card.box.x1 + 2))).toBeLessThan(0.06)
        expect(roof[0]?.y).toBe(card.box.y0 - 2)
        const tiles = d.split('a').length - 1
        const tile = (card.box.x1 - card.box.x0 + 4) / tiles
        expect(tile).toBeGreaterThan(5.5)
        expect(tile).toBeLessThan(8.5)
        // the tiles end where the roof began: the last arc closes on the left eave
        expect(Math.abs((roof[roof.length - 1]?.x ?? NaN) - (card.box.x0 - 2))).toBeLessThan(0.2)
        const foot = pathBox(d).y1
        expect(foot - card.box.y0).toBeGreaterThan(4)
        expect(foot - card.box.y0).toBeLessThan(8)
        // the roof is the only strong colour on the card but for its window
        for (const el of card.pane) expect([PORTO.shutter, PORTO.window]).toContain(el.attrs.fill)
      })
    }
  })

  test('a small shuttered window stands in a card’s top right corner only where it is 6px clear of the writing', () => {
    let withOne = 0
    let without = 0
    for (const [name, spec] of EVERY) {
      for (const width of SWEEP) {
        for (const card of cards(parse(portoSvg({ ...spec, width }).source))) {
          const where = `${name} at ${width}`
          if (card.pane.length === 0) {
            without++
            continue
          }
          withOne++
          // green shutters either side of a pane: 12px by 9px in all
          const [shutters, pane] = card.pane
          expect(card.pane).toHaveLength(2)
          expect(shutters?.attrs.fill).toBe(PORTO.shutter)
          expect(pane?.attrs.fill).toBe(PORTO.window)
          const box = rectBox(shutters)
          expect([n(shutters, 'width'), n(shutters, 'height')]).toEqual([12, 9])
          expect([n(pane, 'width'), n(pane, 'height')]).toEqual([6, 9])
          expect(inside(rectBox(pane), box)).toBe(true)
          expect(Math.abs(rectBox(pane).x0 - box.x0 - (box.x1 - rectBox(pane).x1))).toBeLessThan(0.01)
          // in the top right corner, inside the wall, under the roof
          expect(card.box.x1 - box.x1, where).toBeGreaterThanOrEqual(8)
          expect(card.box.x1 - box.x1, where).toBeLessThanOrEqual(16)
          expect(box.y0 - pathBox(card.roof?.attrs.d ?? '').y1, where).toBeGreaterThanOrEqual(5)
          expect(box.y0 - card.box.y0, where).toBeLessThan(20)
          expect(card.box.y1 - box.y1, where).toBeGreaterThanOrEqual(6)
          for (const el of [card.big, ...card.lines]) if (el) expect(gap(box, textBox(el)), `${where}: "${said(el)}"`).toBeGreaterThanOrEqual(6)
        }
      }
    }
    expect(withOne).toBeGreaterThan(100)
    expect(without).toBeGreaterThan(100)
    const windows = (spec: JournalSpec) => cards(parse(portoSvg(spec).source)).map(card => card.pane.length > 0)
    // short numbers leave room; a number that fills its line leaves none
    expect(windows({ ...BASE, width: 460 })).toEqual([true, true, false])
    expect(windows({ ...BASE, width: 680 })).toEqual([true, true, false])
    for (const width of [320, 460]) expect(windows({ ...LONG, width })).toEqual([false, false, false])
    // on the widest page a long number set small stands low enough to leave the corner free
    expect(windows({ ...LONG, width: 680 })).toEqual([true, true, true])
  })

  test('tags are rounded, their line and their writing one quiet colour by tone', () => {
    const colors = (stamps: JournalStamp[]) => tags(parse(portoSvg({ ...BASE, stamps }).source)).map(tag => tag.border.attrs.stroke)
    expect(colors([{ text: 'a', tone: 'coral' }, { text: 'b', tone: 'purple' }, { text: 'c', tone: 'teal' }])).toEqual([PORTO.roof, PORTO.lilacDeep, PORTO.seaDeep])
    expect(colors([{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd', tone: 'teal' }])).toEqual([PORTO.roof, PORTO.lilacDeep, PORTO.seaDeep, PORTO.seaDeep])
    for (const width of WIDTHS) {
      for (const tag of tags(parse(portoSvg({ ...BASE, width }).source))) {
        expect(n(tag.border, 'rx')).toBeGreaterThanOrEqual(4)
        expect(n(tag.border, 'rx')).toBeLessThanOrEqual(12)
        expect(tag.border.attrs.fill).toBe('none')
        expect(tag.border.attrs['stroke-width']).toBe('1')
        expect(tag.text?.attrs.fill).toBe(tag.border.attrs.stroke)
        expect(tag.text?.attrs['font-family']).toBe(PORTO_SANS)
        expect(tag.text?.attrs['text-anchor']).toBe('middle')
      }
    }
  })

  test('the foot is paper: nothing is drawn under the last part, and there is no second town', () => {
    for (const [name, spec] of PAGES) {
      for (const width of SWEEP) {
        const svg = parse(portoSvg({ ...spec, width }).source)
        const paper = paperBox(svg)
        let lowest = 0
        walk(svg, (el, above) => {
          if (above.some(g => g.attrs.class === 'paper')) return
          const box = el.name === 'text' ? textBox(el) : shapeBox(el)
          if (box) lowest = Math.max(lowest, box.y1)
        })
        expect(paper.y1 - lowest, `${name} at ${width}`).toBeGreaterThanOrEqual(16)
        expect(paper.y1 - lowest, `${name} at ${width}`).toBeLessThanOrEqual(34)
        expect(groups(svg, 'town')).toHaveLength(1)
        expect(groups(svg, 'view')).toHaveLength(1)
        // the walls' strong colours are the town's alone, but for the bars
        walk(svg, (el, above) => {
          if (!(PORTO_WALLS as readonly string[]).includes(el.attrs.fill ?? '')) return
          expect(above.some(g => g.attrs.class === 'town' || g.attrs.class === 'bars'), `${name} at ${width}`).toBe(true)
        })
      }
    }
  })
})

// ---------- bars ----------

describe('porto: bars', () => {
  const chart = (bars: JournalBar[], width?: number) => {
    const r = portoSvg({ title: 't', subtitle: 's', notes: [], bars, width })
    return { r, rows: chartRows(parse(r.source)) }
  }

  test('a bar is as long as its share of the largest value', () => {
    for (const width of WIDTHS) {
      const values = [100, 50, 25, 10, 80, 100]
      const { rows } = chart(values.map((value, i) => ({ label: `row${i}`, value, text: String(value) })), width)
      const full = rows[0]?.len ?? NaN
      expect(full).toBeGreaterThan(60)
      rows.forEach((row, i) => {
        const want = ((values[i] ?? NaN) / 100) * full
        expect(Math.abs(row.len - want)).toBeLessThanOrEqual(0.25)
      })
      // every bar starts on the same line, in the order given, one under the other, all the same height
      expect(new Set(rows.map(row => row.x)).size).toBe(1)
      expect(new Set(rows.map(row => Math.round((row.bottom - row.top) * 10))).size).toBe(1)
      rows.forEach((row, i) => {
        const next = rows[i + 1]
        if (next) expect(next.top).toBeGreaterThan(row.bottom + 8)
      })
      // the town's colours in turn: terracotta, ochre, pink, the sea, coral, peach
      expect(rows.map(row => row.color)).toEqual([PORTO_WALLS[0], PORTO_WALLS[1], PORTO_WALLS[2], PORTO.sea, PORTO_WALLS[4], PORTO_WALLS[5]])
    }
  })

  test('a bar is a flat rectangle with square ends; its label in the sans in ink, its text slanted in the deep sea colour', () => {
    for (const width of WIDTHS) {
      const svg = parse(portoSvg({ ...BASE, width }).source)
      for (const g of groups(svg, 'row')) {
        const bar = all(g, 'rect')[0]
        expect(all(g, 'rect')).toHaveLength(1)
        expect(bar?.attrs.rx).toBeUndefined()
        expect(bar?.attrs.stroke).toBeUndefined()
      }
      for (const row of chartRows(svg)) {
        expect(row.labelEl?.attrs.fill).toBe(PORTO.ink)
        expect(row.labelEl?.attrs['font-family']).toBe(PORTO_SANS)
        expect(row.textEl?.attrs.fill).toBe(PORTO.seaDeep)
        expect(row.textEl?.attrs['font-style']).toBe('italic')
        expect(row.textEl?.attrs['font-family']).toBeUndefined()
        // the label is level with its bar
        const label = textBox(row.labelEl ?? svg)
        expect(label.y0).toBeLessThan((row.top + row.bottom) / 2)
        expect(label.y1).toBeGreaterThan((row.top + row.bottom) / 2)
      }
    }
  })

  test('the bars use the room between the labels and what is written after them', () => {
    for (const spec of [BASE, LONG]) {
      for (let width = 320; width <= 680; width += 30) {
        const svg = parse(portoSvg({ ...spec, width }).source)
        const col = column(svg)
        const rows = chartRows(svg)
        const longest = Math.max(...rows.map(row => row.len))
        expect(longest).toBeGreaterThan(50)
        for (const row of rows) {
          if (row.labelEl) {
            expect(n(row.labelEl, 'x')).toBe(col.x0)
            expect(textBox(row.labelEl).x1).toBeLessThanOrEqual(row.x - 6)
          }
          if (row.textEl) {
            expect(textBox(row.textEl).x0).toBeGreaterThanOrEqual(row.x + row.len + 4)
            expect(textBox(row.textEl).x1).toBeLessThanOrEqual(col.x1 + 0.05)
          }
          expect(row.x + row.len).toBeLessThanOrEqual(col.x1)
        }
        // the longest bar and its text reach the right edge, give or take the last letter
        const widest = Math.max(...rows.map(row => (row.textEl ? textBox(row.textEl).x1 : row.x + row.len)))
        expect(col.x1 - widest).toBeLessThan(40)
      }
    }
  })

  test('zero, negative, NaN and infinite values count as nothing and never reach the output', () => {
    for (const width of WIDTHS) {
      const { r, rows } = chart([0, -5, NaN, Infinity, -Infinity, 7].map(value => ({ label: 'v', value })), width)
      expect(r.source).not.toMatch(/NaN|Infinity/)
      expect(r.alt).not.toMatch(/NaN|Infinity/)
      expect(rows.map(row => row.len > 0)).toEqual([false, false, false, false, false, true])
      expect(rows.map(row => row.isTick)).toEqual([true, true, true, true, true, false])
      expect(rows.map(row => row.text)).toEqual(['0', '0', '0', '0', '0', '7'])
      expect(rows[5]?.len ?? 0).toBeGreaterThan(60)
      for (const row of rows) expect([row.x, row.len, row.top, row.bottom].every(Number.isFinite)).toBe(true)
      // nothing is a thin tick in the row's own colour, as tall as a bar
      expect(rows[0]?.color).toBe(PORTO_WALLS[0])
      expect((rows[0]?.bottom ?? NaN) - (rows[0]?.top ?? NaN)).toBe((rows[5]?.bottom ?? NaN) - (rows[5]?.top ?? NaN))
    }
  })

  test('all-zero bars divide nothing by zero', () => {
    for (const values of [[0, 0, 0], [NaN], [-1, -2], [Infinity, Infinity]]) {
      const { r, rows } = chart(values.map(value => ({ label: 'none', value, text: 'nothing' })))
      expect(r.source).not.toMatch(/NaN|Infinity/)
      expect(forbidden(r.source)).toEqual([])
      expect(rows).toHaveLength(values.length)
      for (const row of rows) {
        expect(row.len).toBe(0)
        expect(row.text).toBe('nothing')
      }
    }
  })

  test('a small value still shows a stub, and the value is written when no text is given', () => {
    const { rows } = chart([{ label: 'big', value: 1_000_000 }, { label: 'tiny', value: 1 }, { label: 'half', value: 0.5 }, { label: 'frac', value: 1234.5678 }])
    expect(rows[1]?.len ?? 0).toBeGreaterThanOrEqual(3)
    expect(rows[1]?.len ?? 99).toBeLessThan(8)
    expect(rows[2]?.len ?? 0).toBeGreaterThanOrEqual(3)
    expect(rows.map(row => row.text)).toEqual(['1000000', '1', '0.5', '1234.57'])
    // an empty text is the caller's choice: nothing is written after the bar
    const quiet = chart([{ label: 'a', value: 3, text: '' }]).rows
    expect(quiet[0]?.textEl).toBeUndefined()
  })

  test('the heading: a small house for its bullet, the text in ink, a hairline to the right edge', () => {
    for (const spec of [BASE, LONG, allFields('MWM@WMW HHOOQQ')]) {
      for (const width of SWEEP) {
        const svg = parse(portoSvg({ ...spec, width }).source)
        const col = column(svg)
        const bars = group(svg, 'bars')
        const heading = own(bars, 'text')[0]
        const [wall, pane] = own(bars, 'rect')
        const [roof, rule] = own(bars, 'path')
        if (!heading || !wall || !pane || !roof || !rule) throw new Error('a heading short of a piece')
        // the house: an ochre wall under a pitched roof, one pane, as the look draws its second house
        expect(wall.attrs.fill).toBe(PORTO_WALLS[1])
        expect(roof.attrs.fill).toBe(PORTO.roof)
        expect(pane.attrs.fill).toBe(PORTO.window)
        const home = boxOf([...pathPoints(roof.attrs.d ?? '').flat(), { x: rectBox(wall).x0, y: rectBox(wall).y1 }])
        expect(home.x0).toBe(col.x0)
        expect(home.x1 - home.x0).toBeLessThanOrEqual(13)
        expect(home.y1 - home.y0).toBeLessThanOrEqual(13)
        expect(inside(rectBox(pane), rectBox(wall))).toBe(true)
        // it stands on the heading's own line
        expect(home.y1).toBe(n(heading, 'y'))
        expect(heading.attrs.fill).toBe(PORTO.ink)
        expect(heading.attrs['font-family']).toBeUndefined()
        expect(rule.attrs.stroke).toBe(PORTO.quay)
        const box = textBox(heading)
        const line = pathBox(rule.attrs.d ?? '')
        expect(home.x1).toBeLessThanOrEqual(box.x0 - 4)
        expect(line.x0).toBeGreaterThanOrEqual(box.x1 + 8)
        expect(line.x1).toBe(col.x1)
        expect(line.x1 - line.x0).toBeGreaterThanOrEqual(12)
        // the rule is level with the middle of the text
        expect(line.y0).toBeGreaterThan(box.y0)
        expect(line.y0).toBeLessThan(box.y1)
        // the first bar starts under the heading
        expect(chartRows(svg)[0]?.top ?? 0).toBeGreaterThan(box.y1 + 4)
      }
    }
  })
})

// ---------- layout ----------

describe('porto: layout', () => {
  test('long text is cut with an ellipsis, in CJK and in Latin', () => {
    for (const width of WIDTHS) {
      const svg = parse(portoSvg({ ...LONG, width }).source)
      const shown = written(svg)
      const head = all(group(svg, 'masthead'), 'text').map(said)
      expect(head).toHaveLength(2)
      for (const s of head) expect(s.endsWith('…')).toBe(true)
      expect(LONG.subtitle.startsWith((head[0] ?? '').slice(0, -1).trimEnd())).toBe(true)
      expect(LONG.title.startsWith((head[1] ?? '').slice(0, -1))).toBe(true)
      const rows = chartRows(svg)
      expect(rows[0]?.label.endsWith('…')).toBe(true)
      expect(rows[1]?.label.endsWith('…')).toBe(true)
      expect(rows[1]?.label.startsWith('a_very_long')).toBe(true)
      expect(rows[2]?.label).toBe('短')
      expect(shown).toContain('四')
      // no space is left hanging before the ellipsis
      for (const s of shown) expect(s).not.toMatch(/\s…$/)
      // nothing is written whole that could not fit
      for (const whole of [LONG.title, LONG.subtitle, LONG.barsTitle ?? '', ...(LONG.stamps ?? []).slice(0, 2).map(s => s.text)]) {
        expect(shown).not.toContain(whole)
      }
    }
  })

  test('the measures: each stack’s own widths, never under what any of its faces gives a letter', () => {
    const hundredths = (w: number) => Math.round(w * 1e6) / 1e6
    expect(displayWidth('', 13)).toBe(0)
    expect(sansWidth('', 13)).toBe(0)
    expect(displayWidth('明信片', 10)).toBe(30)
    expect(sansWidth('明信片', 10)).toBe(30)
    // Hoefler's W is wider than a square, its 0 wider than Cochin's; Gill Sans's W wider than Avenir's
    expect(hundredths(displayWidth('W', 100))).toBe(113)
    expect(hundredths(displayWidth('0', 100))).toBe(62)
    expect(hundredths(displayWidth(' ', 100))).toBe(25)
    expect(hundredths(displayWidth('i', 100))).toBe(30)
    expect(hundredths(sansWidth('W', 100))).toBe(105)
    expect(hundredths(sansWidth('0', 100))).toBe(58)
    expect(hundredths(sansWidth(' ', 100))).toBe(28)
    expect(hundredths(sansWidth('1', 100))).toBe(58)
    for (const measure of [displayWidth, sansWidth]) {
      expect(hundredths(measure('…', 100))).toBe(100)
      expect(hundredths(measure('·', 100))).toBe(34)
      // the spacing follows every letter
      expect(Math.abs(measure('ab', 10, 2) - measure('ab', 10) - 4)).toBeLessThan(1e-9)
      for (let c = 0x20; c <= 0x7e; c++) {
        const w = hundredths(measure(String.fromCharCode(c), 100))
        expect(w).toBeGreaterThanOrEqual(23)
        expect(w).toBeLessThanOrEqual(113)
      }
      for (const ch of ['é', 'ж', 'Ж', 'Ω', '→', '€', '😀', '、', 'ｱ', '\u200d']) expect(hundredths(measure(ch, 100))).toBeGreaterThanOrEqual(100)
    }
    // the faces as they measure: Cochin roman for the title, Avenir Next for a label's digits
    expect(displayWidth('Atlas', 48)).toBeGreaterThanOrEqual((0.704 + 0.315 + 0.259 + 0.463 + 0.389) * 48)
    expect(sansWidth('2026', 12)).toBeGreaterThanOrEqual(0.58 * 4 * 12)
  })

  test('the writing stands on the one left edge under the view, and nothing leaves the column', () => {
    for (const [name, spec] of EVERY) {
      for (const width of SWEEP) {
        const r = portoSvg({ ...spec, width })
        const svg = parse(r.source)
        const room = field(svg)
        const page = cards(svg)
        for (const el of all(svg, 'text')) {
          const box = textBox(el)
          const where = `${name} at ${width}: "${said(el)}"`
          expect(finite(box), where).toBe(true)
          expect(box.x0, where).toBeGreaterThanOrEqual(room.x0 - 0.05)
          expect(box.x1, where).toBeLessThanOrEqual(room.x1 + 0.05)
          expect(box.y0, where).toBeGreaterThanOrEqual(room.y0 + 12)
          expect(box.y1, where).toBeLessThanOrEqual(room.y1 - 16)
        }
        // the left edge: the kicker, the title, the swell, the first card's wall, the heading's house, every bar's label
        const edge = [...all(group(svg, 'masthead'), 'text').map(el => n(el, 'x')), ...(page[0] ? [page[0].box.x0] : []), ...chartRows(svg).flatMap(row => (row.labelEl ? [n(row.labelEl, 'x')] : []))]
        for (const x of edge) expect(x, `${name} at ${width}`).toBe(room.x0)
        // the last card's wall, the heading's rule and the tags end on the right edge
        const lastCard = page[page.length - 1]
        if (lastCard) expect(Math.abs(lastCard.box.x1 - room.x1), `${name} at ${width}`).toBeLessThan(0.01)
        // every shape under the view stands in the column too: a card's roof may stand 2px proud of it
        for (const el of [...all(group(svg, 'masthead')), ...all(group(svg, 'cards')), ...all(group(svg, 'bars')), ...all(group(svg, 'tags'))]) {
          const box = shapeBox(el)
          if (box) expect(inside(box, { x0: room.x0 - 2, x1: room.x1 + 2, y0: room.y0 + 8, y1: room.y1 - 16 }, 0.6), `${name} at ${width}: <${el.name} ${el.attrs.d?.slice(0, 30) ?? el.attrs.fill}>`).toBe(true)
        }
      }
    }
  })

  test('no text runs into another', () => {
    for (const [name, spec] of EVERY) {
      for (const width of SWEEP) {
        const boxes = all(parse(portoSvg({ ...spec, width }).source), 'text').map(el => ({ box: textBox(el), s: said(el) }))
        boxes.forEach((a, i) => {
          for (const b of boxes.slice(i + 1)) {
            if (overlap(a.box, b.box)) throw new Error(`${name} at ${width}: "${a.s}" runs into "${b.s}"`)
          }
        })
      }
    }
  })

  test('no ornament touches a text', () => {
    for (const [name, spec] of EVERY) {
      for (const width of SWEEP) {
        const svg = parse(portoSvg({ ...spec, width }).source)
        // a text's own ground is not an ornament beside it: a card's wall, a tag's line
        const ground = new Map<El, El>()
        for (const card of cards(svg)) for (const el of [card.big, ...card.lines]) if (el) ground.set(el, card.sheet)
        for (const tag of tags(svg)) if (tag.text) ground.set(tag.text, tag.border)
        const shapes: { el: El; box: Box }[] = []
        walk(svg, (el, above) => {
          if (above.some(g => g.attrs.class === 'paper')) return
          const box = shapeBox(el)
          if (box) shapes.push({ el, box })
        })
        for (const text of all(svg, 'text')) {
          const box = textBox(text)
          for (const shape of shapes) {
            if (ground.get(text) === shape.el) continue
            if (gap(box, shape.box) < 3) throw new Error(`${name} at ${width}: "${said(text)}" is ${gap(box, shape.box).toFixed(1)}px from <${shape.el.name} ${shape.el.attrs.d?.slice(0, 40) ?? shape.el.attrs.fill}>`)
          }
        }
      }
    }
  })

  test('cards stand side by side, the same size, each text inside its own, under its roof', () => {
    for (const [name, spec] of PAGES) {
      for (const width of SWEEP) {
        const svg = parse(portoSvg({ ...spec, width }).source)
        const col = column(svg)
        const page = cards(svg)
        expect(page.length).toBe(Math.min(3, spec.notes.length))
        if (page.length === 0) continue
        page.forEach((card, i) => {
          const where = `${name} at ${width}, card ${i + 1}`
          expect(card.box.x1 - card.box.x0, where).toBeGreaterThan(70)
          const next = page[i + 1]
          if (next) {
            // room between two roofs
            expect(next.box.x0, where).toBeGreaterThanOrEqual(card.box.x1 + 8)
            expect(Math.abs(next.box.x1 - next.box.x0 - (card.box.x1 - card.box.x0)), where).toBeLessThan(0.01)
            expect(next.box.y0).toBe(card.box.y0)
            expect(next.box.y1).toBe(card.box.y1)
          }
          const foot = pathBox(card.roof?.attrs.d ?? '').y1
          const texts = [card.big, ...card.lines].filter(el => el !== undefined)
          for (const el of texts) {
            const box = textBox(el)
            expect(inside(box, { x0: card.box.x0 + 8, x1: card.box.x1 - 8, y0: foot + 3, y1: card.box.y1 - 5 }), `${where}: "${said(el)}"`).toBe(true)
            expect(page.filter(other => overlap(box, other.box))).toHaveLength(1)
          }
          // the big text over the label, the label's lines one under the other
          const stack = texts.map(textBox)
          stack.forEach((box, k) => {
            const below = stack[k + 1]
            if (below) expect(below.y0, where).toBeGreaterThanOrEqual(box.y1 - 0.05)
          })
          expect(card.lines.length).toBeLessThanOrEqual(2)
        })
        // the row runs the width of the column, and the big texts stand on one line across it
        expect(page[0]?.box.x0).toBe(col.x0)
        expect(Math.abs((page[page.length - 1]?.box.x1 ?? NaN) - col.x1)).toBeLessThan(0.01)
        expect(new Set(page.flatMap(card => (card.big ? [card.big.attrs.y] : []))).size).toBeLessThanOrEqual(1)
        // the head ends above the roofs
        const eaves = Math.min(...page.map(card => pathBox(card.roof?.attrs.d ?? '').y0))
        for (const el of all(group(svg, 'masthead'), 'text')) expect(textBox(el).y1).toBeLessThan(eaves - 12)
        expect(pathBox(all(group(svg, 'masthead'), 'path')[0]?.attrs.d ?? '').y1).toBeLessThan(eaves - 12)
      }
    }
  })

  test('a card shrinks its big text before it cuts it, and wraps a long label onto a second line', () => {
    const size = (spec: JournalSpec, text: string) => {
      const el = all(parse(portoSvg(spec).source), 'text').find(e => said(e) === text)
      return el ? n(el, 'font-size') : NaN
    }
    // 22px on the narrowest page, 32px on the widest
    expect(size({ ...BASE, width: 320 }, '12')).toBe(22)
    expect(size({ ...BASE, width: 460 }, '12')).toBe(26)
    expect(size({ ...BASE, width: 680 }, '12')).toBe(32)
    expect(size({ ...BASE, width: 460 }, '9.8k')).toBe(26)
    expect(size({ ...BASE, width: 320 }, '2 关 · 1 改')).toBeLessThan(22)
    expect(size({ ...BASE, width: 320 }, '2 关 · 1 改')).toBeGreaterThanOrEqual(13)
    expect(size({ ...LONG, width: 460 }, '12')).toBeNaN()
    for (const width of WIDTHS) {
      const page = cards(parse(portoSvg({ ...LONG, width }).source))
      // per card: the big text at its smallest, cut, and two lines of label
      expect(page.map(card => card.lines.length)).toEqual([2, 2, 2])
      for (const card of page) {
        expect(n(card.big, 'font-size')).toBe(width < 400 ? 13 : 15)
        expect(said(card.big ?? NOTHING).endsWith('…')).toBe(true)
      }
    }
    const wrapped = cards(parse(portoSvg({ ...BASE, notes: [...BASE.notes.slice(0, 2), { big: '3', label: '这个会话的全部改动' }], width: 320 }).source)).flatMap(card => card.lines.map(said))
    expect(wrapped.join('')).toContain('这个会话的全部改动')
    expect(wrapped).not.toContain('这个会话的全部改动')
    // one card, or two: still of one width, and wider
    for (const width of WIDTHS) {
      const two = cards(parse(portoSvg({ ...BASE, notes: BASE.notes.slice(0, 2), width }).source))
      const three = cards(parse(portoSvg({ ...BASE, width }).source))
      expect((two[0]?.box.x1 ?? NaN) - (two[0]?.box.x0 ?? NaN)).toBeGreaterThan((three[0]?.box.x1 ?? NaN) - (three[0]?.box.x0 ?? NaN))
    }
  })

  test('tags lie in the column, none on another, each text inside its own', () => {
    for (const [name, spec] of EVERY) {
      for (const width of SWEEP) {
        const svg = parse(portoSvg({ ...spec, width }).source)
        const room = field(svg)
        const page = tags(svg)
        expect(page.length).toBe(own(group(svg, 'tags'), 'text').length)
        page.forEach((tag, i) => {
          const where = `${name} at ${width}, tag ${i + 1}`
          expect(inside(tag.box, room), where).toBe(true)
          for (const other of page.slice(i + 1)) expect(gap(tag.box, other.box), where).toBeGreaterThanOrEqual(8)
          // clear of the round corners
          expect(tag.text !== undefined && inside(textBox(tag.text), { x0: tag.box.x0 + 8, x1: tag.box.x1 - 8, y0: tag.box.y0 + 3, y1: tag.box.y1 - 3 }), where).toBe(true)
          expect(tag.box.y1 - tag.box.y0).toBe(24)
        })
        if (page.length === 0) continue
        // they are set to the right, and what is above ends above them
        for (const top of new Set(page.map(tag => tag.box.y0))) {
          expect(Math.max(...page.filter(tag => tag.box.y0 === top).map(tag => tag.box.x1)), `${name} at ${width}`).toBe(room.x1)
        }
        const first = Math.min(...page.map(tag => tag.box.y0))
        const rows = chartRows(svg)
        const last = rows[rows.length - 1]
        if (last) expect(first).toBeGreaterThan(last.bottom + 12)
        for (const card of cards(svg)) expect(first).toBeGreaterThan(card.box.y1 + 12)
      }
    }
  })

  test('four long stamps wrap to more rows instead of leaving the paper', () => {
    const tops = (spec: JournalSpec) => new Set(tags(parse(portoSvg(spec).source)).map(tag => tag.box.y0))
    expect(tops({ ...LONG, width: 320 }).size).toBe(2)
    expect(tops({ ...LONG, width: 680 }).size).toBe(2)
    // three that fit whole in two rows keep their text
    const three = [{ text: 'MEMORY.md 已对齐' }, { text: '3 条没链接' }, { text: '回收站 2' }]
    const kept = tags(parse(portoSvg({ ...BASE, stamps: three, width: 320 }).source)).map(tag => (tag.text ? said(tag.text) : ''))
    expect(kept).toEqual(three.map(s => s.text))
    expect(tops({ ...BASE, stamps: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }], width: 320 }).size).toBe(1)
  })

  test('a boat on three waves of swell stands left of the first row of tags when there is room', () => {
    const harbour = (spec: JournalSpec) => {
      const svg = parse(portoSvg(spec).source)
      const g = group(svg, 'tags')
      return { svg, swell: own(g, 'path'), boat: groups(g, 'boat') }
    }
    for (const width of WIDTHS) {
      const { svg, swell, boat } = harbour({ ...BASE, stamps: [{ text: '好' }], width })
      const first = tags(svg)[0]?.box ?? NOWHERE
      expect(swell).toHaveLength(1)
      expect(boat).toHaveLength(1)
      expect(swell[0]?.attrs.stroke).toBe(PORTO.sea)
      expect(swell[0]?.attrs.fill).toBe('none')
      const d = swell[0]?.attrs.d ?? ''
      expect(d.split('q')).toHaveLength(4)
      const water = pathBox(d)
      expect(water.x0).toBe(column(svg).x0)
      expect(water.x1 - water.x0).toBe(48)
      expect(first.x0 - water.x1).toBeGreaterThanOrEqual(16)
      // the boat sits on the swell, in its middle, no taller than the row
      const hullAndSails = boxOf(all(boat[0], 'path').flatMap(p => pathPoints(p.attrs.d ?? '').flat()))
      expect(all(boat[0], 'path')).toHaveLength(3)
      expect(inside(hullAndSails, { x0: water.x0 + 8, x1: water.x1 - 8, y0: first.y0, y1: first.y1 })).toBe(true)
      expect(Math.abs(hullAndSails.y1 - water.y1)).toBeLessThanOrEqual(3)
      expect(water.y1).toBeLessThanOrEqual(first.y1)
    }
    // a first row that leaves less than the waves and 16px more gets neither
    let withBoat = 0
    let withoutBoat = 0
    for (let length = 1; length <= 30; length++) {
      const page = harbour({ ...BASE, stamps: [{ text: '浪'.repeat(length) }], width: 340 })
      expect(page.swell.length).toBe(page.boat.length)
      if (page.boat.length === 0) {
        withoutBoat++
        expect((tags(page.svg)[0]?.box ?? NOWHERE).x0 - column(page.svg).x0).toBeLessThan(64)
      } else {
        withBoat++
        expect((tags(page.svg)[0]?.box ?? NOWHERE).x0 - pathBox(page.swell[0]?.attrs.d ?? '').x1).toBeGreaterThanOrEqual(16)
      }
    }
    expect(withBoat).toBeGreaterThan(5)
    expect(withoutBoat).toBeGreaterThan(2)
    expect(harbour({ ...LONG, width: 320 }).boat).toHaveLength(0)
    // only the first row has one
    expect(harbour({ ...BASE, stamps: [{ text: 'MEMORY.md 已对齐' }, { text: '3 条没链接' }, { text: '回收站 2' }, { text: '好' }], width: 320 }).boat.length).toBeLessThanOrEqual(1)
  })
})

// ---------- alt ----------

describe('porto: alt', () => {
  test('alt says the title, each card and each bar, numbers included', () => {
    for (const width of WIDTHS) {
      const { alt } = portoSvg({ ...BASE, width })
      expect(alt).toBe(
        '明信片插图「Atlas」（11 月 14 日 · 提示词页）；数字：12 段系统提示词、9.8k tokens 左右、2 关 · 1 改 这个会话的改动；谁最占地方：doing_tasks 2.6k、tools 2.1k、memory 1.3k；标签：已关闭 · 本会话、2 处改动。',
      )
    }
  })

  test('alt is journal’s sentence with 明信片插图 for 手帐插图 and 数字 for 便签', () => {
    for (const [, spec] of EVERY) {
      for (const width of WIDTHS) {
        const mine = portoSvg({ ...spec, width }).alt
        const theirs = journalSvg({ ...spec, width }).alt
        expect(mine).toBe(theirs.replace(/^手帐插图/, '明信片插图').replace('；便签：', '；数字：'))
      }
    }
  })

  test('alt is one plain sentence: no markup, no line breaks, the value when a bar has no text', () => {
    const { alt } = portoSvg({ title: 'T\n<i>', subtitle: '', notes: [{ big: '3', label: 'a&b' }], bars: [{ label: 'x', value: 12 }, { label: 'y', value: -1 }] })
    expect(alt).toBe('明信片插图「T <i>」；数字：3 a&b；条形图：x 12、y 0。')
    for (const [, spec] of PAGES) {
      const r = portoSvg(spec)
      expect(r.alt.endsWith('。')).toBe(true)
      expect(r.alt).not.toMatch(/[\r\n\t]/)
      expect(r.alt).not.toMatch(/&(amp|lt|gt|quot|#\d+);/)
      expect(r.alt).toContain(`「${spec.title}`.slice(0, 20))
    }
    expect(portoSvg({ title: '空', subtitle: '', notes: [] }).alt).toBe('明信片插图「空」。')
    expect(portoSvg({ title: '', subtitle: '', notes: [] }).alt).toBe('明信片插图「」。')
  })

  test('alt keeps the text the picture had to cut', () => {
    const { alt, source } = portoSvg({ ...LONG, width: 320 })
    expect(alt).toContain(LONG.title)
    expect(written(parse(source)).join('\n')).not.toContain(LONG.title)
    expect(alt).toContain(LONG.subtitle.slice(0, 60))
    for (const note of LONG.notes) expect(alt).toContain(`${note.big} ${note.label}`)
    expect(alt).toContain('零 0')
    expect(alt).toContain('混合 mixed 标签 label 混合 mixed 2.25')
  })
})
