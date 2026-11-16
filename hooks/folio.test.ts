import { describe, expect, test as engineTest } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { folioSvg, serifWidth } from './folio'
import { FOLIO, FOLIO_FONT, FOLIO_TONES } from './folio-look'
import { journalSvg } from './journal'
import type { JournalBar, JournalNote, JournalSpec, JournalStamp } from './journal'

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

const n = (el: El, key: string) => Number(el.attrs[key])

/**
 * A text's box by the estimate the layout promises: the serif's own widths,
 * the spacing after each letter, and a heavier weight taken as 15% wider.
 */
function textBox(el: El): Box {
  const fs = n(el, 'font-size')
  const s = said(el)
  const spacing = el.attrs['letter-spacing'] === undefined ? 0 : n(el, 'letter-spacing')
  const w = serifWidth(s, fs) * (el.attrs['font-weight'] === undefined ? 1 : 1.15) + Array.from(s).length * spacing
  const x0 = el.attrs['text-anchor'] === 'middle' ? n(el, 'x') - w / 2 : n(el, 'x')
  return { x0, x1: x0 + w, y0: n(el, 'y') - fs * 0.8, y1: n(el, 'y') + fs * 0.2 }
}

function rectBox(el: El): Box {
  return { x0: n(el, 'x'), x1: n(el, 'x') + n(el, 'width'), y0: n(el, 'y'), y1: n(el, 'y') + n(el, 'height') }
}

function circleBox(el: El): Box {
  return { x0: n(el, 'cx') - n(el, 'r'), x1: n(el, 'cx') + n(el, 'r'), y0: n(el, 'cy') - n(el, 'r'), y1: n(el, 'cy') + n(el, 'r') }
}

