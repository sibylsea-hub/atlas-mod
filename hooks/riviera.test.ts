import { describe, expect, test as engineTest } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { journalSvg } from './journal'
import type { JournalBar, JournalNote, JournalSpec, JournalStamp } from './journal'
import { displayWidth, rivieraSvg, sansWidth } from './riviera'
import { RIVIERA, RIVIERA_DISPLAY, RIVIERA_SANS, RIVIERA_TONES } from './riviera-look'

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

function said(el: El): string {
  return el.kids.map(k => (typeof k === 'string' ? k : said(k))).join('')
}

function group(svg: El, cls: string): El | undefined {
  return all(svg, 'g').find(g => g.attrs.class === cls)
}

function groups(svg: El, cls: string): El[] {
  return all(svg, 'g').filter(g => g.attrs.class === cls)
}

// ---------- measures ----------

type Box = { x0: number; x1: number; y0: number; y1: number }

const NOWHERE: Box = { x0: NaN, x1: NaN, y0: NaN, y1: NaN }

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

function circleBox(el: El): Box {
  return { x0: n(el, 'cx') - n(el, 'r'), x1: n(el, 'cx') + n(el, 'r'), y0: n(el, 'cy') - n(el, 'r'), y1: n(el, 'cy') + n(el, 'r') }
}

function numbers(d: string): number[] {
  return (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
}

/** The box round every point a path names: lines, and a wave's crests and troughs. */
function pathBox(d: string): Box {
  const xs: number[] = []
  const ys: number[] = []
  let x = 0
  let y = 0
  let dy = 0
  const to = (nx: number, ny: number) => {
    x = nx
    y = ny
    xs.push(x)
    ys.push(y)
  }
  for (const m of d.matchAll(/([A-Za-z])([^A-Za-z]*)/g)) {
    const cmd = m[1] ?? ''
    const p = numbers(m[2] ?? '')
    if (cmd === 'M' || cmd === 'L') for (let i = 0; i + 1 < p.length; i += 2) to(p[i] ?? NaN, p[i + 1] ?? NaN)
    else if (cmd === 'H') for (const v of p) to(v, y)
    else if (cmd === 'V') for (const v of p) to(x, v)
    else if (cmd === 'q') {
      // q cx cy x y: the curve reaches half of cy off its line
      dy = p[1] ?? NaN
      ys.push(y + dy / 2)
      to(x + (p[2] ?? NaN), y + (p[3] ?? NaN))
    } else if (cmd === 't') {
      // the mirror of the curve before it
      ys.push(y - dy / 2)
      to(x + (p[0] ?? NaN), y + (p[1] ?? NaN))
    } else if (cmd !== 'Z') throw new Error(`a path command this reader does not know: ${cmd}`)
  }
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
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

function paperBox(svg: El): Box {
  return rectBox(all(group(svg, 'paper'), 'rect')[0])
}

/** The masthead's thick rule: it runs the width of the content, from the one left edge to the right one. */
function column(svg: El): Box {
  const sun = new Set(all(group(svg, 'sun')))
  const rule = all(group(svg, 'masthead'), 'rect').find(r => !sun.has(r))
  if (!rule) throw new Error('no rule under the masthead')
  return rectBox(rule)
}

/** The band a repeat fills: the flat rect and the one over it that the pattern fills, and the pattern. */
function band(svg: El, cls: string): { box: Box; flat: El | undefined; filled: El | undefined; pattern: El | undefined } {
  const [flat, filled] = all(group(svg, cls), 'rect')
  const id = /^url\(#([\w-]+)\)$/.exec(filled?.attrs.fill ?? '')?.[1]
  return { box: rectBox(flat), flat, filled, pattern: all(svg, 'pattern').find(p => p.attrs.id === id) }
}

/** Where the page's own content may stand: the column across, from under the awning to above the tiles. */
function field(svg: El): Box {
  const col = column(svg)
  return { x0: col.x0, x1: col.x1, y0: band(svg, 'awning').box.y1, y1: band(svg, 'foot').box.y0 }
}

type Figure = { mark: El; big: El | undefined; lines: El[]; rule: El | undefined; x: number }

/** The figures: each one's bar, its big text, the lines of its label and the hairline before it. */
function figures(svg: El): Figure[] {
  return groups(svg, 'figure').map(g => {
    const mark = all(g, 'rect')[0]
    if (!mark) throw new Error('a figure without its bar')
    const texts = all(g, 'text')
    return { mark, big: texts.find(t => !isSans(t)), lines: texts.filter(isSans), rule: all(g, 'path')[0], x: n(mark, 'x') }
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
  const texts = all(g, 'text')
  return all(g, 'rect').map((border, i) => {
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
  subtitle: '11 月 13 日 · 提示词页',
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
  title: '这是一个特别特别长的杂志标题用来看看会不会被截断到纸的里面',
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
  'url(#atlas-riviera-tiles) </text><pattern id="atlas-riviera-tiles">',
  'a\u0000b\u0008c\u001bd \ud800 e\r\n\tf',
]

const PAGES: readonly (readonly [string, JournalSpec])[] = [
  ['the usual page', BASE],
  ['long text', LONG],
  ['markup in every field', allFields('<b>&"\'')],
  ['capitals and wide letters', allFields('MWM@WMW HHOOQQ')],
  ['only a title', { title: 'Atlas', subtitle: '', notes: [] }],
  ['only a subtitle', { title: '', subtitle: '11 月 13 日 · 回收站', notes: [] }],
  ['nothing at all', { title: '', subtitle: '', notes: [] }],
  ['one note, bars without a title', { title: '记忆', subtitle: '7 条', notes: [{ big: '7', label: '条' }], bars: [{ label: 'a', value: 1 }, { label: '', value: 2, text: '' }] }],
  ['two notes and a lone stamp', { title: 'T', subtitle: 'S', notes: [{ big: '', label: '' }, { big: '1', label: '' }], stamps: [{ text: 'x' }] }],
  ['four stamps of mixed length', { title: 'Atlas', subtitle: '会话页', notes: [], stamps: [{ text: 'MEMORY.md 已对齐' }, { text: '3 条没链接', tone: 'purple' }, { text: '回收站 2', tone: 'teal' }, { text: 'a rather long latin stamp that goes on for a while' }] }],
]

const EVERY: readonly (readonly [string, JournalSpec])[] = [...PAGES, ...NASTY.map(s => ['nasty', allFields(s)] as const)]

const ELEMENTS = new Set(['svg', 'title', 'defs', 'pattern', 'g', 'rect', 'circle', 'path', 'text'])
const ATTRIBUTES = new Set([
  'xmlns', 'width', 'height', 'viewBox', 'role', 'font-family', 'id', 'class', 'x', 'y', 'cx', 'cy', 'r', 'rx', 'd',
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'patternUnits', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'text-anchor',
])
const CLASSES = new Set(['paper', 'awning', 'masthead', 'sun', 'figures', 'figure', 'bars', 'row', 'tags', 'foot'])
const XMLNS = ' xmlns="http://www.w3.org/2000/svg"'

/** Every colour riviera-look names: the page takes its colours from there and nowhere else. */
const PALETTE = new Set<string>([...Object.values(RIVIERA), ...Object.values(RIVIERA_TONES).flatMap(tone => [tone.deep, tone.pale, tone.ink])])

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
  const ids = all(svg).map(e => e.attrs.id).filter(id => id !== undefined)
  for (const id of ids) if (!id.startsWith('atlas-riviera-')) found.push(`id="${id}"`)
  if (new Set(ids).size !== ids.length) found.push('an id given twice')
  walk(svg, (el, above) => {
    if (!ELEMENTS.has(el.name)) found.push(`<${el.name}>`)
    // an id belongs to a pattern, and a pattern to the one <defs>
    if (el.attrs.id !== undefined && el.name !== 'pattern') found.push(`${el.name} id=`)
    if (el.name === 'pattern' && above[above.length - 1]?.name !== 'defs') found.push('a pattern outside <defs>')
    for (const [key, value] of Object.entries(el.attrs)) {
      if (!ATTRIBUTES.has(key)) found.push(`${el.name} ${key}=`)
      const target = /url\(([^)]*)\)/.exec(value)?.[1]
      if (target !== undefined && !(key === 'fill' && target.startsWith('#') && ids.includes(target.slice(1)))) found.push(`${key}="${value}"`)
      if ((key === 'fill' || key === 'stroke') && value !== 'none' && !PALETTE.has(value) && !/^url\(#[\w-]+\)$/.test(value)) found.push(`${key}="${value}"`)
      if (key === 'class' && !CLASSES.has(value)) found.push(`class="${value}"`)
      if (key === 'font-family' && value !== RIVIERA_DISPLAY && value !== RIVIERA_SANS) found.push(`font-family="${value}"`)
    }
  })
  return found
}

/** What the page writes of the spec: every text it holds (it writes no words of its own). */
function written(svg: El): string[] {
  return all(svg, 'text').map(said)
}

// ---------- the document ----------

describe('riviera: the document', () => {
  test('the root tag agrees with the numbers returned', () => {
    for (const [, spec] of PAGES) {
      for (const width of WIDTHS) {
        const r = rivieraSvg({ ...spec, width })
        expect(r.source.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="${r.width}" height="${r.height}" viewBox="0 0 ${r.width} ${r.height}" role="img" font-family="${RIVIERA_DISPLAY}">`)).toBe(true)
        expect(r.source.endsWith('</svg>')).toBe(true)
        expect(r.width).toBe(width)
        expect(Number.isInteger(r.height) && r.height > 0).toBe(true)
        const svg = parse(r.source)
        expect(svg.attrs['font-family']).toBe(RIVIERA_DISPLAY)
        expect(svg.attrs.role).toBe('img')
        expect(all(svg, 'title')).toHaveLength(1)
        expect(svg.kids[0] === all(svg, 'title')[0]).toBe(true)
        expect(all(svg, 'defs')).toHaveLength(1)
      }
    }
    expect(said(all(parse(rivieraSvg(BASE).source), 'title')[0] ?? { name: '', attrs: {}, kids: [] })).toBe('Atlas')
    expect(said(all(parse(rivieraSvg({ title: '', subtitle: '', notes: [] }).source), 'title')[0] ?? { name: '', attrs: {}, kids: [] })).toBe('杂志页')
  })

  test('width is clamped to 320..680 and is 460 when not given', () => {
    expect(rivieraSvg(BASE).width).toBe(460)
    expect(rivieraSvg({ ...BASE, width: 100 }).width).toBe(320)
    expect(rivieraSvg({ ...BASE, width: -5 }).width).toBe(320)
    expect(rivieraSvg({ ...BASE, width: 319.4 }).width).toBe(320)
    expect(rivieraSvg({ ...BASE, width: 9999 }).width).toBe(680)
    expect(rivieraSvg({ ...BASE, width: Infinity }).width).toBe(460)
    expect(rivieraSvg({ ...BASE, width: -Infinity }).width).toBe(460)
    expect(rivieraSvg({ ...BASE, width: NaN }).width).toBe(460)
    expect(rivieraSvg({ ...BASE, width: 500.6 }).width).toBe(501)
    for (const width of [100, 9999, NaN, 500.6]) {
      const r = rivieraSvg({ ...BASE, width })
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
    expect(parse('<svg><text>a 😀 杂志 &amp;&#61;</text></svg>').kids).toHaveLength(1)
    for (const [, spec] of EVERY) {
      for (const width of WIDTHS) {
        const svg = parse(rivieraSvg({ ...spec, width }).source)
        // text sits in <text> and <title> only, never between shapes
        walk(svg, el => {
          if (el.name !== 'text' && el.name !== 'title') expect(el.kids.every(k => typeof k !== 'string')).toBe(true)
        })
      }
    }
    // control and direction characters, line breaks and half a surrogate pair never reach the markup
    const odd = rivieraSvg({ title: 'a\u0000b\u0008c\u001b\u202ed\ufeff\u2067\ud800e\r\n\tf', subtitle: '', notes: [], width: 680 })
    expect(written(parse(odd.source))).toEqual(['abcde f'])
    expect(odd.alt).toBe('杂志页插图「abcde f」。')
  })

  test('text is escaped in every field and comes back whole', () => {
    const raw = '<b>&"\''
    for (const width of WIDTHS) {
      const r = rivieraSvg({ ...allFields(raw), width })
      expect(r.source).not.toContain('<b')
      const svg = parse(r.source)
      for (const el of all(svg)) expect(ELEMENTS.has(el.name)).toBe(true)
      const texts = written(svg)
      // subtitle, title, 3 figures × 2, the chart's title, 6 bars × 2, 4 tags
      expect(texts).toHaveLength(25)
      for (const s of texts) expect(s).toBe(raw)
      expect(said(all(svg, 'title')[0] ?? svg)).toBe(raw)
      expect(r.source.split('&lt;b&gt;&amp;&quot;&#39;')).toHaveLength(27)
      expect(r.alt).toContain(raw)
    }
  })

  test('no script, handler, style, link or outside reference, whatever the data holds', () => {
    const ns = 'xmlns="http://www.w3.org/2000/svg"'
    expect(forbidden(`<svg ${ns}><text onclick="x">a</text></svg>`)).not.toHaveLength(0)
    expect(forbidden(`<svg ${ns}><rect fill="url(http://x/#a)"/></svg>`)).not.toHaveLength(0)
    expect(forbidden(`<svg ${ns}><rect fill="url(#atlas-riviera-none)"/></svg>`)).not.toHaveLength(0)
    expect(forbidden(`<svg ${ns}><rect fill="red"/></svg>`)).not.toHaveLength(0)
    expect(forbidden(`<svg ${ns}><rect fill="#123456"/></svg>`)).not.toHaveLength(0)
    expect(forbidden(`<svg ${ns}><rect style="fill:#FFFFFF"/></svg>`)).toEqual(['style', 'rect style='])
    expect(forbidden(`<svg ${ns}><text font-style="italic">a</text></svg>`)).toEqual([])
    expect(forbidden(`<svg ${ns}><defs><pattern id="other"/></defs></svg>`)).toEqual(['id="other"'])
    expect(forbidden(`<svg ${ns}><g id="atlas-riviera-a"/></svg>`)).toEqual(['g id='])
    expect(forbidden(`<svg ${ns}><use href="#a"/></svg>`)).not.toHaveLength(0)
    expect(forbidden(`<svg ${ns}><text href="#a">a</text></svg>`)).toEqual(['text href='])
    expect(forbidden(`<svg ${ns}><text transform="rotate(3)">a</text></svg>`)).toEqual(['text transform='])
    expect(forbidden(`<svg ${ns}><text font-family="Comic Sans MS">a</text></svg>`)).toEqual(['font-family="Comic Sans MS"'])
    expect(forbidden(`<svg ${ns}><defs><pattern id="atlas-riviera-a"/></defs><rect fill="url(#atlas-riviera-a)"/></svg>`)).toEqual([])
    for (const [, spec] of PAGES) for (const width of WIDTHS) expect(forbidden(rivieraSvg({ ...spec, width }).source)).toEqual([])
    for (const nasty of NASTY) {
      for (const width of WIDTHS) {
        const r = rivieraSvg({ ...allFields(nasty), width })
        expect(forbidden(r.source)).toEqual([])
        expect(r.source.split('http').length).toBe(2)
        // the two repeats are the page's own: nothing in the data adds one or points at one
        const svg = parse(r.source)
        expect(all(svg, 'pattern').map(p => p.attrs.id)).toEqual(['atlas-riviera-awning', 'atlas-riviera-tiles'])
        expect(all(svg).filter(el => (el.attrs.fill ?? '').startsWith('url(')).length).toBe(2)
      }
    }
    // the nasty text is still there to read, as text
    const shown = written(parse(rivieraSvg({ title: 'see http://a.example?x=1', subtitle: '', notes: [], width: 680 }).source))
    expect(shown).toEqual(['see http://a.example?x=1'])
  })

  test('no font under 11px, nothing turned, no gradients or filters', () => {
    for (const [, spec] of EVERY) {
      for (const width of SWEEP) {
        const r = rivieraSvg({ ...spec, width })
        const sizes = [...r.source.matchAll(/font-size="([^"]*)"/g)].map(m => Number(m[1]))
        for (const size of sizes) expect(size).toBeGreaterThanOrEqual(11)
        expect(r.source).not.toMatch(/font-size\s*:|font\s*:|\sstyle=/)
        expect(r.source).not.toMatch(/Gradient|<filter|filter=|blur|shadow|transform|opacity/i)
        for (const el of all(parse(r.source), 'text')) {
          expect(Number.isFinite(n(el, 'font-size'))).toBe(true)
          expect(Number.isFinite(n(el, 'x')) && Number.isFinite(n(el, 'y'))).toBe(true)
        }
      }
    }
  })

  test('every text reaches 4.5:1 on the white paper, and so does a tag’s line', () => {
    for (const [, spec] of PAGES) {
      for (const width of WIDTHS) {
        const svg = parse(rivieraSvg({ ...spec, width }).source)
        const paper = all(group(svg, 'paper'), 'rect')[0]?.attrs.fill ?? ''
        expect(paper).toBe(RIVIERA.paper)
        // every text stands on the paper itself: none is written on a fill
        for (const el of all(svg, 'text')) {
          const ratio = contrast(el.attrs.fill ?? '', paper)
          if (!(ratio >= 4.5)) throw new Error(`"${said(el)}" is ${el.attrs.fill} on ${paper}: ${ratio.toFixed(2)}:1`)
        }
        for (const tag of tags(svg)) {
          expect(tag.border.attrs.fill).toBe('none')
          expect(contrast(tag.border.attrs.stroke ?? '', paper)).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
    for (const deep of [RIVIERA.coralDeep, RIVIERA.periwinkleDeep, RIVIERA.aquaDeep, RIVIERA.cobalt, RIVIERA.navy, RIVIERA.inkSoft]) expect(contrast(deep, RIVIERA.paper)).toBeGreaterThanOrEqual(4.5)
  })

  test('the same spec gives the same page, and the spec is left as it was', () => {
    for (const [, spec] of PAGES) {
      const before = JSON.stringify(spec)
      const a = rivieraSvg({ ...spec, width: 460 })
      const b = rivieraSvg({ ...spec, width: 460 })
      expect(a).toEqual(b)
      expect(rivieraSvg(spec)).toEqual(a)
      expect(JSON.stringify(spec)).toBe(before)
    }
  })

  test('a usual page is a few thousand characters, and the largest stays far under 131072', () => {
    for (const width of WIDTHS) expect(rivieraSvg({ ...BASE, width }).source.length).toBeLessThan(8000)
    for (const big of [`W&<>"'杂志`.repeat(5000), '\u{1F600}'.repeat(20000), 'i'.repeat(100000), '&'.repeat(100000), 'x '.repeat(50000)]) {
      const spec = allFields(big)
      spec.notes = [...spec.notes, ...spec.notes]
      spec.bars = [...(spec.bars ?? []), ...(spec.bars ?? [])]
      spec.stamps = [...(spec.stamps ?? []), ...(spec.stamps ?? [])]
      for (const width of WIDTHS) {
        const r = rivieraSvg({ ...spec, width })
        expect(r.source.length).toBeLessThan(20000)
        parse(r.source)
        expect(r.alt.length).toBeLessThan(4000)
        expect(r.alt.length).toBeGreaterThan(0)
      }
    }
    for (const [, page] of EVERY) for (const width of WIDTHS) expect(rivieraSvg({ ...page, width }).source.length).toBeLessThan(20000)
  })

  test('what is not a spec does not throw, and no number drawn is anything but a number', () => {
    const odd: unknown[] = [undefined, null, 0, -1, NaN, Infinity, -Infinity, true, {}, [], [[]], 'x', 12345678901234567890n]
    const MEASURES = ['x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'font-size', 'font-weight', 'letter-spacing', 'stroke-width']
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
        const r = rivieraSvg(page)
        const svg = parse(r.source)
        expect(forbidden(r.source)).toEqual([])
        expect(r.alt.length).toBeGreaterThan(0)
        expect(r.alt.startsWith('杂志页插图「')).toBe(true)
        expect(Number.isInteger(r.width) && Number.isInteger(r.height) && r.height > 0).toBe(true)
        expect(svg.attrs.viewBox).toBe(`0 0 ${r.width} ${r.height}`)
        walk(svg, el => {
          for (const key of MEASURES) if (el.attrs[key] !== undefined) expect(el.attrs[key], `${el.name} ${key}`).toMatch(/^-?\d+(\.\d+)?$/)
          if (el.attrs.d !== undefined) expect(el.attrs.d, 'a path').toMatch(/^M[MLHVZqt0-9 .-]*$/)
        })
        for (const el of all(svg, 'text')) expect(finite(textBox(el))).toBe(true)
      }
    }
    // a number that is none never becomes a length: a bar worth NaN is a tick, a width of NaN the usual one
    const none = rivieraSvg({ title: 't', subtitle: '', notes: [], bars: [{ label: 'a', value: NaN, text: 'x' }, { label: 'b', value: Infinity, text: 'y' }], width: NaN })
    expect(none.source).not.toMatch(/NaN|Infinity|undefined/)
    expect(none.width).toBe(460)
    // what is not a string is written as journal writes it: nothing for none, else its words
    expect(written(parse(rivieraSvg({ title: undefined, subtitle: null, notes: [] } as unknown as JournalSpec).source))).toEqual([])
    expect(written(parse(rivieraSvg({ title: 42, subtitle: true, notes: [] } as unknown as JournalSpec).source))).toEqual(['true', '42'])
  })
})

// ---------- what is drawn ----------

describe('riviera: parts', () => {
  test('the first three notes, six bars and four stamps are drawn', () => {
    const notes: JournalNote[] = [1, 2, 3, 4, 5].map(i => ({ big: `N${i}`, label: `note${i}` }))
    const bars: JournalBar[] = [1, 2, 3, 4, 5, 6, 7, 8].map(i => ({ label: `bar${i}`, value: i, text: `val${i}` }))
    const stamps: JournalStamp[] = [1, 2, 3, 4, 5, 6].map(i => ({ text: `S${i}` }))
    for (const width of WIDTHS) {
      const r = rivieraSvg({ title: 'caps', subtitle: 'many', notes, barsTitle: 'bars', bars, stamps, width })
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

  test('a part with no data is left out and the page is that much shorter', () => {
    for (const width of WIDTHS) {
      const full = rivieraSvg({ ...BASE, width })
      const fullSvg = parse(full.source)
      for (const cls of ['paper', 'awning', 'masthead', 'sun', 'figures', 'bars', 'tags', 'foot']) expect(groups(fullSvg, cls)).toHaveLength(1)
      expect(groups(fullSvg, 'figure')).toHaveLength(3)
      expect(groups(fullSvg, 'row')).toHaveLength(3)

      const noNotes = rivieraSvg({ ...BASE, notes: [], width })
      expect(group(parse(noNotes.source), 'figures')).toBeUndefined()
      expect(noNotes.height).toBeLessThan(full.height)
      expect(noNotes.alt).not.toContain('数字')

      for (const bars of [[], undefined]) {
        const noBars = rivieraSvg({ ...BASE, bars, width })
        expect(group(parse(noBars.source), 'bars')).toBeUndefined()
        expect(groups(parse(noBars.source), 'row')).toHaveLength(0)
        expect(noBars.source).not.toContain('谁最占地方')
        expect(noBars.alt).not.toContain('谁最占地方')
        expect(noBars.height).toBeLessThan(full.height)
      }

      for (const stamps of [[], undefined, [{ text: '' }, { text: '  ' }]]) {
        const noStamps = rivieraSvg({ ...BASE, stamps, width })
        expect(group(parse(noStamps.source), 'tags')).toBeUndefined()
        expect(noStamps.height).toBeLessThan(full.height)
        expect(noStamps.alt).not.toContain('标签')
      }

      const bare = rivieraSvg({ title: BASE.title, subtitle: BASE.subtitle, notes: [], barsTitle: BASE.barsTitle, width })
      const bareSvg = parse(bare.source)
      for (const cls of ['figures', 'figure', 'bars', 'tags', 'row']) expect(groups(bareSvg, cls)).toHaveLength(0)
      expect(written(bareSvg)).toEqual([BASE.subtitle, BASE.title])
      for (const other of [noNotes, rivieraSvg({ ...BASE, bars: [], width }), rivieraSvg({ ...BASE, stamps: [], width })]) {
        expect(bare.height).toBeLessThan(other.height)
      }

      const untitled = rivieraSvg({ ...BASE, barsTitle: undefined, width })
      expect(untitled.height).toBeLessThan(full.height)
      expect(chartRows(parse(untitled.source))).toHaveLength(3)

      // the awning, the rule and the tiles are the page's own: they stay when nothing is written
      const blank = rivieraSvg({ title: '', subtitle: '', notes: [], width })
      const blankSvg = parse(blank.source)
      expect(written(blankSvg)).toEqual([])
      for (const cls of ['paper', 'awning', 'masthead', 'foot']) expect(groups(blankSvg, cls)).toHaveLength(1)
      expect(blank.height).toBeLessThanOrEqual(bare.height)
    }
  })

  test('the paper is white with a hairline edge, and fills the image with a small margin', () => {
    for (const [, spec] of PAGES) {
      for (const width of WIDTHS) {
        const r = rivieraSvg({ ...spec, width })
        const svg = parse(r.source)
        const paper = paperBox(svg)
        expect(inside(paper, { x0: 0, x1: r.width, y0: 0, y1: r.height })).toBe(true)
        expect(paper.x0).toBeLessThanOrEqual(12)
        expect(r.width - paper.x1).toBeLessThanOrEqual(12)
        expect(paper.y0).toBeLessThanOrEqual(12)
        expect(r.height - paper.y1).toBeLessThanOrEqual(12)
        const sheet = all(group(svg, 'paper'), 'rect')[0]
        expect(sheet?.attrs.fill).toBe(RIVIERA.paper)
        expect(sheet?.attrs.stroke).toBe(RIVIERA.rule)
        expect(sheet?.attrs['stroke-width']).toBe('1')
        expect(n(sheet, 'rx')).toBeGreaterThan(0)
        expect(n(sheet, 'rx')).toBeLessThanOrEqual(6)
      }
    }
  })

  test('the awning: stripes about 9px tall across the top inside the edge, cobalt at both ends', () => {
    for (const [, spec] of PAGES) {
      for (const width of SWEEP) {
        const svg = parse(rivieraSvg({ ...spec, width }).source)
        const paper = paperBox(svg)
        const { box, flat, filled, pattern } = band(svg, 'awning')
        // inside the edge, and clear of the paper's round corners
        expect(box.x0 - paper.x0).toBeGreaterThanOrEqual(1.5)
        expect(box.x0 - paper.x0).toBeLessThanOrEqual(4)
        expect(Math.abs(box.x0 - paper.x0 - (paper.x1 - box.x1))).toBeLessThan(0.01)
        expect(box.y0 - paper.y0).toBe(box.x0 - paper.x0)
        expect(box.y1 - box.y0).toBe(9)
        // a flat cobalt band, the stripes over it
        expect(flat?.attrs.fill).toBe(RIVIERA.cobalt)
        expect(rectBox(filled)).toEqual(box)
        expect(pattern?.attrs.id).toBe('atlas-riviera-awning')
        expect(pattern?.attrs.patternUnits).toBe('userSpaceOnUse')
        expect(n(pattern, 'x')).toBe(box.x0)
        expect(n(pattern, 'y')).toBe(box.y0)
        // each repeat is a white ground with one cobalt stripe on its left half
        const [ground, stripe] = all(pattern, 'rect')
        expect(all(pattern)).toHaveLength(3)
        expect(ground?.attrs.fill).toBe(RIVIERA.paper)
        expect(stripe?.attrs.fill).toBe(RIVIERA.cobalt)
        expect(n(stripe, 'x')).toBe(0)
        const step = n(pattern, 'width')
        expect(Math.abs(n(stripe, 'width') - step / 2)).toBeLessThan(0.06)
        expect(step / 2).toBeGreaterThan(8.5)
        expect(step / 2).toBeLessThan(11.5)
        // a whole odd number of stripes: the last, like the first, is cobalt
        const count = (box.x1 - box.x0) / (step / 2)
        expect(Math.abs(count - Math.round(count))).toBeLessThan(0.01)
        expect(Math.round(count) % 2).toBe(1)
      }
    }
  })

  test('the foot: a strip of whole 12px tiles along the bottom, centred, a cobalt one at both ends', () => {
    for (const [, spec] of PAGES) {
      for (const width of SWEEP) {
        const r = rivieraSvg({ ...spec, width })
        const svg = parse(r.source)
        const paper = paperBox(svg)
        const { box, flat, filled, pattern } = band(svg, 'foot')
        expect(box.y1 - box.y0).toBe(12)
        expect(paper.y1 - box.y1).toBe(2)
        expect(box.x0 - paper.x0).toBeGreaterThanOrEqual(2)
        expect(box.x0 - paper.x0).toBeLessThan(2 + 12)
        expect(Math.abs(box.x0 - paper.x0 - (paper.x1 - box.x1))).toBeLessThan(0.01)
        const count = (box.x1 - box.x0) / 12
        expect(Number.isInteger(count) && count % 2 === 1).toBe(true)
        expect(flat?.attrs.fill).toBe(RIVIERA.cobalt)
        expect(rectBox(filled)).toEqual(box)
        expect(pattern?.attrs.id).toBe('atlas-riviera-tiles')
        expect(pattern?.attrs.patternUnits).toBe('userSpaceOnUse')
        expect([n(pattern, 'x'), n(pattern, 'y'), n(pattern, 'width'), n(pattern, 'height')]).toEqual([box.x0, box.y0, 24, 12])
        // the repeat is the look's two tiles side by side: a cobalt one, then a white one
        const squares = all(pattern, 'rect')
        expect(squares.map(s => s.attrs.fill)).toEqual([RIVIERA.cobalt, RIVIERA.paper])
        expect(n(squares[0], 'x')).toBe(0)
        expect(n(squares[0], 'width')).toBe(12)
        for (const el of all(pattern).slice(1)) expect(inside(el.name === 'rect' ? rectBox(el) : el.name === 'circle' ? circleBox(el) : pathBox(el.attrs.d ?? ''), { x0: 0, x1: 24, y0: 0, y1: 12 }, 0.6)).toBe(true)
        // everything written stands above it
        for (const el of all(svg, 'text')) expect(textBox(el).y1).toBeLessThanOrEqual(box.y0 - 12)
      }
    }
  })

  test('the masthead: a letter-spaced kicker in the sans over a very large title, a thick-and-thin rule under them', () => {
    const sizes: number[] = []
    for (const width of WIDTHS) {
      const svg = parse(rivieraSvg({ ...BASE, width }).source)
      const col = column(svg)
      const [kicker, title] = all(group(svg, 'masthead'), 'text')
      expect(all(group(svg, 'masthead'), 'text')).toHaveLength(2)
      expect(said(kicker ?? svg)).toBe(BASE.subtitle)
      expect(kicker?.attrs['font-family']).toBe(RIVIERA_SANS)
      expect(kicker?.attrs.fill).toBe(RIVIERA.cobalt)
      expect(n(kicker, 'letter-spacing')).toBeGreaterThanOrEqual(1)
      expect(n(kicker, 'font-size')).toBeGreaterThanOrEqual(11)
      expect(n(kicker, 'font-size')).toBeLessThanOrEqual(13)
      expect(said(title ?? svg)).toBe('Atlas')
      expect(title?.attrs['font-family']).toBeUndefined()
      expect(title?.attrs.fill).toBe(RIVIERA.navy)
      sizes.push(n(title, 'font-size'))
      // both on the one left edge, the kicker over the title
      expect(n(kicker, 'x')).toBe(col.x0)
      expect(n(title, 'x')).toBe(col.x0)
      expect(textBox(kicker ?? svg).y1).toBeLessThan(textBox(title ?? svg).y0 + n(title, 'font-size') * 0.1)
      // the rule: a cobalt bar the width of the content and a hairline under it, below everything in the masthead
      const hair = all(group(svg, 'masthead'), 'path').find(p => /^M[\d. ]+H[\d.]+$/.test(p.attrs.d ?? ''))
      expect(all(group(svg, 'masthead'), 'rect')[0]?.attrs.fill).toBe(RIVIERA.cobalt)
      expect(col.y1 - col.y0).toBe(3)
      expect(pathBox(hair?.attrs.d ?? '').x0).toBe(col.x0)
      expect(pathBox(hair?.attrs.d ?? '').x1).toBe(col.x1)
      expect(pathBox(hair?.attrs.d ?? '').y0).toBeGreaterThan(col.y1)
      expect(hair?.attrs.stroke).toBe(RIVIERA.cobalt)
      expect(textBox(title ?? svg).y1).toBeLessThan(col.y0)
      // generous margins: the column stands well inside the paper, the same on both sides
      const paper = paperBox(svg)
      expect(col.x0 - paper.x0).toBeGreaterThanOrEqual(20)
      expect(Math.abs(col.x0 - paper.x0 - (paper.x1 - col.x1))).toBeLessThan(0.01)
    }
    // roughly 40px on the narrowest page to 64px on the widest
    expect(sizes).toEqual([40, 49, 64])
    // a long title is set smaller before it is cut, and never under 26px
    for (const width of WIDTHS) {
      const svg = parse(rivieraSvg({ ...LONG, width }).source)
      const title = all(group(svg, 'masthead'), 'text')[1]
      expect(n(title, 'font-size')).toBeLessThan(40)
      expect(n(title, 'font-size')).toBeGreaterThanOrEqual(26)
      expect(said(title ?? svg).endsWith('…')).toBe(true)
      const fits = parse(rivieraSvg({ ...BASE, title: 'Atlas of the Sea', width }).source)
      const whole = all(group(fits, 'masthead'), 'text')[1]
      expect(said(whole ?? fits)).toBe('Atlas of the Sea')
      expect(textBox(whole ?? fits).x1).toBeLessThanOrEqual(column(fits).x1)
    }
  })

  test('the sun stands at the top right only with 12px between it and what is written', () => {
    const sun = (spec: JournalSpec) => {
      const svg = parse(rivieraSvg(spec).source)
      return { svg, sun: group(svg, 'sun') }
    }
    let drawn = 0
    for (const [name, spec] of EVERY) {
      for (let width = 320; width <= 680; width += 4) {
        const { svg, sun: g } = sun({ ...spec, width })
        if (!g) continue
        drawn++
        const where = `${name} at ${width}`
        const disc = all(g, 'circle')[0]
        const seas = all(g, 'path')
        // a lemon disc, two lines of waves across its lower part: a longer cobalt one over a shorter azure one
        expect(disc?.attrs.fill).toBe(RIVIERA.lemon)
        expect(seas.map(p => p.attrs.stroke)).toEqual([RIVIERA.cobalt, RIVIERA.azure])
        const body = circleBox(disc ?? svg)
        const [upper, lower] = seas.map(p => pathBox(p.attrs.d ?? ''))
        if (!upper || !lower) throw new Error('a sun without its sea')
        for (const sea of [upper, lower]) {
          expect(sea.y0, where).toBeGreaterThan(n(disc, 'cy'))
          expect(sea.y1, where).toBeLessThan(body.y1)
          expect(Math.abs(sea.x0 + sea.x1 - 2 * n(disc, 'cx')), where).toBeLessThan(0.3)
        }
        expect(upper.x1 - upper.x0).toBeGreaterThan(body.x1 - body.x0)
        expect(lower.x1 - lower.x0).toBeLessThan(upper.x1 - upper.x0)
        expect(lower.y0).toBeGreaterThan(upper.y1)
        // at the right end of the column, under the awning, above the rule
        const col = column(svg)
        const whole: Box = { x0: Math.min(body.x0, upper.x0), x1: Math.max(body.x1, upper.x1), y0: body.y0, y1: body.y1 }
        expect(whole.x1, where).toBeLessThanOrEqual(col.x1 + 0.1)
        expect(whole.x1, where).toBeGreaterThan(col.x1 - 2)
        expect(whole.y0, where).toBeGreaterThanOrEqual(band(svg, 'awning').box.y1 + 12)
        expect(whole.y1, where).toBeLessThanOrEqual(col.y0 - 8)
        for (const el of all(group(svg, 'masthead'), 'text')) expect(gap(whole, textBox(el)), `${where}: "${said(el)}"`).toBeGreaterThanOrEqual(11.5)
      }
    }
    expect(drawn).toBeGreaterThan(200)
    const has = (spec: JournalSpec) => sun(spec).sun !== undefined
    for (const width of SWEEP) {
      // the usual title leaves room at every width; one that fills the line leaves none
      expect(has({ ...BASE, width }), `the usual page at ${width}`).toBe(true)
      expect(has({ ...LONG, width }), `long text at ${width}`).toBe(false)
      expect(has({ title: '', subtitle: '', notes: [], width }), `nothing at ${width}`).toBe(true)
      expect(has({ title: 'Atlas', subtitle: '', notes: [], width }), `a title alone at ${width}`).toBe(true)
    }
  })

  test('figures: a bar in the tone’s colour, the big text in navy, the label in the sans', () => {
    const marks = (spec: JournalSpec) => figures(parse(rivieraSvg(spec).source)).map(f => f.mark.attrs.fill)
    expect(marks(BASE)).toEqual([RIVIERA.lemon, RIVIERA.coral, RIVIERA.aqua])
    expect(marks({ ...BASE, notes: [{ big: '1', label: 'a', tone: 'blue' }, { big: '2', label: 'b', tone: 'purple' }, { big: '3', label: 'c', tone: 'yellow' }] })).toEqual([RIVIERA.azure, RIVIERA.periwinkle, RIVIERA.lemon])
    expect(marks({ ...BASE, notes: [{ big: '1', label: 'a', tone: 'pink' }, { big: '2', label: 'b', tone: 'mint' }, { big: '3', label: 'c' }] })).toEqual([RIVIERA.coral, RIVIERA.aqua, RIVIERA.aqua])
    for (const width of WIDTHS) {
      for (const f of figures(parse(rivieraSvg({ ...BASE, width }).source))) {
        // short and thick
        expect(n(f.mark, 'height')).toBe(4)
        expect(n(f.mark, 'width')).toBeGreaterThanOrEqual(20)
        expect(n(f.mark, 'width')).toBeLessThanOrEqual(34)
        expect(f.big?.attrs.fill).toBe(RIVIERA.navy)
        expect(f.big?.attrs['font-family']).toBeUndefined()
        expect(f.lines.length).toBeGreaterThan(0)
        for (const line of f.lines) {
          expect(line.attrs.fill).toBe(RIVIERA.inkSoft)
          expect(line.attrs['font-family']).toBe(RIVIERA_SANS)
          expect(n(line, 'font-size')).toBeLessThan(n(f.big, 'font-size'))
        }
        // no box: nothing is drawn round a figure
        expect(all(groups(parse(rivieraSvg({ ...BASE, width }).source), 'figure')[0], 'rect')).toHaveLength(1)
      }
    }
  })

  test('tags are square-cornered, their line and their writing one deep colour by tone', () => {
    const colors = (stamps: JournalStamp[]) => tags(parse(rivieraSvg({ ...BASE, stamps }).source)).map(tag => tag.border.attrs.stroke)
    expect(colors([{ text: 'a', tone: 'coral' }, { text: 'b', tone: 'purple' }, { text: 'c', tone: 'teal' }])).toEqual([RIVIERA.coralDeep, RIVIERA.periwinkleDeep, RIVIERA.aquaDeep])
    expect(colors([{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd', tone: 'teal' }])).toEqual([RIVIERA.coralDeep, RIVIERA.periwinkleDeep, RIVIERA.aquaDeep, RIVIERA.aquaDeep])
    for (const width of WIDTHS) {
      for (const tag of tags(parse(rivieraSvg({ ...BASE, width }).source))) {
        expect(tag.border.attrs.rx).toBeUndefined()
        expect(tag.border.attrs.fill).toBe('none')
        expect(tag.border.attrs['stroke-width']).toBe('1')
        expect(tag.text?.attrs.fill).toBe(tag.border.attrs.stroke)
        expect(tag.text?.attrs['font-family']).toBe(RIVIERA_SANS)
        expect(n(tag.text, 'letter-spacing')).toBeGreaterThan(0)
        expect(n(tag.text, 'letter-spacing')).toBeLessThanOrEqual(1)
        expect(tag.text?.attrs['text-anchor']).toBe('middle')
      }
    }
  })
})

// ---------- bars ----------

describe('riviera: bars', () => {
  const chart = (bars: JournalBar[], width?: number) => {
    const r = rivieraSvg({ title: 't', subtitle: 's', notes: [], bars, width })
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
      // six colours, the blues first, lemon last
      expect(rows.map(row => row.color)).toEqual([RIVIERA.cobalt, RIVIERA.azure, RIVIERA.sky, RIVIERA.aqua, RIVIERA.periwinkle, RIVIERA.lemon])
    }
  })

  test('a bar is a flat rectangle with square ends; its label in the sans in navy, its text slanted in cobalt', () => {
    for (const width of WIDTHS) {
      const svg = parse(rivieraSvg({ ...BASE, width }).source)
      for (const g of groups(svg, 'row')) {
        const bar = all(g, 'rect')[0]
        expect(all(g, 'rect')).toHaveLength(1)
        expect(bar?.attrs.rx).toBeUndefined()
        expect(bar?.attrs.stroke).toBeUndefined()
      }
      for (const row of chartRows(svg)) {
        expect(row.labelEl?.attrs.fill).toBe(RIVIERA.navy)
        expect(row.labelEl?.attrs['font-family']).toBe(RIVIERA_SANS)
        expect(row.textEl?.attrs.fill).toBe(RIVIERA.cobalt)
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
        const svg = parse(rivieraSvg({ ...spec, width }).source)
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
      expect(rows[0]?.color).toBe(RIVIERA.cobalt)
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

  test('the heading: a small cobalt square, the text heavy in navy, a hairline to the right edge', () => {
    for (const spec of [BASE, LONG, allFields('MWM@WMW HHOOQQ')]) {
      for (const width of SWEEP) {
        const svg = parse(rivieraSvg({ ...spec, width }).source)
        const col = column(svg)
        const bars = group(svg, 'bars')
        const heading = all(bars, 'text')[0]
        const square = all(bars, 'rect')[0]
        const rule = all(bars, 'path')[0]
        if (!heading || !square || !rule) throw new Error('a heading short of a piece')
        expect(square.attrs.fill).toBe(RIVIERA.cobalt)
        expect(n(square, 'width')).toBe(n(square, 'height'))
        expect(n(square, 'width')).toBeLessThanOrEqual(8)
        expect(n(square, 'x')).toBe(col.x0)
        expect(heading.attrs.fill).toBe(RIVIERA.navy)
        expect(heading.attrs['font-family']).toBeUndefined()
        expect(heading.attrs['font-weight']).toBe('700')
        expect(rule.attrs.stroke).toBe(RIVIERA.rule)
        const box = textBox(heading)
        const line = pathBox(rule.attrs.d ?? '')
        expect(rectBox(square).x1).toBeLessThanOrEqual(box.x0 - 4)
        expect(line.x0).toBeGreaterThanOrEqual(box.x1 + 8)
        expect(line.x1).toBe(col.x1)
        expect(line.x1 - line.x0).toBeGreaterThanOrEqual(12)
        // the square and the rule are level with the middle of the text
        expect(line.y0).toBeGreaterThan(box.y0)
        expect(line.y0).toBeLessThan(box.y1)
        expect(Math.abs((rectBox(square).y0 + rectBox(square).y1) / 2 - line.y0)).toBeLessThan(0.01)
        // the first bar starts under the heading
        expect(chartRows(svg)[0]?.top ?? 0).toBeGreaterThan(box.y1 + 4)
      }
    }
  })
})

// ---------- layout ----------

describe('riviera: layout', () => {
  test('long text is cut with an ellipsis, in CJK and in Latin', () => {
    for (const width of WIDTHS) {
      const svg = parse(rivieraSvg({ ...LONG, width }).source)
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
    expect(displayWidth('', 13)).toBe(0)
    expect(sansWidth('', 13)).toBe(0)
    expect(displayWidth('杂志', 10)).toBe(20)
    expect(sansWidth('杂志', 10)).toBe(20)
    // Didot's W is wider than a square; Georgia's bold 0 wider than any roman one
    const hundredths = (w: number) => Math.round(w * 1e6) / 1e6
    expect(hundredths(displayWidth('W', 100))).toBe(113)
    expect(hundredths(displayWidth('0', 100))).toBe(71)
    expect(hundredths(displayWidth(' ', 100))).toBe(28)
    expect(hundredths(displayWidth('i', 100))).toBe(36)
    expect(hundredths(sansWidth('0', 100))).toBe(58)
    expect(hundredths(sansWidth(' ', 100))).toBe(28)
    expect(hundredths(sansWidth('W', 100))).toBe(98)
    expect(hundredths(sansWidth('i', 100))).toBe(25)
    for (const measure of [displayWidth, sansWidth]) {
      expect(hundredths(measure('…', 100))).toBe(100)
      expect(hundredths(measure('·', 100))).toBe(34)
      // the spacing follows every letter
      expect(Math.abs(measure('ab', 10, 2) - measure('ab', 10) - 4)).toBeLessThan(1e-9)
      for (let c = 0x20; c <= 0x7e; c++) {
        const w = hundredths(measure(String.fromCharCode(c), 100))
        expect(w).toBeGreaterThanOrEqual(24)
        expect(w).toBeLessThanOrEqual(113)
      }
      for (const ch of ['é', 'ж', 'Ж', 'Ω', '→', '€', '😀', '、', 'ｱ', '\u200d']) expect(hundredths(measure(ch, 100))).toBeGreaterThanOrEqual(100)
    }
    // the faces as they measure: Didot roman for the title, Avenir Next for the kicker's digits
    expect(displayWidth('Atlas', 64)).toBeGreaterThanOrEqual((0.741 + 0.352 + 0.296 + 0.481 + 0.444) * 64)
    expect(sansWidth('2026', 12)).toBeGreaterThanOrEqual(0.58 * 4 * 12)
  })

  test('everything written stands on the one left edge, and nothing leaves the column', () => {
    for (const [name, spec] of EVERY) {
      for (const width of SWEEP) {
        const r = rivieraSvg({ ...spec, width })
        const svg = parse(r.source)
        const room = field(svg)
        const page = figures(svg)
        for (const el of all(svg, 'text')) {
          const box = textBox(el)
          const where = `${name} at ${width}: "${said(el)}"`
          expect(finite(box), where).toBe(true)
          expect(box.x0, where).toBeGreaterThanOrEqual(room.x0 - 0.05)
          expect(box.x1, where).toBeLessThanOrEqual(room.x1 + 0.05)
          expect(box.y0, where).toBeGreaterThanOrEqual(room.y0 + 8)
          expect(box.y1, where).toBeLessThanOrEqual(room.y1 - 8)
        }
        // the left edge: the kicker, the title, the first figure, the heading's square, every bar's label
        const edge = [
          ...all(group(svg, 'masthead'), 'text').map(el => n(el, 'x')),
          ...(page[0] ? [page[0].x, ...[page[0].big, ...page[0].lines].filter(el => el !== undefined).map(el => n(el, 'x'))] : []),
          ...chartRows(svg).flatMap(row => (row.labelEl ? [n(row.labelEl, 'x')] : [])),
        ]
        for (const x of edge) expect(x, `${name} at ${width}`).toBe(room.x0)
        // every shape stands in the column too, but the two bands that run the paper's width
        for (const el of [...all(group(svg, 'figures')), ...all(group(svg, 'bars')), ...all(group(svg, 'tags')), ...all(group(svg, 'sun'))]) {
          const box = el.name === 'rect' ? rectBox(el) : el.name === 'circle' ? circleBox(el) : el.name === 'path' ? pathBox(el.attrs.d ?? '') : undefined
          if (box) expect(inside(box, room, 0.8), `${name} at ${width}: <${el.name}>`).toBe(true)
        }
      }
    }
  })

  test('no text runs into another', () => {
    for (const [name, spec] of EVERY) {
      for (const width of SWEEP) {
        const boxes = all(parse(rivieraSvg({ ...spec, width }).source), 'text').map(el => ({ box: textBox(el), s: said(el) }))
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
        const svg = parse(rivieraSvg({ ...spec, width }).source)
        const own = new Map(tags(svg).map(tag => [tag.text, tag.border]))
        const shapes: { el: El; box: Box }[] = []
        walk(svg, (el, above) => {
          if (above.some(g => g.name === 'defs' || g.attrs.class === 'paper')) return
          if (el.name === 'rect') shapes.push({ el, box: rectBox(el) })
          if (el.name === 'path') shapes.push({ el, box: pathBox(el.attrs.d ?? '') })
          if (el.name === 'circle') shapes.push({ el, box: circleBox(el) })
        })
        for (const text of all(svg, 'text')) {
          const box = textBox(text)
          for (const shape of shapes) {
            // a tag's own line runs round its text
            if (own.get(text) === shape.el) continue
            if (gap(box, shape.box) < 3) throw new Error(`${name} at ${width}: "${said(text)}" is ${gap(box, shape.box).toFixed(1)}px from <${shape.el.name} ${shape.el.attrs.d ?? shape.el.attrs.fill}>`)
          }
        }
      }
    }
  })

  test('figures stand in columns of one width, a hairline between them, each text in its own column', () => {
    for (const [name, spec] of PAGES) {
      for (const width of SWEEP) {
        const svg = parse(rivieraSvg({ ...spec, width }).source)
        const col = column(svg)
        const page = figures(svg)
        expect(page.length).toBe(Math.min(3, spec.notes.length))
        if (page.length === 0) continue
        // the columns: from each bar's left to the next hairline, or to the right edge
        const lefts = page.map(f => f.x)
        const rules = page.map(f => (f.rule ? pathBox(f.rule.attrs.d ?? '') : undefined))
        expect(lefts[0]).toBe(col.x0)
        expect(rules[0]).toBeUndefined()
        const pitch = page.length > 1 ? (lefts[1] ?? NaN) - (lefts[0] ?? NaN) : col.x1 - col.x0
        const gutter = page.length > 1 ? ((lefts[1] ?? NaN) - (rules[1]?.x0 ?? NaN)) * 2 : 0
        const colW = pitch - gutter
        expect(gutter === 0 || gutter >= 16, `${name} at ${width}`).toBe(true)
        expect(colW).toBeGreaterThan(70)
        expect(Math.abs((lefts[0] ?? NaN) + pitch * page.length - gutter - col.x1)).toBeLessThan(0.3)
        const tops = new Set<number>()
        const bottoms = new Set<number>()
        page.forEach((f, i) => {
          const where = `${name} at ${width}, figure ${i + 1}`
          expect(Math.abs(f.x - ((lefts[0] ?? NaN) + i * pitch)), where).toBeLessThan(0.3)
          expect(f.mark.attrs.rx).toBeUndefined()
          const rule = rules[i]
          expect(rule === undefined, where).toBe(i === 0)
          if (rule) {
            // upright, in the middle of the gutter, as tall as the figures
            expect(rule.x1).toBe(rule.x0)
            expect(f.rule?.attrs.stroke).toBe(RIVIERA.rule)
            tops.add(rule.y0)
            bottoms.add(rule.y1)
            expect(rule.y0).toBe(n(f.mark, 'y'))
          }
          const texts = [f.big, ...f.lines].filter(el => el !== undefined)
          for (const el of texts) {
            const box = textBox(el)
            expect(n(el, 'x'), `${where}: "${said(el)}"`).toBe(f.x)
            expect(box.x1, `${where}: "${said(el)}"`).toBeLessThanOrEqual(f.x + colW + 0.05)
            expect(box.y0, `${where}: "${said(el)}"`).toBeGreaterThanOrEqual(rectBox(f.mark).y1 + 2)
            if (rule) expect(box.y1).toBeLessThanOrEqual(rule.y1)
          }
          // the big text over the label, the label's lines one under the other
          const stack = texts.map(textBox)
          stack.forEach((box, k) => {
            const next = stack[k + 1]
            if (next) expect(next.y0, where).toBeGreaterThanOrEqual(box.y1 - 0.05)
          })
          expect(f.lines.length).toBeLessThanOrEqual(2)
        })
        expect(tops.size).toBeLessThanOrEqual(1)
        expect(bottoms.size).toBeLessThanOrEqual(1)
        // the big texts stand on one line across the row
        expect(new Set(page.flatMap(f => (f.big ? [f.big.attrs.y] : []))).size).toBeLessThanOrEqual(1)
        // the rule under the masthead ends above the figures
        expect(Math.min(...page.map(f => n(f.mark, 'y')))).toBeGreaterThanOrEqual(col.y1 + 16)
      }
    }
  })

  test('a figure shrinks its big text before it cuts it, and wraps a long label onto a second line', () => {
    const size = (spec: JournalSpec, text: string) => {
      const el = all(parse(rivieraSvg(spec).source), 'text').find(e => said(e) === text)
      return el ? n(el, 'font-size') : NaN
    }
    // large: 28px on the narrowest page, 44px on the widest
    expect(size({ ...BASE, width: 320 }, '12')).toBe(28)
    expect(size({ ...BASE, width: 460 }, '12')).toBe(34)
    expect(size({ ...BASE, width: 680 }, '12')).toBe(44)
    expect(size({ ...BASE, width: 460 }, '9.8k')).toBe(34)
    expect(size({ ...BASE, width: 320 }, '2 关 · 1 改')).toBeLessThan(28)
    expect(size({ ...BASE, width: 320 }, '2 关 · 1 改')).toBeGreaterThanOrEqual(14)
    expect(size({ ...LONG, width: 460 }, '12')).toBeNaN()
    for (const width of WIDTHS) {
      const page = figures(parse(rivieraSvg({ ...LONG, width }).source))
      // per figure: the big text at its smallest, and two lines of label
      expect(page.map(f => f.lines.length)).toEqual([2, 2, 2])
      for (const f of page) expect(n(f.big, 'font-size')).toBe(width < 400 ? 14 : 16)
      expect(said(page[0]?.big ?? { name: '', attrs: {}, kids: [] }).endsWith('…')).toBe(true)
      expect(said(page[2]?.big ?? { name: '', attrs: {}, kids: [] }).endsWith('…')).toBe(true)
    }
    const wrapped = figures(parse(rivieraSvg({ ...BASE, notes: [...BASE.notes.slice(0, 2), { big: '3', label: '这个会话里一共做过的改动' }], width: 320 }).source)).flatMap(f => f.lines.map(said))
    expect(wrapped.join('')).toContain('这个会话里一共做过的改动')
    expect(wrapped).not.toContain('这个会话里一共做过的改动')
    // one figure, or two: the columns are still of one width, and wider
    for (const width of WIDTHS) {
      const two = figures(parse(rivieraSvg({ ...BASE, notes: BASE.notes.slice(0, 2), width }).source))
      const three = figures(parse(rivieraSvg({ ...BASE, width }).source))
      expect((two[1]?.x ?? NaN) - (two[0]?.x ?? NaN)).toBeGreaterThan((three[1]?.x ?? NaN) - (three[0]?.x ?? NaN))
    }
  })

  test('tags lie in the column, none on another, each text inside its own', () => {
    for (const [name, spec] of EVERY) {
      for (const width of SWEEP) {
        const svg = parse(rivieraSvg({ ...spec, width }).source)
        const room = field(svg)
        const page = tags(svg)
        expect(page.length).toBe(all(group(svg, 'tags'), 'text').length)
        page.forEach((tag, i) => {
          const where = `${name} at ${width}, tag ${i + 1}`
          expect(inside(tag.box, room), where).toBe(true)
          for (const other of page.slice(i + 1)) expect(gap(tag.box, other.box), where).toBeGreaterThanOrEqual(8)
          expect(tag.text !== undefined && inside(textBox(tag.text), { x0: tag.box.x0 + 6, x1: tag.box.x1 - 6, y0: tag.box.y0 + 3, y1: tag.box.y1 - 3 }), where).toBe(true)
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
        for (const f of figures(svg)) for (const el of [f.big, ...f.lines]) if (el) expect(first).toBeGreaterThan(textBox(el).y1 + 8)
        // and the tiles lie well under the last row
        expect(room.y1 - Math.max(...page.map(tag => tag.box.y1))).toBeGreaterThanOrEqual(18)
      }
    }
  })

  test('four long stamps wrap to more rows instead of leaving the paper', () => {
    const tops = (spec: JournalSpec) => new Set(tags(parse(rivieraSvg(spec).source)).map(tag => tag.box.y0))
    expect(tops({ ...LONG, width: 320 }).size).toBe(2)
    expect(tops({ ...LONG, width: 680 }).size).toBe(2)
    // three that fit whole in two rows keep their text
    const three = [{ text: 'MEMORY.md 已对齐' }, { text: '3 条没链接' }, { text: '回收站 2' }]
    const kept = tags(parse(rivieraSvg({ ...BASE, stamps: three, width: 320 }).source)).map(tag => (tag.text ? said(tag.text) : ''))
    expect(kept).toEqual(three.map(s => s.text))
    expect(tops({ ...BASE, stamps: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }], width: 320 }).size).toBe(1)
  })

  test('a short line of whole waves stands left of the first row of tags when there is room', () => {
    const sea = (spec: JournalSpec) => {
      const svg = parse(rivieraSvg(spec).source)
      const lines = all(group(svg, 'tags'), 'path')
      return { svg, lines, d: lines[0]?.attrs.d ?? '' }
    }
    for (const width of WIDTHS) {
      const { svg, lines, d } = sea({ ...BASE, stamps: [{ text: '好' }], width })
      expect(lines).toHaveLength(1)
      expect(lines[0]?.attrs.stroke).toBe(RIVIERA.sky)
      expect(lines[0]?.attrs.fill).toBe('none')
      // six waves at most, each 16px long
      expect(d.split('q')).toHaveLength(7)
      const box = pathBox(d)
      const first = tags(svg)[0]?.box ?? NOWHERE
      expect(box.x0).toBe(column(svg).x0)
      expect(box.x1 - box.x0).toBe(96)
      expect(first.x0 - box.x1).toBeGreaterThanOrEqual(16)
      expect(box.y0).toBeGreaterThan(first.y0)
      expect(box.y1).toBeLessThan(first.y1)
    }
    // fewer as the row leaves less room, and none once it leaves none for three: never a part of a wave
    const seen = new Set<number>()
    for (let length = 1; length <= 30; length++) {
      const page = sea({ ...BASE, stamps: [{ text: '浪'.repeat(length) }], width: 340 })
      const crests = page.d ? page.d.split('q').length - 1 : 0
      seen.add(crests)
      expect(crests === 0 || (crests >= 3 && crests <= 6), `a tag of ${length}`).toBe(true)
      if (crests === 0) continue
      expect(page.d.split('t')).toHaveLength(crests + 1)
      expect(pathBox(page.d).x1 - pathBox(page.d).x0).toBe(crests * 16)
      expect((tags(page.svg)[0]?.box ?? NOWHERE).x0 - pathBox(page.d).x1, `a tag of ${length}`).toBeGreaterThanOrEqual(16)
    }
    expect([...seen].sort()).toEqual([0, 3, 4, 5, 6])
    expect(sea({ ...LONG, width: 320 }).lines).toHaveLength(0)
    expect(sea({ ...BASE, stamps: [{ text: '对话里另有注入 约 13k tokens 还有很多很多很多别的' }], width: 320 }).lines).toHaveLength(0)
  })
})

// ---------- alt ----------

describe('riviera: alt', () => {
  test('alt says the title, each figure and each bar, numbers included', () => {
    for (const width of WIDTHS) {
      const { alt } = rivieraSvg({ ...BASE, width })
      expect(alt).toBe(
        '杂志页插图「Atlas」（11 月 13 日 · 提示词页）；数字：12 段系统提示词、9.8k tokens 左右、2 关 · 1 改 这个会话的改动；谁最占地方：doing_tasks 2.6k、tools 2.1k、memory 1.3k；标签：已关闭 · 本会话、2 处改动。',
      )
    }
  })

  test('alt is journal’s sentence with 杂志页插图 for 手帐插图 and 数字 for 便签', () => {
    for (const [, spec] of EVERY) {
      for (const width of WIDTHS) {
        const mine = rivieraSvg({ ...spec, width }).alt
        const theirs = journalSvg({ ...spec, width }).alt
        expect(mine).toBe(theirs.replace(/^手帐插图/, '杂志页插图').replace('；便签：', '；数字：'))
      }
    }
  })

  test('alt is one plain sentence: no markup, no line breaks, the value when a bar has no text', () => {
    const { alt } = rivieraSvg({ title: 'T\n<i>', subtitle: '', notes: [{ big: '3', label: 'a&b' }], bars: [{ label: 'x', value: 12 }, { label: 'y', value: -1 }] })
    expect(alt).toBe('杂志页插图「T <i>」；数字：3 a&b；条形图：x 12、y 0。')
    for (const [, spec] of PAGES) {
      const r = rivieraSvg(spec)
      expect(r.alt.endsWith('。')).toBe(true)
      expect(r.alt).not.toMatch(/[\r\n\t]/)
      expect(r.alt).not.toMatch(/&(amp|lt|gt|quot|#\d+);/)
      expect(r.alt).toContain(`「${spec.title}`.slice(0, 20))
    }
    expect(rivieraSvg({ title: '空', subtitle: '', notes: [] }).alt).toBe('杂志页插图「空」。')
    expect(rivieraSvg({ title: '', subtitle: '', notes: [] }).alt).toBe('杂志页插图「」。')
  })

  test('alt keeps the text the picture had to cut', () => {
    const { alt, source } = rivieraSvg({ ...LONG, width: 320 })
    expect(alt).toContain(LONG.title)
    expect(written(parse(source)).join('\n')).not.toContain(LONG.title)
    expect(alt).toContain(LONG.subtitle.slice(0, 60))
    for (const note of LONG.notes) expect(alt).toContain(`${note.big} ${note.label}`)
    expect(alt).toContain('零 0')
    expect(alt).toContain('混合 mixed 标签 label 混合 mixed 2.25')
  })
})