function numbers(d: string): number[] {
  return (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
}

/** The box round every point a path names (an arc counts by its end: the ones here bend inward). */
function pathBox(d: string): Box {
  const xs: number[] = []
  const ys: number[] = []
  let x = 0
  let y = 0
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
    else if (cmd === 'l') for (let i = 0; i + 1 < p.length; i += 2) to(x + (p[i] ?? NaN), y + (p[i + 1] ?? NaN))
    else if (cmd === 'H') for (const v of p) to(v, y)
    else if (cmd === 'V') for (const v of p) to(x, v)
    else if (cmd === 'v') for (const v of p) to(x, y + v)
    else if (cmd === 'Q') for (let i = 0; i + 1 < p.length; i += 2) to(p[i] ?? NaN, p[i + 1] ?? NaN)
    else if (cmd === 'A') for (let i = 0; i + 6 < p.length; i += 7) to(p[i + 5] ?? NaN, p[i + 6] ?? NaN)
    else if (cmd !== 'Z') throw new Error(`a path command this reader does not know: ${cmd}`)
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

function grown(b: Box, by: number): Box {
  return { x0: b.x0 - by, x1: b.x1 + by, y0: b.y0 - by, y1: b.y1 + by }
}

function finite(b: Box): boolean {
  return [b.x0, b.x1, b.y0, b.y1].every(Number.isFinite)
}

function paperBox(svg: El): Box {
  const paper = all(group(svg, 'paper'), 'rect')[0]
  if (!paper) throw new Error('no paper')
  return rectBox(paper)
}

/**
 * The frame: the box of its gold line, the box of the fainter line inside
 * it, and how far the inner line's notch reaches from each corner of the gold one.
 */
function frame(svg: El): { outer: Box; inner: Box; reach: number } {
  const lines = all(group(svg, 'frame'), 'path').filter(p => p.attrs.fill === 'none' && (p.attrs.d ?? '').includes('A'))
  const box = (el: El | undefined): Box => {
    // M x y H x A r r 0 0 0 x y V y A r r 0 0 0 x y H x A r r 0 0 0 x y V y A …
    const p = numbers(el?.attrs.d ?? '')
    return { x0: p[24] ?? NaN, x1: p[8] ?? NaN, y0: p[1] ?? NaN, y1: p[17] ?? NaN }
  }
  if (lines.length !== 2) throw new Error('not a double frame')
  return { outer: box(lines[0]), inner: box(lines[1]), reach: numbers(lines[1]?.attrs.d ?? '')[3] ?? NaN }
}

type Row = { label: string; text: string; textEl: El | undefined; labelEl: El | undefined; x: number; len: number; top: number; bottom: number; color: string; d: string }

/** The chart's rows: what is written, where the swatch starts and how long it runs (0 for a tick). */
function chartRows(svg: El): Row[] {
  return groups(svg, 'row').map(row => {
    const texts = all(row, 'text')
    const path = all(row, 'path')[0]
    if (!path) throw new Error('a row without a bar')
    const d = path.attrs.d ?? ''
    const box = pathBox(d)
    const filled = path.attrs.fill !== 'none'
    const labelEl = texts.find(t => n(t, 'x') < box.x0)
    const textEl = texts.find(t => n(t, 'x') > box.x0)
    return {
      label: labelEl ? said(labelEl) : '',
      text: textEl ? said(textEl) : '',
      textEl,
      labelEl,
      x: box.x0,
      len: filled ? box.x1 - box.x0 : 0,
      top: box.y0,
      bottom: box.y1,
      color: (filled ? path.attrs.fill : path.attrs.stroke) ?? '',
      d,
    }
  })
}

/** The stubs: each one's body and what is written on it, in the order drawn. */
function stubs(svg: El): { box: Box; fill: string; text: El | undefined }[] {
  const g = group(svg, 'stubs')
  const bodies = all(g, 'path').filter(p => p.attrs.fill !== 'none' && (p.attrs.d ?? '').includes('A'))
  const texts = all(g, 'text')
  return bodies.map((body, i) => ({ box: pathBox(body.attrs.d ?? ''), fill: body.attrs.fill ?? '', text: texts[i] }))
}

/** The cards: each one's sheet, the fine frame inside it, its tab, the tab's number and what is written under it. */
function cards(svg: El): { sheet: El; inner: El; tab: El; number: El | undefined; words: El[] }[] {
  return groups(svg, 'card').map(card => {
    const [sheet, inner, tab] = all(card, 'rect')
    if (!sheet || !inner || !tab) throw new Error('a card short of a sheet, a frame or a tab')
    const texts = all(card, 'text')
    return { sheet, inner, tab, number: texts.find(t => t.attrs['text-anchor'] === 'middle'), words: texts.filter(t => t.attrs['text-anchor'] !== 'middle') }
  })
}

/** What the page writes of the spec: every text but the plate's two words and the tabs' numbers. */
function written(svg: El): string[] {
  return all(svg, 'text')
    .map(said)
    .filter(s => s !== 'ATLAS' && s !== 'ARCHIVE' && !/^0\d\.$/.test(s))
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
  title: 'Atlas 档案',
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
  title: '这是一个特别特别长的档案标题用来看看会不会被截断到纸的里面',
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
  'a\u0000b\u0008c\u001bd \ud800 e\r\n\tf',
]

const PAGES: readonly (readonly [string, JournalSpec])[] = [
  ['the usual page', BASE],
  ['long text', LONG],
  ['markup in every field', allFields('<b>&"\'')],
  ['capitals and wide letters', allFields('MWM@WMW HHOOQQ')],
  ['only a title', { title: 'Atlas 档案', subtitle: '', notes: [] }],
  ['only a subtitle', { title: '', subtitle: '11 月 13 日 · 回收站', notes: [] }],
  ['nothing at all', { title: '', subtitle: '', notes: [] }],
  ['one note, bars without a title', { title: '记忆', subtitle: '7 条', notes: [{ big: '7', label: '条' }], bars: [{ label: 'a', value: 1 }, { label: '', value: 2, text: '' }] }],
  ['two notes and a lone stamp', { title: 'T', subtitle: 'S', notes: [{ big: '', label: '' }, { big: '1', label: '' }], stamps: [{ text: 'x' }] }],
  ['four stamps of mixed length', { title: 'Atlas 档案', subtitle: '会话页', notes: [], stamps: [{ text: 'MEMORY.md 已对齐' }, { text: '3 条没链接', tone: 'purple' }, { text: '回收站 2', tone: 'teal' }, { text: 'a rather long latin stamp that goes on for a while' }] }],
]

const EVERY: readonly (readonly [string, JournalSpec])[] = [...PAGES, ...NASTY.map(s => ['nasty', allFields(s)] as const)]

const ELEMENTS = new Set(['svg', 'title', 'g', 'rect', 'circle', 'path', 'text'])
const ATTRIBUTES = new Set([
  'xmlns', 'width', 'height', 'viewBox', 'role', 'font-family', 'id', 'class', 'x', 'y', 'cx', 'cy', 'r', 'rx', 'd',
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'font-size', 'font-weight', 'letter-spacing', 'text-anchor',
])
const CLASSES = new Set(['paper', 'frame', 'head', 'plate', 'seal', 'cards', 'card', 'bars', 'row', 'stubs'])
const XMLNS = ' xmlns="http://www.w3.org/2000/svg"'

/** Every colour folio-look names: the page takes its colours from there and nowhere else. */
const PALETTE = new Set<string>([...Object.values(FOLIO), ...Object.values(FOLIO_TONES).flatMap(tone => [tone.deep, tone.pale, tone.ink])])

/** What must never be in the source, whatever the data: the names of what it finds. */
function forbidden(source: string): string[] {
  const s = source.replace(XMLNS, '')
  const found: string[] = []
  if (/<script/i.test(s)) found.push('<script')
  if (/<foreignObject/i.test(s)) found.push('<foreignObject')
  if (/\bon[a-z]+\s*=/i.test(s)) found.push('an on…= handler')
  if (/http/i.test(s)) found.push('http')
  if (/style\s*=|<style/i.test(s)) found.push('style')
  if (/<(image|use|a|iframe|filter|animate|set|linearGradient|radialGradient|defs|pattern)\b/i.test(s)) found.push('an element it may not hold')
  if (/NaN|Infinity|undefined|null/.test(s)) found.push('a value that is not one')
  const svg = parse(source)
  const ids = new Set(all(svg).map(e => e.attrs.id).filter(id => id !== undefined))
  for (const id of ids) if (!id.startsWith('atlas-folio-')) found.push(`id="${id}"`)
  walk(svg, el => {
    if (!ELEMENTS.has(el.name)) found.push(`<${el.name}>`)
    for (const [key, value] of Object.entries(el.attrs)) {
      if (!ATTRIBUTES.has(key)) found.push(`${el.name} ${key}=`)
      const target = /url\(([^)]*)\)/.exec(value)?.[1]
      if (target !== undefined && !(target.startsWith('#') && ids.has(target.slice(1)))) found.push(`${key}="${value}"`)
      if ((key === 'fill' || key === 'stroke') && value !== 'none' && !PALETTE.has(value) && !/^url\(#[\w-]+\)$/.test(value)) found.push(`${key}="${value}"`)
      if (key === 'class' && !CLASSES.has(value)) found.push(`class="${value}"`)
    }
  })
  return found
}

// ---------- the document ----------

describe('folio: the document', () => {
  test('the root tag agrees with the numbers returned', () => {
    for (const [, spec] of PAGES) {
      for (const width of WIDTHS) {
        const r = folioSvg({ ...spec, width })
        expect(r.source.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="${r.width}" height="${r.height}" viewBox="0 0 ${r.width} ${r.height}" role="img" font-family="${FOLIO_FONT}">`)).toBe(true)
        expect(r.source.endsWith('</svg>')).toBe(true)
        expect(r.width).toBe(width)
        expect(Number.isInteger(r.height) && r.height > 0).toBe(true)
        const svg = parse(r.source)
        expect(svg.attrs['font-family']).toBe(FOLIO_FONT)
        expect(svg.attrs.role).toBe('img')
        expect(all(svg, 'title')).toHaveLength(1)
        expect(svg.kids[0] === all(svg, 'title')[0]).toBe(true)
      }
    }
    expect(said(all(parse(folioSvg(BASE).source), 'title')[0] ?? { name: '', attrs: {}, kids: [] })).toBe('Atlas 档案')
    expect(said(all(parse(folioSvg({ title: '', subtitle: '', notes: [] }).source), 'title')[0] ?? { name: '', attrs: {}, kids: [] })).toBe('档案')
  })

  test('width is clamped to 320..680 and is 460 when not given', () => {
    expect(folioSvg(BASE).width).toBe(460)
    expect(folioSvg({ ...BASE, width: 100 }).width).toBe(320)
    expect(folioSvg({ ...BASE, width: -5 }).width).toBe(320)
    expect(folioSvg({ ...BASE, width: 319.4 }).width).toBe(320)
    expect(folioSvg({ ...BASE, width: 9999 }).width).toBe(680)
    expect(folioSvg({ ...BASE, width: Infinity }).width).toBe(460)
    expect(folioSvg({ ...BASE, width: -Infinity }).width).toBe(460)
    expect(folioSvg({ ...BASE, width: NaN }).width).toBe(460)
    expect(folioSvg({ ...BASE, width: 500.6 }).width).toBe(501)
    for (const width of [100, 9999, NaN, 500.6]) {
      const r = folioSvg({ ...BASE, width })
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
    expect(parse('<svg><text>a 😀 档案 &amp;&#61;</text></svg>').kids).toHaveLength(1)
    for (const [, spec] of EVERY) {
      for (const width of WIDTHS) {
        const svg = parse(folioSvg({ ...spec, width }).source)
        // text sits in <text> and <title> only, never between shapes
        walk(svg, el => {
          if (el.name !== 'text' && el.name !== 'title') expect(el.kids.every(k => typeof k !== 'string')).toBe(true)
        })
      }
    }
    // control and direction characters, line breaks and half a surrogate pair never reach the markup
    const odd = folioSvg({ title: 'a\u0000b\u0008c\u001b\u202ed\ufeff\u2067\ud800e\r\n\tf', subtitle: '', notes: [], width: 680 })
    expect(written(parse(odd.source))).toEqual(['abcde f'])
    expect(odd.alt).toBe('档案页插图「abcde f」。')
  })

  test('text is escaped in every field and comes back whole', () => {
    const raw = '<b>&"\''
    for (const width of WIDTHS) {
      const r = folioSvg({ ...allFields(raw), width })
      expect(r.source).not.toContain('<b')
      const svg = parse(r.source)
      for (const el of all(svg)) expect(ELEMENTS.has(el.name)).toBe(true)
      const texts = written(svg)
      // title, subtitle, 3 cards × 2, the chart's title, 6 bars × 2, 4 stubs
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
    expect(forbidden(`<svg ${ns}><rect fill="red"/></svg>`)).not.toHaveLength(0)
    expect(forbidden(`<svg ${ns}><rect fill="#123456"/></svg>`)).not.toHaveLength(0)
    expect(forbidden(`<svg ${ns}><rect style="fill:#F4EFE6"/></svg>`)).not.toHaveLength(0)
    expect(forbidden(`<svg ${ns}><g id="other"/></svg>`)).not.toHaveLength(0)
    expect(forbidden(`<svg ${ns}><use href="#a"/></svg>`)).not.toHaveLength(0)
    expect(forbidden(`<svg ${ns}><text href="#a">a</text></svg>`)).toEqual(['text href='])
    expect(forbidden(`<svg ${ns}><text transform="rotate(3)">a</text></svg>`)).toEqual(['text transform='])
    expect(forbidden(`<svg ${ns}><g id="atlas-folio-a"/><rect fill="url(#atlas-folio-a)"/></svg>`)).toEqual([])
    for (const [, spec] of PAGES) for (const width of WIDTHS) expect(forbidden(folioSvg({ ...spec, width }).source)).toEqual([])
    for (const nasty of NASTY) {
      for (const width of WIDTHS) {
        const r = folioSvg({ ...allFields(nasty), width })
        expect(forbidden(r.source)).toEqual([])
        expect(r.source.split('http').length).toBe(2)
      }
    }
    // the nasty text is still there to read, as text
    const shown = written(parse(folioSvg({ title: 'see http://a.example?x=1', subtitle: '', notes: [], width: 680 }).source))
    expect(shown).toEqual(['see http://a.example?x=1'])
  })

  test('no font under 11px, nothing turned, no gradients, patterns or filters', () => {
    for (const [, spec] of EVERY) {
      for (const width of SWEEP) {
        const r = folioSvg({ ...spec, width })
        const sizes = [...r.source.matchAll(/font-size="([^"]*)"/g)].map(m => Number(m[1]))
        for (const size of sizes) expect(size).toBeGreaterThanOrEqual(11)
        expect(r.source).not.toMatch(/font-size\s*:|font\s*:|style=/)
        expect(r.source).not.toMatch(/Gradient|<filter|filter=|blur|shadow|transform|opacity/i)
        for (const el of all(parse(r.source), 'text')) {
          expect(Number.isFinite(n(el, 'font-size'))).toBe(true)
          expect(Number.isFinite(n(el, 'x')) && Number.isFinite(n(el, 'y'))).toBe(true)
        }
      }
    }
  })

  test('small writing reaches 4.5:1 against what it stands on', () => {
    for (const [, spec] of PAGES) {
      for (const width of WIDTHS) {
        const svg = parse(folioSvg({ ...spec, width }).source)
        const paper = all(group(svg, 'paper'), 'rect')[0]?.attrs.fill ?? ''
        const checked = new Set<El>()
        const check = (el: El | undefined, ground: string | undefined) => {
          if (!el) return
          checked.add(el)
          const ratio = contrast(el.attrs.fill ?? '', ground ?? '')
          if (!(ratio >= 4.5)) throw new Error(`"${said(el)}" is ${el.attrs.fill} on ${ground}: ${ratio.toFixed(2)}:1`)
        }
        for (const el of all(group(svg, 'plate'), 'text')) check(el, all(group(svg, 'plate'), 'rect')[0]?.attrs.fill)
        for (const card of cards(svg)) {
          check(card.number, card.tab.attrs.fill)
          for (const el of card.words) check(el, card.sheet.attrs.fill)
        }
        for (const s of stubs(svg)) check(s.text, s.fill)
        for (const el of all(svg, 'text')) if (!checked.has(el)) check(el, paper)
      }
    }
    // the three stub bodies, each under cream
    for (const body of [FOLIO.wine, FOLIO.mauveDeep, FOLIO.sageDeep]) expect(contrast(FOLIO.cream, body)).toBeGreaterThanOrEqual(4.5)
    for (const tone of Object.values(FOLIO_TONES)) expect(contrast(tone.ink, tone.pale)).toBeGreaterThanOrEqual(4.5)
  })

  test('the same spec gives the same page, and the spec is left as it was', () => {
    for (const [, spec] of PAGES) {
      const before = JSON.stringify(spec)
      const a = folioSvg({ ...spec, width: 460 })
      const b = folioSvg({ ...spec, width: 460 })
      expect(a).toEqual(b)
      expect(folioSvg(spec)).toEqual(a)
      expect(JSON.stringify(spec)).toBe(before)
    }
  })

  test('a usual page is a few thousand characters, and the largest stays far under 131072', () => {
    for (const width of WIDTHS) expect(folioSvg({ ...BASE, width }).source.length).toBeLessThan(8000)
    for (const big of [`W&<>"'档案`.repeat(5000), '\u{1F600}'.repeat(20000), 'i'.repeat(100000), '&'.repeat(100000), 'x '.repeat(50000)]) {
      const spec = allFields(big)
      spec.notes = [...spec.notes, ...spec.notes]
      spec.bars = [...(spec.bars ?? []), ...(spec.bars ?? [])]
      spec.stamps = [...(spec.stamps ?? []), ...(spec.stamps ?? [])]
      for (const width of WIDTHS) {
        const r = folioSvg({ ...spec, width })
        expect(r.source.length).toBeLessThan(20000)
        parse(r.source)
        expect(r.alt.length).toBeLessThan(4000)
        expect(r.alt.length).toBeGreaterThan(0)
      }
    }
    for (const [, page] of EVERY) for (const width of WIDTHS) expect(folioSvg({ ...page, width }).source.length).toBeLessThan(20000)
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
        const r = folioSvg(page)
        const svg = parse(r.source)
        expect(r.alt.length).toBeGreaterThan(0)
        expect(r.alt.startsWith('档案页插图「')).toBe(true)
        expect(Number.isInteger(r.width) && Number.isInteger(r.height) && r.height > 0).toBe(true)
        expect(svg.attrs.viewBox).toBe(`0 0 ${r.width} ${r.height}`)
        walk(svg, el => {
          for (const key of MEASURES) if (el.attrs[key] !== undefined) expect(el.attrs[key], `${el.name} ${key}`).toMatch(/^-?\d+(\.\d+)?$/)
          if (el.attrs.d !== undefined) expect(el.attrs.d, 'a path').toMatch(/^[MLHVQAZlv][MLHVQAZlv0-9 .-]*$/)
        })
        for (const el of all(svg, 'text')) expect(finite(textBox(el))).toBe(true)
      }
    }
    // a number that is none never becomes a length: a bar worth NaN is a tick, a width of NaN the usual one
    const none = folioSvg({ title: 't', subtitle: '', notes: [], bars: [{ label: 'a', value: NaN, text: 'x' }, { label: 'b', value: Infinity, text: 'y' }], width: NaN })
    expect(none.source).not.toMatch(/NaN|Infinity|undefined/)
    expect(none.width).toBe(460)
    // what is not a string is written as journal writes it: nothing for none, else its words
    expect(written(parse(folioSvg({ title: undefined, subtitle: null, notes: [] } as unknown as JournalSpec).source))).toEqual([])
    expect(written(parse(folioSvg({ title: 42, subtitle: true, notes: [] } as unknown as JournalSpec).source))).toEqual(['42', 'true'])
  })
})

// ---------- what is drawn ----------

describe('folio: parts', () => {
  test('the first three notes, six bars and four stamps are drawn', () => {
    const notes: JournalNote[] = [1, 2, 3, 4, 5].map(i => ({ big: `N${i}`, label: `note${i}` }))
    const bars: JournalBar[] = [1, 2, 3, 4, 5, 6, 7, 8].map(i => ({ label: `bar${i}`, value: i, text: `val${i}` }))
    const stamps: JournalStamp[] = [1, 2, 3, 4, 5, 6].map(i => ({ text: `S${i}` }))
    for (const width of WIDTHS) {
      const r = folioSvg({ title: 'caps', subtitle: 'many', notes, barsTitle: 'bars', bars, stamps, width })
      const svg = parse(r.source)
      const shown = all(svg, 'text').map(said)
      expect(shown.filter(s => /^N\d$/.test(s))).toEqual(['N1', 'N2', 'N3'])
      expect(shown.filter(s => /^note\d$/.test(s))).toEqual(['note1', 'note2', 'note3'])
      expect(shown.filter(s => /^0\d\.$/.test(s))).toEqual(['01.', '02.', '03.'])
      expect(chartRows(svg).map(row => row.label)).toEqual(['bar1', 'bar2', 'bar3', 'bar4', 'bar5', 'bar6'])
      expect(chartRows(svg).map(row => row.text)).toEqual(['val1', 'val2', 'val3', 'val4', 'val5', 'val6'])
      expect(shown.filter(s => /^S\d$/.test(s))).toEqual(['S1', 'S2', 'S3', 'S4'])
      expect(stubs(svg)).toHaveLength(4)
      // the longest swatch is the sixth, not the eighth that is not drawn
      const lens = chartRows(svg).map(row => row.len)
      expect(Math.max(...lens)).toBe(lens[5] ?? NaN)
      for (const gone of ['N4', 'N5', 'note4', 'note5', 'bar7', 'bar8', 'val7', 'val8', 'S5', 'S6']) {
        expect(r.source).not.toContain(gone)
        expect(r.alt).not.toContain(gone)
      }
      expect(shown).not.toContain('04.')
    }
  })

  test('a part with no data is left out and the page is that much shorter', () => {
    for (const width of WIDTHS) {
      const full = folioSvg({ ...BASE, width })
      const fullSvg = parse(full.source)
      for (const cls of ['paper', 'frame', 'head', 'cards', 'bars', 'stubs']) expect(groups(fullSvg, cls)).toHaveLength(1)
      expect(groups(fullSvg, 'card')).toHaveLength(3)
      expect(groups(fullSvg, 'row')).toHaveLength(3)

      const noNotes = folioSvg({ ...BASE, notes: [], width })
      expect(group(parse(noNotes.source), 'cards')).toBeUndefined()
      expect(noNotes.height).toBeLessThan(full.height)
      expect(noNotes.alt).not.toContain('卡片')
      expect(all(parse(noNotes.source), 'text').map(said)).not.toContain('01.')

      for (const bars of [[], undefined]) {
        const noBars = folioSvg({ ...BASE, bars, width })
        expect(group(parse(noBars.source), 'bars')).toBeUndefined()
        expect(groups(parse(noBars.source), 'row')).toHaveLength(0)
        expect(noBars.source).not.toContain('谁最占地方')
        expect(noBars.alt).not.toContain('谁最占地方')
        expect(noBars.height).toBeLessThan(full.height)
      }

      for (const stamps of [[], undefined, [{ text: '' }, { text: '  ' }]]) {
        const noStamps = folioSvg({ ...BASE, stamps, width })
        expect(group(parse(noStamps.source), 'stubs')).toBeUndefined()
        expect(noStamps.height).toBeLessThan(full.height)
        expect(noStamps.alt).not.toContain('标签')
      }

      const bare = folioSvg({ title: BASE.title, subtitle: BASE.subtitle, notes: [], barsTitle: BASE.barsTitle, width })
      const bareSvg = parse(bare.source)
      for (const cls of ['cards', 'card', 'bars', 'stubs', 'row']) expect(groups(bareSvg, cls)).toHaveLength(0)
      expect(written(bareSvg)).toEqual([BASE.title, BASE.subtitle])
      for (const other of [noNotes, folioSvg({ ...BASE, bars: [], width }), folioSvg({ ...BASE, stamps: [], width })]) {
        expect(bare.height).toBeLessThan(other.height)
      }

      const untitled = folioSvg({ ...BASE, barsTitle: undefined, width })
      expect(untitled.height).toBeLessThan(full.height)
      expect(chartRows(parse(untitled.source))).toHaveLength(3)

      const blank = folioSvg({ title: '', subtitle: '', notes: [], width })
      expect(written(parse(blank.source))).toEqual([])
      expect(blank.height).toBeLessThanOrEqual(bare.height)
    }
  })

  test('the paper fills the image with a small margin, and a double frame with notched corners lies inside it', () => {
    for (const [, spec] of PAGES) {
      for (const width of WIDTHS) {
        const r = folioSvg({ ...spec, width })
        const svg = parse(r.source)
        const paper = paperBox(svg)
        expect(inside(paper, { x0: 0, x1: r.width, y0: 0, y1: r.height })).toBe(true)
        expect(paper.x0).toBeLessThanOrEqual(12)
        expect(r.width - paper.x1).toBeLessThanOrEqual(12)
        expect(paper.y0).toBeLessThanOrEqual(12)
        expect(r.height - paper.y1).toBeLessThanOrEqual(12)
        const sheet = all(group(svg, 'paper'), 'rect')[0]
        expect(sheet?.attrs.fill).toBe(FOLIO.paper)
        expect(sheet?.attrs.stroke).toBe(FOLIO.paperEdge)
        expect(n(sheet ?? svg, 'rx')).toBeGreaterThan(0)
        expect(n(sheet ?? svg, 'rx')).toBeLessThanOrEqual(8)

        const f = frame(svg)
        const lines = all(group(svg, 'frame'), 'path').filter(p => p.attrs.fill === 'none' && (p.attrs.d ?? '').includes('A'))
        expect(lines.map(p => p.attrs.stroke)).toEqual([FOLIO.gold, FOLIO.goldSoft])
        expect(finite(f.outer) && finite(f.inner)).toBe(true)
        expect(inside(grown(f.outer, 4), paper)).toBe(true)
        expect(inside(grown(f.inner, 2.5), f.outer)).toBe(true)
        expect(f.outer.x0 - paper.x0).toBeLessThanOrEqual(10)
        // each corner is cut by four arcs, and a fan sits in each
        for (const line of lines) expect((line.attrs.d ?? '').split('A')).toHaveLength(5)
        const fans = all(group(svg, 'frame'), 'path').find(p => p.attrs.fill === FOLIO.brassLight)
        expect((fans?.attrs.d ?? '').split('M')).toHaveLength(5)
        expect(inside(pathBox(fans?.attrs.d ?? ''), f.outer)).toBe(true)
        expect(f.reach).toBeLessThan(f.outer.y1 - f.outer.y0)
      }
    }
  })

  test('the plate and the seal are drawn together, and only with 10px between them and what is written', () => {
    const sides = (spec: JournalSpec) => {
      const svg = parse(folioSvg(spec).source)
      return { svg, plate: group(svg, 'plate'), seal: group(svg, 'seal') }
    }
    let drawn = 0
    for (const [name, spec] of EVERY) {
      for (let width = 320; width <= 680; width += 4) {
        const { svg, plate, seal } = sides({ ...spec, width })
        expect(plate === undefined, `${name} at ${width}`).toBe(seal === undefined)
        if (!plate || !seal) continue
        drawn++
        const f = frame(svg)
        const body = rectBox(all(plate, 'rect')[0] ?? svg)
        const wax = pathBox(all(seal, 'path')[0]?.attrs.d ?? '')
        expect(all(plate, 'text').map(said)).toEqual(['ATLAS', 'ARCHIVE'])
        expect(all(plate, 'circle')).toHaveLength(2)
        // far left and far right, inside the frame, clear of its lines and its notches
        expect(inside(grown(body, 4), f.inner), `${name} at ${width}`).toBe(true)
        expect(inside(grown(wax, 3), f.inner), `${name} at ${width}`).toBe(true)
        expect(body.x1).toBeLessThan(wax.x0)
        for (const [cx, cy] of [[f.outer.x0, f.outer.y0], [f.outer.x1, f.outer.y0]] as const) {
          for (const box of [body, wax]) expect(gap(box, { x0: cx, x1: cx, y0: cy, y1: cy })).toBeGreaterThan(f.reach + 2)
        }
        // the plate's words between its rivets
        const [left, right] = all(plate, 'circle').map(circleBox)
        for (const el of all(plate, 'text')) {
          const box = textBox(el)
          expect(box.x0, said(el)).toBeGreaterThanOrEqual((left?.x1 ?? NaN) + 1)
          expect(box.x1, said(el)).toBeLessThanOrEqual((right?.x0 ?? NaN) - 1)
          expect(inside(box, body), said(el)).toBe(true)
        }
        // 10px from the title, the subtitle and every ornament of the head
        const head = group(svg, 'head')
        const mine = new Set([...all(plate), ...all(seal)])
        for (const el of all(head, 'text')) {
          if (mine.has(el)) continue
          for (const box of [body, wax]) expect(gap(box, textBox(el)), `${name} at ${width}: "${said(el)}"`).toBeGreaterThanOrEqual(9.4)
        }
        for (const el of all(head, 'path')) {
          if (mine.has(el)) continue
          for (const box of [body, wax]) expect(gap(box, pathBox(el.attrs.d ?? '')), `${name} at ${width}`).toBeGreaterThanOrEqual(9.4)
        }
      }
    }
    expect(drawn).toBeGreaterThan(100)
    const has = (spec: JournalSpec) => sides(spec).plate !== undefined
    // the usual title: room from 350 up, none on a narrow page; never beside a title that fills the page
    expect(has({ ...BASE, width: 320 }), 'the usual page at 320').toBe(false)
    expect(has({ ...BASE, width: 340 }), 'the usual page at 340').toBe(false)
    expect(has({ ...BASE, width: 360 }), 'the usual page at 360').toBe(true)
    expect(has({ ...BASE, width: 460 }), 'the usual page at 460').toBe(true)
    expect(has({ ...BASE, width: 680 }), 'the usual page at 680').toBe(true)
    for (const width of WIDTHS) {
      expect(has({ ...LONG, width }), `long text at ${width}`).toBe(false)
      expect(folioSvg({ ...LONG, width }).source).not.toContain('ARCHIVE')
      // a page with nothing written: the ornament alone leaves room from 340 up
      expect(has({ title: '', subtitle: '', notes: [], width }), `nothing at ${width}`).toBe(width >= 340)
    }
    // a long subtitle under a short title: the two are lifted above it, or left out
    expect(has({ ...BASE, subtitle: LONG.subtitle, width: 680 }), 'a long subtitle at 680').toBe(true)
    expect(has({ ...BASE, title: '', subtitle: LONG.subtitle, width: 320 }), 'a long subtitle alone at 320').toBe(false)
    // the seal: a wine disc, a ring pressed into it, a lighter spark
    const seal = sides({ ...BASE, width: 460 }).seal
    expect(all(seal, 'path').map(p => p.attrs.fill)).toEqual([FOLIO.wine, FOLIO.wineLight])
    expect(all(seal, 'circle').map(c => c.attrs.stroke)).toEqual([FOLIO.wineDeep])
  })

  test('card tones follow the spec, or the position; tabs are numbered in cream on wine', () => {
    const sheets = (spec: JournalSpec) => cards(parse(folioSvg(spec).source)).map(card => card.sheet.attrs.fill)
    const T = FOLIO_TONES
    expect(sheets(BASE)).toEqual([T.oat.pale, T.rose.pale, T.sage.pale])
    expect(sheets({ ...BASE, notes: [{ big: '1', label: 'a', tone: 'blue' }, { big: '2', label: 'b', tone: 'purple' }, { big: '3', label: 'c', tone: 'yellow' }] })).toEqual([T.haze.pale, T.mauve.pale, T.oat.pale])
    expect(sheets({ ...BASE, notes: [{ big: '1', label: 'a', tone: 'pink' }, { big: '2', label: 'b', tone: 'mint' }, { big: '3', label: 'c' }] })).toEqual([T.rose.pale, T.sage.pale, T.sage.pale])
    for (const width of WIDTHS) {
      const page = cards(parse(folioSvg({ ...BASE, notes: [{ big: '7', label: 'x', tone: 'purple' }, { big: '8', label: 'y', tone: 'blue' }], width }).source))
      expect(page.map(card => said(card.number ?? card.sheet))).toEqual(['01.', '02.'])
      const tones = [T.mauve, T.haze]
      page.forEach((card, i) => {
        expect(card.sheet.attrs.fill).toBe(tones[i]?.pale)
        expect(card.sheet.attrs.stroke).toBe(tones[i]?.deep)
        expect(card.inner.attrs.fill).toBe('none')
        expect(card.inner.attrs.stroke).toBe(FOLIO.gold)
        expect(card.tab.attrs.fill).toBe(FOLIO.wine)
        expect(card.number?.attrs.fill).toBe(FOLIO.cream)
        for (const el of card.words) expect(el.attrs.fill).toBe(tones[i]?.ink)
      })
    }
  })

  test('stubs take their body from the tone: wine, deep mauve, deep sage', () => {
    const bodies = (stamps: JournalStamp[]) => stubs(parse(folioSvg({ ...BASE, stamps }).source)).map(s => s.fill)
    expect(bodies([{ text: 'a', tone: 'coral' }, { text: 'b', tone: 'purple' }, { text: 'c', tone: 'teal' }])).toEqual([FOLIO.wine, FOLIO.mauveDeep, FOLIO.sageDeep])
    expect(bodies([{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd', tone: 'teal' }])).toEqual([FOLIO.wine, FOLIO.mauveDeep, FOLIO.sageDeep, FOLIO.sageDeep])
    for (const s of stubs(parse(folioSvg({ ...BASE, width: 460 }).source))) expect(s.text?.attrs.fill).toBe(FOLIO.cream)
  })

  test('the head: an ornament over a centred wine title, the subtitle between two rules', () => {
    for (const width of WIDTHS) {
      const svg = parse(folioSvg({ ...BASE, stamps: [], width }).source)
      const head = group(svg, 'head')
      const mine = new Set([...all(group(svg, 'plate')), ...all(group(svg, 'seal'))])
      const texts = all(head, 'text').filter(el => !mine.has(el))
      const [title, subtitle] = texts
      expect(texts).toHaveLength(2)
      expect(title?.attrs.fill).toBe(FOLIO.wineDeep)
      expect(subtitle?.attrs.fill).toBe(FOLIO.inkSoft)
      expect(n(subtitle ?? svg, 'letter-spacing')).toBeGreaterThan(0)
      expect(n(title ?? svg, 'font-size')).toBeGreaterThan(n(subtitle ?? svg, 'font-size') + 6)
      for (const el of texts) expect(el.attrs['text-anchor']).toBe('middle')
      // both centred on the page
      const titleBox = textBox(title ?? svg)
      const subBox = textBox(subtitle ?? svg)
      expect(Math.abs((titleBox.x0 + titleBox.x1) / 2 - width / 2)).toBeLessThan(0.1)
      expect(Math.abs((subBox.x0 + subBox.x1) / 2 - width / 2)).toBeLessThan(0.6)
      // five pieces over the title, four beside the subtitle
      const marks = all(head, 'path').filter(el => !mine.has(el))
      expect(marks).toHaveLength(9)
      const over = marks.slice(0, 5).map(el => pathBox(el.attrs.d ?? ''))
      const beside = marks.slice(5).map(el => pathBox(el.attrs.d ?? ''))
      for (const box of over) expect(box.y1).toBeLessThan(titleBox.y0)
      // hairline, lozenge, spark, lozenge, hairline: left to right, the same on both sides of the page's middle
      over.forEach((box, i) => {
        const next = over[i + 1]
        if (next) expect(next.x0).toBeGreaterThan(box.x1)
        const twin = over[4 - i] ?? box
        expect(Math.abs(box.x0 + twin.x1 - width)).toBeLessThan(0.3)
      })
      expect(marks.slice(0, 5).map(el => (el.attrs.fill === 'none' ? el.attrs.stroke : el.attrs.fill))).toEqual([FOLIO.gold, FOLIO.gold, FOLIO.wine, FOLIO.gold, FOLIO.gold])
      // the rules stand clear of the subtitle, one on each side, level with it
      for (const box of beside) {
        expect(gap(box, subBox)).toBeGreaterThanOrEqual(5)
        expect(box.y0).toBeGreaterThan(subBox.y0)
        expect(box.y1).toBeLessThan(subBox.y1)
      }
      expect(beside.filter(box => box.x1 < subBox.x0)).toHaveLength(2)
      expect(beside.filter(box => box.x0 > subBox.x1)).toHaveLength(2)
    }
    // a subtitle that fills the line has no room for rules, and gets none
    const tight = parse(folioSvg({ ...BASE, subtitle: LONG.subtitle, notes: [], bars: [], stamps: [], width: 320 }).source)
    expect(all(group(tight, 'head'), 'path')).toHaveLength(5)
  })
})

// ---------- bars ----------

describe('folio: swatches', () => {
  const chart = (bars: JournalBar[], width?: number) => {
    const r = folioSvg({ title: 't', subtitle: 's', notes: [], bars, width })
    return { r, rows: chartRows(parse(r.source)) }
  }

  test('a swatch is as long as its share of the largest value', () => {
    for (const width of WIDTHS) {
      const values = [100, 50, 25, 10, 80, 100]
      const { rows } = chart(values.map((value, i) => ({ label: `row${i}`, value, text: String(value) })), width)
      const full = rows[0]?.len ?? NaN
      expect(full).toBeGreaterThan(60)
      rows.forEach((row, i) => {
        const want = ((values[i] ?? NaN) / 100) * full
        expect(Math.abs(row.len - want)).toBeLessThanOrEqual(0.25)
      })
      // every swatch starts on the same line, in the order given, one under the other, all the same height
      expect(new Set(rows.map(row => row.x)).size).toBe(1)
      expect(new Set(rows.map(row => Math.round((row.bottom - row.top) * 10))).size).toBe(1)
      rows.forEach((row, i) => {
        const next = rows[i + 1]
        if (next) expect(next.top).toBeGreaterThan(row.bottom + 4)
      })
      // six Morandi tones, in turn
      const T = FOLIO_TONES
      expect(rows.map(row => row.color)).toEqual([T.rose.deep, T.sage.deep, T.oat.deep, T.haze.deep, T.taupe.deep, T.mauve.deep])
    }
  })

  test('the right end is pinked: points 4px apart, 3px deep, and flat on a stub too short for them', () => {
    for (const width of WIDTHS) {
      const { rows } = chart([{ label: 'long', value: 100 }, { label: 'mid', value: 12 }, { label: 'tiny', value: 1 }], width)
      const [long, mid, tiny] = rows
      const height = (long?.bottom ?? NaN) - (long?.top ?? NaN)
      expect(height % 4).toBe(0)
      expect((long?.d ?? '').split(' l3 2 l-3 2')).toHaveLength(height / 4 + 1)
      expect(Math.abs((long?.bottom ?? NaN) - (long?.top ?? NaN) - height)).toBe(0)
      expect((mid?.len ?? NaN) < 20 ? (mid?.d ?? '').includes(' l1.5 2 l-1.5 2') : (mid?.d ?? '').includes(' l3 2 l-3 2')).toBe(true)
      expect(tiny?.d).not.toContain('l')
      expect((tiny?.bottom ?? NaN) - (tiny?.top ?? NaN)).toBe(height)
      // the points reach the swatch's full length and no further
      expect(Math.max(...rows.map(row => row.len))).toBe(long?.len ?? NaN)
    }
  })

  test('the swatches use the room between the labels and what is written after them', () => {
    for (const spec of [BASE, LONG]) {
      for (let width = 320; width <= 680; width += 30) {
        const svg = parse(folioSvg({ ...spec, width }).source)
        const inner = frame(svg).inner
        const rows = chartRows(svg)
        const longest = Math.max(...rows.map(row => row.len))
        expect(longest).toBeGreaterThan(60)
        for (const row of rows) {
          if (row.labelEl) expect(textBox(row.labelEl).x1).toBeLessThanOrEqual(row.x - 4)
          if (row.textEl) {
            expect(textBox(row.textEl).x0).toBeGreaterThanOrEqual(row.x + row.len + 4)
            expect(textBox(row.textEl).x1).toBeLessThanOrEqual(inner.x1 - 4)
          }
          expect(row.x + row.len).toBeLessThanOrEqual(inner.x1 - 4)
          expect(row.labelEl?.attrs.fill ?? FOLIO.ink).toBe(FOLIO.ink)
          expect(row.textEl?.attrs.fill ?? FOLIO.inkSoft).toBe(FOLIO.inkSoft)
        }
      }
    }
  })

  test('zero, negative, NaN and infinite values count as nothing and never reach the output', () => {
    for (const width of WIDTHS) {
      const { r, rows } = chart([0, -5, NaN, Infinity, -Infinity, 7].map(value => ({ label: 'v', value })), width)
      expect(r.source).not.toMatch(/NaN|Infinity/)
      expect(r.alt).not.toMatch(/NaN|Infinity/)
      expect(rows.map(row => row.len > 0)).toEqual([false, false, false, false, false, true])
      expect(rows.map(row => row.text)).toEqual(['0', '0', '0', '0', '0', '7'])
      expect(rows[5]?.len ?? 0).toBeGreaterThan(60)
      for (const row of rows) expect([row.x, row.len, row.top, row.bottom].every(Number.isFinite)).toBe(true)
      // nothing is a thin tick in the row's own colour, not a swatch
      const ticks = groups(parse(r.source), 'row').map(g => all(g, 'path')[0])
      expect(ticks.slice(0, 5).map(p => p?.attrs.fill)).toEqual(['none', 'none', 'none', 'none', 'none'])
      expect(ticks[0]?.attrs.stroke).toBe(FOLIO_TONES.rose.deep)
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
    // an empty text is the caller's choice: nothing is written after the swatch
    const quiet = chart([{ label: 'a', value: 3, text: '' }]).rows
    expect(quiet[0]?.textEl).toBeUndefined()
  })

  test('the heading: a spark, the text, a rule to the right edge that ends in a lozenge', () => {
    for (const spec of [BASE, LONG, allFields('MWM@WMW HHOOQQ')]) {
      for (const width of SWEEP) {
        const svg = parse(folioSvg({ ...spec, width }).source)
        const bars = group(svg, 'bars')
        const heading = all(bars, 'text')[0]
        const marks = all(bars, 'path').slice(0, 3)
        const [spark, rule, lozenge] = marks.map(el => pathBox(el.attrs.d ?? ''))
        if (!heading || !spark || !rule || !lozenge) throw new Error('a heading short of a piece')
        expect(heading.attrs.fill).toBe(FOLIO.wineDeep)
        expect(marks.map(el => (el.attrs.fill === 'none' ? el.attrs.stroke : el.attrs.fill))).toEqual([FOLIO.wine, FOLIO.gold, FOLIO.gold])
        const box = textBox(heading)
        expect(spark.x1).toBeLessThanOrEqual(box.x0 - 4)
        expect(rule.x0).toBeGreaterThanOrEqual(box.x1 + 8)
        expect(rule.x1 - rule.x0).toBeGreaterThanOrEqual(12)
        expect(lozenge.x0).toBeGreaterThanOrEqual(rule.x1)
        // the rule is level with the middle of the text and ends where the stubs and swatches may
        expect(rule.y0).toBeGreaterThan(box.y0)
        expect(rule.y0).toBeLessThan(box.y1)
        expect(lozenge.x1).toBeLessThanOrEqual(frame(svg).inner.x1 - 4)
        // the first swatch starts under the heading
        expect(chartRows(svg)[0]?.top ?? 0).toBeGreaterThan(box.y1 + 4)
      }
    }
  })
})

// ---------- layout ----------

describe('folio: layout', () => {
  test('long text is cut with an ellipsis, in CJK and in Latin', () => {
    for (const width of WIDTHS) {
      const svg = parse(folioSvg({ ...LONG, width }).source)
      const shown = all(svg, 'text').map(said)
      const head = all(group(svg, 'head'), 'text').map(said)
      expect(head).toHaveLength(2)
      for (const s of head) expect(s.endsWith('…')).toBe(true)
      expect(LONG.title.startsWith((head[0] ?? '').slice(0, -1))).toBe(true)
      expect(LONG.subtitle.startsWith((head[1] ?? '').slice(0, -1).trimEnd())).toBe(true)
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

  test('the measure: the serif’s own widths, never under what either face gives a letter', () => {
    expect(serifWidth('', 13)).toBe(0)
    expect(serifWidth('档案', 10)).toBe(20)
    expect(serifWidth('0', 100)).toBe(62)
    expect(serifWidth(' ', 100)).toBe(25)
    expect(serifWidth('W', 100)).toBe(98)
    expect(serifWidth('i', 100)).toBe(30)
    expect(serifWidth('~', 100)).toBe(67)
    expect(serifWidth('…', 100)).toBe(100)
    expect(serifWidth('·', 100)).toBe(34)
    // the spacing follows every letter
    expect(Math.abs(serifWidth('ab', 10, 2) - (5.1 + 5.6 + 4))).toBeLessThan(1e-9)
    // Baskerville's and Georgia's widest: no letter of either is measured narrower
    expect(serifWidth('Atlas 档案', 24)).toBeGreaterThanOrEqual((0.677 + 0.345 + 0.286 + 0.504 + 0.432 + 0.25 + 2) * 24)
    expect(serifWidth('MEMORY.md', 12)).toBeGreaterThanOrEqual((0.927 + 0.653 + 0.927 + 0.823 + 0.729 + 0.677 + 0.27 + 0.881 + 0.574) * 12)
    for (let c = 0x20; c <= 0x7e; c++) {
      const w = serifWidth(String.fromCharCode(c), 100)
      expect(w).toBeGreaterThanOrEqual(22)
      expect(w).toBeLessThanOrEqual(98)
    }
    for (const ch of ['é', 'ж', 'Ж', 'Ω', '→', '€', '😀', '、', 'ｱ', '\u200d']) expect(serifWidth(ch, 100)).toBeGreaterThanOrEqual(82)
  })

  test('every text stays inside the frame, clear of its lines and of its corners', () => {
    for (const [name, spec] of EVERY) {
      for (const width of SWEEP) {
        const r = folioSvg({ ...spec, width })
        const svg = parse(r.source)
        const f = frame(svg)
        const corners = [[f.outer.x0, f.outer.y0], [f.outer.x1, f.outer.y0], [f.outer.x1, f.outer.y1], [f.outer.x0, f.outer.y1]] as const
        for (const el of all(svg, 'text')) {
          const box = textBox(el)
          const where = `${name} at ${width}: "${said(el)}"`
          expect(finite(box), where).toBe(true)
          expect(box.x0, where).toBeGreaterThanOrEqual(f.inner.x0 + 4)
          expect(box.x1, where).toBeLessThanOrEqual(f.inner.x1 - 4)
          expect(box.y0, where).toBeGreaterThanOrEqual(f.inner.y0 + 4)
          expect(box.y1, where).toBeLessThanOrEqual(f.inner.y1 - 4)
          for (const [cx, cy] of corners) expect(gap(box, { x0: cx, x1: cx, y0: cy, y1: cy }), where).toBeGreaterThan(f.reach + 2)
        }
      }
    }
  })

  test('no text runs into another', () => {
    for (const [name, spec] of EVERY) {
      for (const width of SWEEP) {
        const boxes = all(parse(folioSvg({ ...spec, width }).source), 'text').map(el => ({ box: textBox(el), s: said(el) }))
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
        const svg = parse(folioSvg({ ...spec, width }).source)
        const texts = all(svg, 'text')
        // a text's own ground (its plate, card, tab or stub) is not an ornament beside it
        const grounds = new Set<El>()
        for (const g of [group(svg, 'plate'), ...groups(svg, 'card')]) for (const el of all(g)) grounds.add(el)
        const shapes: { el: El; box: Box }[] = []
        walk(svg, (el, above) => {
          if (grounds.has(el) || above.some(g => g.attrs.class === 'paper' || g.attrs.class === 'frame')) return
          if (el.name === 'path') shapes.push({ el, box: pathBox(el.attrs.d ?? '') })
          if (el.name === 'circle') shapes.push({ el, box: circleBox(el) })
        })
        const bodies = stubs(svg)
        for (const text of texts) {
          if (grounds.has(text)) continue
          const box = textBox(text)
          const own = bodies.find(s => s.text === text)
          for (const shape of shapes) {
            // a stub's body and the fine rules on it lie under its own text
            if (own && inside(shape.box, own.box)) continue
            if (gap(box, shape.box) < 3) throw new Error(`${name} at ${width}: "${said(text)}" is ${gap(box, shape.box).toFixed(1)}px from ${shape.el.attrs.d ?? 'a circle'}`)
          }
        }
      }
    }
  })

  test('cards stand side by side, the same size, each text inside its own, clear of the tab and the fine frame', () => {
    for (const [name, spec] of PAGES) {
      for (const width of SWEEP) {
        const r = folioSvg({ ...spec, width })
        const svg = parse(r.source)
        const f = frame(svg)
        const page = cards(svg)
        expect(page.length).toBe(Math.min(3, spec.notes.length))
        const sheets = page.map(card => rectBox(card.sheet))
        sheets.forEach((sheet, i) => {
          expect(inside(grown(sheet, 4), f.inner)).toBe(true)
          expect(sheet.x1 - sheet.x0).toBeGreaterThan(70)
          const next = sheets[i + 1]
          if (next) {
            expect(next.x0).toBeGreaterThanOrEqual(sheet.x1 + 4)
            expect(Math.abs(next.x1 - next.x0 - (sheet.x1 - sheet.x0))).toBeLessThan(0.3)
            expect(next.y0).toBe(sheet.y0)
            expect(next.y1).toBe(sheet.y1)
          }
        })
        // the row is centred on the page
        const first = sheets[0]
        const last = sheets[sheets.length - 1]
        if (first && last) expect(Math.abs(first.x0 + last.x1 - width)).toBeLessThan(0.3)
        page.forEach((card, i) => {
          const sheet = sheets[i] ?? { x0: NaN, x1: NaN, y0: NaN, y1: NaN }
          const inner = rectBox(card.inner)
          const tab = rectBox(card.tab)
          const where = `${name} at ${width}, card ${i + 1}`
          expect(inside(inner, sheet), where).toBe(true)
          expect(inner.x0 - sheet.x0).toBeGreaterThanOrEqual(2)
          // the tab straddles the top edge near the left, its number inside it
          expect(tab.y0, where).toBeLessThan(sheet.y0 - 4)
          expect(tab.y1, where).toBeGreaterThan(sheet.y0 + 4)
          expect(tab.x0, where).toBeGreaterThan(sheet.x0)
          expect((tab.x0 + tab.x1) / 2, where).toBeLessThan((sheet.x0 + sheet.x1) / 2)
          expect(card.number !== undefined && inside(textBox(card.number), { x0: tab.x0 + 2, x1: tab.x1 - 2, y0: tab.y0, y1: tab.y1 }), where).toBe(true)
          for (const el of card.words) {
            const box = textBox(el)
            expect(inside(box, { x0: inner.x0 + 3, x1: inner.x1 - 3, y0: inner.y0, y1: inner.y1 - 3 }), `${where}: "${said(el)}"`).toBe(true)
            expect(box.y0, `${where}: "${said(el)}"`).toBeGreaterThanOrEqual(tab.y1 + 2)
            expect(sheets.filter(other => overlap(box, other))).toHaveLength(1)
          }
        })
        // the head ends above the cards and their tabs
        const tabTop = Math.min(...page.map(card => rectBox(card.tab).y0))
        if (page.length > 0) {
          for (const el of all(group(svg, 'head'), 'text')) expect(textBox(el).y1).toBeLessThan(tabTop)
          for (const el of all(group(svg, 'head'), 'rect')) expect(rectBox(el).y1).toBeLessThan(tabTop)
          for (const el of all(group(svg, 'head'), 'path')) expect(pathBox(el.attrs.d ?? '').y1).toBeLessThan(tabTop)
        }
      }
    }
  })

  test('stubs lie inside the frame, none on another, each text between its two bites', () => {
    for (const [name, spec] of EVERY) {
      for (const width of SWEEP) {
        const r = folioSvg({ ...spec, width })
        const svg = parse(r.source)
        const f = frame(svg)
        const page = stubs(svg)
        expect(page.length).toBe(all(group(svg, 'stubs'), 'text').length)
        page.forEach((s, i) => {
          const where = `${name} at ${width}, stub ${i + 1}`
          expect(inside(grown(s.box, 4), f.inner), where).toBe(true)
          for (const other of page.slice(i + 1)) expect(overlap(s.box, other.box), where).toBe(false)
          // 4px is a bite's depth
          expect(s.text !== undefined && inside(textBox(s.text), { x0: s.box.x0 + 4 + 4, x1: s.box.x1 - 4 - 4, y0: s.box.y0 + 3, y1: s.box.y1 - 3 }), where).toBe(true)
        })
        // they are set to the right, and the chart ends above them
        const rightmost = Math.max(...page.map(s => s.box.x1))
        if (page.length > 0) {
          for (const top of new Set(page.map(s => s.box.y0))) {
            expect(Math.max(...page.filter(s => s.box.y0 === top).map(s => s.box.x1))).toBe(rightmost)
          }
          const rows = chartRows(svg)
          const last = rows[rows.length - 1]
          if (last) expect(Math.min(...page.map(s => s.box.y0))).toBeGreaterThan(last.bottom + 4)
          for (const card of cards(svg)) expect(Math.min(...page.map(s => s.box.y0))).toBeGreaterThan(rectBox(card.sheet).y1 + 4)
        }
        // the bottom of the page is clear of the last thing drawn
        const lowest = Math.max(...page.map(s => s.box.y1), ...chartRows(svg).map(row => row.bottom), ...cards(svg).map(card => rectBox(card.sheet).y1))
        if (Number.isFinite(lowest)) expect(f.inner.y1 - lowest).toBeGreaterThanOrEqual(8)
      }
    }
  })

  test('four long stamps wrap to more rows instead of leaving the paper', () => {
    const tops = (spec: JournalSpec) => new Set(stubs(parse(folioSvg(spec).source)).map(s => s.box.y0))
    expect(tops({ ...LONG, width: 320 }).size).toBe(2)
    expect(tops({ ...LONG, width: 680 }).size).toBe(2)
    // three that fit whole in two rows keep their text
    const three = [{ text: 'MEMORY.md 已对齐' }, { text: '3 条没链接' }, { text: '回收站 2' }]
    const kept = stubs(parse(folioSvg({ ...BASE, stamps: three, width: 320 }).source)).map(s => (s.text ? said(s.text) : ''))
    expect(kept).toEqual(three.map(s => s.text))
    expect(tops({ ...BASE, stamps: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }], width: 320 }).size).toBe(1)
  })

  test('a short rule with an ornament stands left of the first row of stubs when there is room', () => {
    const rule = (spec: JournalSpec) => {
      const svg = parse(folioSvg(spec).source)
      const marks = all(group(svg, 'stubs'), 'path').filter(p => !(p.attrs.d ?? '').includes('A') && !(p.attrs.d ?? '').includes(' M'))
      return { svg, marks: marks.map(p => pathBox(p.attrs.d ?? '')), fills: marks.map(p => (p.attrs.fill === 'none' ? p.attrs.stroke : p.attrs.fill)) }
    }
    for (const width of WIDTHS) {
      const { svg, marks, fills } = rule({ ...BASE, stamps: [{ text: '好' }], width })
      // two hairlines, four lozenges, the spark
      expect(marks).toHaveLength(7)
      expect(fills.filter(c => c === FOLIO.wine)).toHaveLength(1)
      const first = stubs(svg)[0]?.box ?? { x0: NaN, x1: NaN, y0: NaN, y1: NaN }
      const left = Math.min(...marks.map(b => b.x0))
      const right = Math.max(...marks.map(b => b.x1))
      expect(right - left).toBeGreaterThanOrEqual(80)
      expect(right - left).toBeLessThanOrEqual(120)
      expect(first.x0 - right).toBeGreaterThanOrEqual(16)
      expect(left).toBeGreaterThanOrEqual(frame(svg).inner.x0 + 4)
      for (const box of marks) {
        expect(box.y0).toBeGreaterThan(first.y0)
        expect(box.y1).toBeLessThan(first.y1)
      }
    }
    // a row that fills the page leaves it out
    expect(rule({ ...LONG, width: 320 }).marks).toHaveLength(0)
    expect(rule({ ...BASE, stamps: [{ text: '对话里另有注入 约 13k tokens 还有很多很多很多别的' }], width: 320 }).marks).toHaveLength(0)
  })

  test('a card shrinks its big text before it cuts it, and wraps a long label onto a second line', () => {
    const size = (spec: JournalSpec, text: string) => {
      const el = all(parse(folioSvg(spec).source), 'text').find(e => said(e) === text)
      return el ? n(el, 'font-size') : NaN
    }
    expect(size({ ...BASE, width: 460 }, '12')).toBe(24)
    expect(size({ ...BASE, width: 460 }, '9.8k')).toBe(24)
    expect(size({ ...BASE, width: 320 }, '2 关 · 1 改')).toBeLessThan(size({ ...BASE, width: 320 }, '12'))
    expect(size({ ...BASE, width: 320 }, '2 关 · 1 改')).toBeGreaterThanOrEqual(12)
    expect(size({ ...BASE, width: 680 }, '12')).toBeGreaterThan(24)
    expect(size({ ...LONG, width: 460 }, '12')).toBeNaN()
    for (const width of WIDTHS) {
      const page = cards(parse(folioSvg({ ...LONG, width }).source))
      // per card: the big text and two lines of label, on three lines across the row
      expect(page.map(card => card.words.length)).toEqual([3, 3, 3])
      expect(new Set(page.flatMap(card => card.words.map(el => el.attrs.y))).size).toBe(3)
      // too long even at its smallest, the big text is cut; the nineteen digits fit whole on the widest card
      for (const card of page) expect(n(card.words[0] ?? card.sheet, 'font-size')).toBe(width < 400 ? 12 : 14)
      expect(page.map(card => said(card.words[0] ?? card.sheet).endsWith('…'))).toEqual([true, width < 680, true])
    }
    const wrapped = cards(parse(folioSvg({ ...BASE, width: 320 }).source)).flatMap(card => card.words.map(said))
    expect(wrapped.join('')).toContain('这个会话的改动')
    expect(wrapped).not.toContain('这个会话的改动')
  })
})

// ---------- alt ----------

describe('folio: alt', () => {
  test('alt says the title, each card and each bar, numbers included', () => {
    for (const width of WIDTHS) {
      const { alt } = folioSvg({ ...BASE, width })
      expect(alt).toBe(
        '档案页插图「Atlas 档案」（11 月 13 日 · 提示词页）；卡片：12 段系统提示词、9.8k tokens 左右、2 关 · 1 改 这个会话的改动；谁最占地方：doing_tasks 2.6k、tools 2.1k、memory 1.3k；标签：已关闭 · 本会话、2 处改动。',
      )
    }
  })

  test('alt is journal’s sentence with 档案页插图 for 手帐插图 and 卡片 for 便签', () => {
    for (const [, spec] of EVERY) {
      for (const width of WIDTHS) {
        const mine = folioSvg({ ...spec, width }).alt
        const theirs = journalSvg({ ...spec, width }).alt
        expect(mine).toBe(theirs.replace(/^手帐插图/, '档案页插图').replace('；便签：', '；卡片：'))
      }
    }
  })

  test('alt is one plain sentence: no markup, no line breaks, the value when a bar has no text', () => {
    const { alt } = folioSvg({ title: 'T\n<i>', subtitle: '', notes: [{ big: '3', label: 'a&b' }], bars: [{ label: 'x', value: 12 }, { label: 'y', value: -1 }] })
    expect(alt).toBe('档案页插图「T <i>」；卡片：3 a&b；条形图：x 12、y 0。')
    for (const [, spec] of PAGES) {
      const r = folioSvg(spec)
      expect(r.alt.endsWith('。')).toBe(true)
      expect(r.alt).not.toMatch(/[\r\n\t]/)
      expect(r.alt).not.toMatch(/&(amp|lt|gt|quot|#\d+);/)
      expect(r.alt).toContain(`「${spec.title}`.slice(0, 20))
    }
    expect(folioSvg({ title: '空', subtitle: '', notes: [] }).alt).toBe('档案页插图「空」。')
    expect(folioSvg({ title: '', subtitle: '', notes: [] }).alt).toBe('档案页插图「」。')
  })

  test('alt keeps the text the picture had to cut', () => {
    const { alt, source } = folioSvg({ ...LONG, width: 320 })
    expect(alt).toContain(LONG.title)
    expect(all(parse(source), 'text').map(said).join('\n')).not.toContain(LONG.title)
    expect(alt).toContain(LONG.subtitle.slice(0, 60))
    for (const note of LONG.notes) expect(alt).toContain(`${note.big} ${note.label}`)
    expect(alt).toContain('零 0')
    expect(alt).toContain('混合 mixed 标签 label 混合 mixed 2.25')
  })
})

// ---------- journal ----------

describe('folio: what it borrows from journal', () => {
  /** A string's fingerprint: djb2 over its UTF-16 units. */
  function fingerprint(s: string): number {
    let h = 5381
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
    return h
  }

  test('journal draws what it drew before its helpers were exported (pinned 2026-11-13)', () => {
    const base: JournalSpec = { ...BASE, title: 'Atlas 手帐', subtitle: '11 月 12 日 · 提示词页', notes: [{ big: '24', label: '段系统提示词' }, { big: '9.8k', label: 'tokens 左右' }, { big: '2 关 · 1 改', label: '这个会话的改动' }] }
    const long: JournalSpec = { ...LONG, title: '这是一个特别特别长的手帐标题用来看看会不会被截断到纸的里面' }
    const pins: readonly (readonly [JournalSpec, number, number, number, number])[] = [
      [base, 320, 341, 3708, 1959643018],
      [base, 460, 372, 3659, 1547454820],
      [base, 680, 441, 3646, 3878540294],
      [long, 320, 437, 4656, 944677592],
      [long, 460, 502, 4761, 327888435],
      [long, 680, 588, 4918, 753311915],
    ]
    for (const [spec, width, height, length, print] of pins) {
      const r = journalSvg({ ...spec, width })
      expect(r.height, `journal at ${width}`).toBe(height)
      expect(r.source.length, `journal at ${width}`).toBe(length)
      expect(fingerprint(r.source + r.alt), `journal at ${width}`).toBe(print)
    }
  })
})
