import { describe, expect, test as engineTest } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { journalSvg } from './journal'
import type { JournalBar, JournalNote, JournalSpec, JournalStamp } from './journal'
import { cellWidth } from './text'

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

function all(el: El, name?: string): El[] {
  const out: El[] = []
  walk(el, e => {
    if (!name || e.name === name) out.push(e)
  })
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

/** A text's box by the estimate the layout promises: half its size per cell. */
function textBox(el: El): Box {
  const fs = n(el, 'font-size')
  const w = (cellWidth(said(el)) * fs) / 2
  const anchor = el.attrs['text-anchor']
  const x0 = anchor === 'middle' ? n(el, 'x') - w / 2 : anchor === 'end' ? n(el, 'x') - w : n(el, 'x')
  return { x0, x1: x0 + w, y0: n(el, 'y') - fs * 0.8, y1: n(el, 'y') + fs * 0.2 }
}

function rectBox(el: El): Box {
  return { x0: n(el, 'x'), x1: n(el, 'x') + n(el, 'width'), y0: n(el, 'y'), y1: n(el, 'y') + n(el, 'height') }
}

function inside(inner: Box, outer: Box, slack = 0.05): boolean {
  return inner.x0 >= outer.x0 - slack && inner.x1 <= outer.x1 + slack && inner.y0 >= outer.y0 - slack && inner.y1 <= outer.y1 + slack
}

function overlap(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
}

function finite(b: Box): boolean {
  return [b.x0, b.x1, b.y0, b.y1].every(Number.isFinite)
}

function paperBox(svg: El): Box {
  const paper = group(svg, 'paper')?.kids[0]
  if (!paper || typeof paper === 'string') throw new Error('no paper')
  return rectBox(paper)
}

function numbers(d: string): number[] {
  return (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
}

type Row = { label: string; text: string; textEl: El | undefined; labelEl: El | undefined; x: number; len: number; top: number; bottom: number }

/** The chart's rows: what is written, where the bar starts and how long it runs (0 for a hairline). */
function chartRows(svg: El): Row[] {
  return groups(svg, 'row').map(row => {
    const texts = all(row, 'text')
    const path = all(row, 'path')[0]
    if (!path) throw new Error('a row without a bar')
    const p = numbers(path.attrs.d ?? '')
    const filled = path.attrs.fill !== 'none'
    const x = p[0] ?? NaN
    const labelEl = texts.find(t => n(t, 'x') < x)
    const textEl = texts.find(t => n(t, 'x') > x)
    return {
      label: labelEl ? said(labelEl) : '',
      text: textEl ? said(textEl) : '',
      textEl,
      labelEl,
      x,
      len: filled ? (p[2] ?? NaN) - x : 0,
      top: p[1] ?? NaN,
      bottom: filled ? (p[7] ?? NaN) : (p[2] ?? NaN),
    }
  })
}

// ---------- pages ----------

const WIDTHS = [320, 460, 680] as const

const BASE: JournalSpec = {
  title: 'Atlas 手帐',
  subtitle: '11 月 12 日 · 提示词页',
  notes: [
    { big: '24', label: '段系统提示词' },
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
  title: '这是一个特别特别长的手帐标题用来看看会不会被截断到纸的里面',
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
  'a\u0000b\u0008c\u001bd \ud800 e\r\n\tf',
]

const PAGES: readonly (readonly [string, JournalSpec])[] = [
  ['the usual page', BASE],
  ['long text', LONG],
  ['markup in every field', allFields('<b>&"\'')],
  ['only a title', { title: 'Atlas 手帐', subtitle: '', notes: [] }],
  ['nothing at all', { title: '', subtitle: '', notes: [] }],
  ['one note, bars without a title', { title: '记忆', subtitle: '7 条', notes: [{ big: '7', label: '条' }], bars: [{ label: 'a', value: 1 }, { label: '', value: 2, text: '' }] }],
  ['two notes and a lone stamp', { title: 'T', subtitle: 'S', notes: [{ big: '', label: '' }, { big: '1', label: '' }], stamps: [{ text: 'x' }] }],
]

const ELEMENTS = new Set(['svg', 'title', 'defs', 'pattern', 'g', 'rect', 'circle', 'path', 'text'])
const ATTRIBUTES = new Set([
  'xmlns', 'width', 'height', 'viewBox', 'role', 'font-family', 'id', 'class', 'x', 'y', 'cx', 'cy', 'r', 'rx', 'd',
  'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'opacity', 'transform',
  'patternUnits', 'patternTransform', 'font-size', 'text-anchor',
])
const XMLNS = ' xmlns="http://www.w3.org/2000/svg"'

/** What must never be in the source, whatever the data: the names of what it finds. */
function forbidden(source: string): string[] {
  const s = source.replace(XMLNS, '')
  const found: string[] = []
  if (/<script/i.test(s)) found.push('<script')
  if (/<foreignObject/i.test(s)) found.push('<foreignObject')
  if (/\bon[a-z]+\s*=/i.test(s)) found.push('an on…= handler')
  if (/http/i.test(s)) found.push('http')
  if (/<(style|image|use|a|iframe|linearGradient|radialGradient|filter|animate|set)\b/i.test(s)) found.push('an element it may not hold')
  if (/NaN|Infinity|undefined|null/.test(s)) found.push('a value that is not one')
  const svg = parse(source)
  const ids = new Set(all(svg).map(e => e.attrs.id).filter(Boolean))
  walk(svg, el => {
    if (!ELEMENTS.has(el.name)) found.push(`<${el.name}>`)
    for (const [key, value] of Object.entries(el.attrs)) {
      if (!ATTRIBUTES.has(key)) found.push(`${el.name} ${key}=`)
      const target = /url\(([^)]*)\)/.exec(value)?.[1]
      if (target !== undefined && !(target.startsWith('#') && ids.has(target.slice(1)))) found.push(`${key}="${value}"`)
      if ((key === 'fill' || key === 'stroke') && !/^(none|#[0-9A-F]{6}|url\(#[\w-]+\))$/.test(value)) found.push(`${key}="${value}"`)
    }
  })
  return found
}

// ---------- the document ----------

describe('journal: the document', () => {
  test('the root tag agrees with the numbers returned', () => {
    for (const [, spec] of PAGES) {
      for (const width of WIDTHS) {
        const r = journalSvg({ ...spec, width })
        expect(r.source.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="${r.width}" height="${r.height}" viewBox="0 0 ${r.width} ${r.height}" role="img"`)).toBe(true)
        expect(r.source.endsWith('</svg>')).toBe(true)
        expect(r.width).toBe(width)
        expect(Number.isInteger(r.height) && r.height > 0).toBe(true)
        const svg = parse(r.source)
        expect(svg.attrs['font-family']).toBe("'Hannotate SC','Segoe Print','KaiTi','Chalkboard SE','Marker Felt','Kaiti SC','Songti SC',serif")
        expect(all(svg, 'title')).toHaveLength(1)
      }
    }
  })

  test('width is clamped to 320..680 and is 460 when not given', () => {
    expect(journalSvg(BASE).width).toBe(460)
    expect(journalSvg({ ...BASE, width: 100 }).width).toBe(320)
    expect(journalSvg({ ...BASE, width: -5 }).width).toBe(320)
    expect(journalSvg({ ...BASE, width: 319.4 }).width).toBe(320)
    expect(journalSvg({ ...BASE, width: 9999 }).width).toBe(680)
    expect(journalSvg({ ...BASE, width: Infinity }).width).toBe(460)
    expect(journalSvg({ ...BASE, width: NaN }).width).toBe(460)
    expect(journalSvg({ ...BASE, width: 500.6 }).width).toBe(501)
    for (const width of [100, 9999, NaN, 500.6]) {
      const r = journalSvg({ ...BASE, width })
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
    expect(parse('<svg><text>a 😀 手帐 &amp;&#61;</text></svg>').kids).toHaveLength(1)
    for (const [, spec] of PAGES) {
      for (const width of WIDTHS) {
        const svg = parse(journalSvg({ ...spec, width }).source)
        // text sits in <text> and <title> only, never between shapes
        walk(svg, el => {
          if (el.name !== 'text' && el.name !== 'title') expect(el.kids.every(k => typeof k !== 'string')).toBe(true)
        })
      }
    }
    for (const nasty of NASTY) for (const width of WIDTHS) parse(journalSvg({ ...allFields(nasty), width }).source)
    // control and direction characters, line breaks and half a surrogate pair never reach the markup
    const odd = journalSvg({ title: 'a\u0000b\u0008c\u001b\u202ed\ufeff\ud800e\r\n\tf', subtitle: '', notes: [], width: 680 })
    expect(all(parse(odd.source), 'text').map(said)).toContain('abcde f')
    expect(odd.alt).toBe('手帐插图「abcde f」。')
  })

  test('text is escaped in every field and comes back whole', () => {
    const raw = '<b>&"\''
    for (const width of WIDTHS) {
      const r = journalSvg({ ...allFields(raw), width })
      expect(r.source).not.toContain('<b>')
      expect(r.source).not.toContain('<b')
      const svg = parse(r.source)
      for (const el of all(svg)) expect(ELEMENTS.has(el.name)).toBe(true)
      const written = all(svg, 'text')
        .map(said)
        .filter(s => s !== 'ATLAS' && s !== 'checked')
      // title, subtitle, 3 notes × 2, the chart's title, 6 bars × 2, 4 stamps
      expect(written).toHaveLength(25)
      for (const s of written) expect(s).toBe(raw)
      expect(said(all(svg, 'title')[0] ?? svg)).toBe(raw)
      expect(r.source.split('&lt;b&gt;&amp;&quot;&#39;')).toHaveLength(27)
      expect(r.alt).toContain(raw)
    }
  })

  test('no script, handler, foreignObject or outside reference, whatever the data holds', () => {
    expect(forbidden('<svg xmlns="http://www.w3.org/2000/svg"><text onclick="x">a</text></svg>')).not.toHaveLength(0)
    expect(forbidden('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(http://x/#a)"/></svg>')).not.toHaveLength(0)
    expect(forbidden('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="red"/></svg>')).not.toHaveLength(0)
    for (const [, spec] of PAGES) for (const width of WIDTHS) expect(forbidden(journalSvg({ ...spec, width }).source)).toEqual([])
    for (const nasty of NASTY) {
      for (const width of WIDTHS) {
        const r = journalSvg({ ...allFields(nasty), width })
        expect(forbidden(r.source)).toEqual([])
        expect(r.source.split('http').length).toBe(2)
      }
    }
    // the nasty text is still there to read, as text
    const shown = all(parse(journalSvg({ title: 'see http://a.example?x=1', subtitle: '', notes: [], width: 680 }).source), 'text').map(said)
    expect(shown).toContain('see http://a.example?x=1')
  })

  test('no font under 11px, no turned text, no gradients or filters', () => {
    for (const [, spec] of [...PAGES, ...NASTY.map(s => ['nasty', allFields(s)] as const)]) {
      for (const width of WIDTHS) {
        const r = journalSvg({ ...spec, width })
        const sizes = [...r.source.matchAll(/font-size="([^"]*)"/g)].map(m => Number(m[1]))
        expect(sizes.length).toBeGreaterThan(0)
        for (const size of sizes) expect(size).toBeGreaterThanOrEqual(11)
        expect(r.source).not.toMatch(/font-size\s*:|font\s*:|style=/)
        expect(r.source).not.toMatch(/Gradient|<filter|filter=|blur|shadow/i)
        const svg = parse(r.source)
        walk(svg, (el, above) => {
          if (el.name !== 'text') return
          expect(Number.isFinite(n(el, 'font-size'))).toBe(true)
          for (const e of [el, ...above]) expect(e.attrs.transform).toBeUndefined()
        })
        // the tape is what is turned, a few degrees
        const turned = all(svg).filter(e => e.attrs.transform !== undefined)
        expect(turned.length).toBeGreaterThan(0)
        for (const e of turned) {
          const deg = Number(/^rotate\((-?[\d.]+) /.exec(e.attrs.transform ?? '')?.[1])
          expect(Math.abs(deg)).toBeLessThanOrEqual(6)
          expect(all(e, 'text')).toHaveLength(0)
        }
      }
    }
  })

  test('the same spec gives the same page, and the spec is left as it was', () => {
    for (const [, spec] of PAGES) {
      const before = JSON.stringify(spec)
      const a = journalSvg({ ...spec, width: 460 })
      const b = journalSvg({ ...spec, width: 460 })
      expect(a).toEqual(b)
      expect(journalSvg(spec)).toEqual(a)
      expect(JSON.stringify(spec)).toBe(before)
    }
  })

  test('the largest page stays far under 131072 characters', () => {
    const big = `W&<>"'手帐`.repeat(5000)
    const spec = allFields(big)
    spec.notes = [...spec.notes, ...spec.notes]
    spec.bars = [...(spec.bars ?? []), ...(spec.bars ?? [])]
    spec.stamps = [...(spec.stamps ?? []), ...(spec.stamps ?? [])]
    for (const width of WIDTHS) {
      const r = journalSvg({ ...spec, width })
      expect(r.source.length).toBeLessThan(131072)
      expect(r.source.length).toBeLessThan(20000)
      parse(r.source)
      expect(r.alt.length).toBeLessThan(4000)
    }
    for (const [, page] of PAGES) expect(journalSvg({ ...page, width: 680 }).source.length).toBeLessThan(131072)
  })
})

// ---------- what is drawn ----------

describe('journal: parts', () => {
  test('the first three notes, six bars and four stamps are drawn', () => {
    const notes: JournalNote[] = [1, 2, 3, 4, 5].map(i => ({ big: `N${i}`, label: `note${i}` }))
    const bars: JournalBar[] = [1, 2, 3, 4, 5, 6, 7, 8].map(i => ({ label: `bar${i}`, value: i, text: `val${i}` }))
    const stamps: JournalStamp[] = [1, 2, 3, 4, 5, 6].map(i => ({ text: `S${i}` }))
    for (const width of WIDTHS) {
      const r = journalSvg({ title: 'caps', subtitle: 'many', notes, barsTitle: 'bars', bars, stamps, width })
      const svg = parse(r.source)
      const shown = all(svg, 'text').map(said)
      expect(shown.filter(s => /^N\d$/.test(s))).toEqual(['N1', 'N2', 'N3'])
      expect(shown.filter(s => /^note\d$/.test(s))).toEqual(['note1', 'note2', 'note3'])
      expect(chartRows(svg).map(row => row.label)).toEqual(['bar1', 'bar2', 'bar3', 'bar4', 'bar5', 'bar6'])
      expect(chartRows(svg).map(row => row.text)).toEqual(['val1', 'val2', 'val3', 'val4', 'val5', 'val6'])
      expect(shown.filter(s => /^S\d$/.test(s))).toEqual(['S1', 'S2', 'S3', 'S4'])
      // the longest bar is the sixth, not the eighth that is not drawn
      const lens = chartRows(svg).map(row => row.len)
      expect(Math.max(...lens)).toBe(lens[5] ?? NaN)
      for (const gone of ['N4', 'N5', 'note4', 'note5', 'bar7', 'bar8', 'val7', 'val8', 'S5', 'S6']) {
        expect(r.source).not.toContain(gone)
        expect(r.alt).not.toContain(gone)
      }
    }
  })

  test('a part with no data is left out and the page is that much shorter', () => {
    for (const width of WIDTHS) {
      const full = journalSvg({ ...BASE, width })
      const fullSvg = parse(full.source)
      for (const cls of ['paper', 'tape', 'head', 'notes', 'bars', 'stamps']) expect(groups(fullSvg, cls)).toHaveLength(1)

      const noNotes = journalSvg({ ...BASE, notes: [], width })
      expect(group(parse(noNotes.source), 'notes')).toBeUndefined()
      expect(noNotes.height).toBeLessThan(full.height)
      expect(noNotes.alt).not.toContain('便签')

      for (const bars of [[], undefined]) {
        const noBars = journalSvg({ ...BASE, bars, width })
        expect(group(parse(noBars.source), 'bars')).toBeUndefined()
        expect(groups(parse(noBars.source), 'row')).toHaveLength(0)
        expect(noBars.source).not.toContain('谁最占地方')
        expect(noBars.alt).not.toContain('谁最占地方')
        expect(noBars.height).toBeLessThan(full.height)
      }

      for (const stamps of [[], undefined, [{ text: '' }, { text: '  ' }]]) {
        const noStamps = journalSvg({ ...BASE, stamps, width })
        expect(group(parse(noStamps.source), 'stamps')).toBeUndefined()
        expect(noStamps.height).toBeLessThan(full.height)
        expect(noStamps.alt).not.toContain('标签')
      }

      const bare = journalSvg({ title: BASE.title, subtitle: BASE.subtitle, notes: [], barsTitle: BASE.barsTitle, width })
      const bareSvg = parse(bare.source)
      for (const cls of ['notes', 'bars', 'stamps', 'row']) expect(groups(bareSvg, cls)).toHaveLength(0)
      expect(all(bareSvg, 'text').map(said).filter(s => s !== 'ATLAS' && s !== 'checked')).toEqual([BASE.title, BASE.subtitle])
      for (const other of [noNotes, journalSvg({ ...BASE, bars: [], width }), journalSvg({ ...BASE, stamps: [], width })]) {
        expect(bare.height).toBeLessThan(other.height)
      }

      const untitled = journalSvg({ ...BASE, barsTitle: undefined, width })
      expect(untitled.height).toBeLessThan(full.height)
      expect(chartRows(parse(untitled.source))).toHaveLength(3)

      const blank = journalSvg({ title: '', subtitle: '', notes: [], width })
      expect(all(parse(blank.source), 'text').map(said).filter(s => s !== 'ATLAS' && s !== 'checked')).toEqual([])
      expect(blank.height).toBeLessThanOrEqual(bare.height)
    }
  })

  test('the paper fills the image with a small margin and carries its own colours', () => {
    for (const [, spec] of PAGES) {
      for (const width of WIDTHS) {
        const r = journalSvg({ ...spec, width })
        const svg = parse(r.source)
        const paper = paperBox(svg)
        expect(inside(paper, { x0: 0, x1: r.width, y0: 0, y1: r.height })).toBe(true)
        expect(paper.x0).toBeLessThanOrEqual(12)
        expect(r.width - paper.x1).toBeLessThanOrEqual(12)
        expect(paper.y0).toBeLessThanOrEqual(20)
        expect(r.height - paper.y1).toBeLessThanOrEqual(12)
        const sheet = group(svg, 'paper')?.kids[0]
        expect(typeof sheet !== 'string' && sheet?.attrs.fill).toBe('#FBF6EA')
        expect(typeof sheet !== 'string' && sheet?.attrs.stroke).toBe('#E6DCC6')
      }
    }
  })

  test('the round seal is drawn only when there is room beside the title', () => {
    const seal = (spec: JournalSpec) => all(parse(journalSvg(spec).source), 'circle').filter(c => c.attrs.stroke === '#D85A30').length
    for (const width of WIDTHS) {
      expect(seal({ ...BASE, width })).toBe(1)
      expect(seal({ ...LONG, width })).toBe(0)
      expect(seal({ ...BASE, subtitle: LONG.subtitle, width })).toBe(0)
      expect(journalSvg({ ...LONG, width }).source).not.toContain('checked')
    }
  })

  test('note tones: the three of the mock in order, or the one asked for', () => {
    const fills = (spec: JournalSpec) =>
      all(group(parse(journalSvg(spec).source), 'notes') ?? { name: 'g', attrs: {}, kids: [] }, 'rect')
        .map(rect => rect.attrs.fill)
        .filter(fill => fill !== '#E8DFC9')
    expect(fills(BASE)).toEqual(['#FDE9A8', '#F9D2DE', '#CDEBDD'])
    const asked = fills({ ...BASE, notes: [{ big: '1', label: 'a', tone: 'blue' }, { big: '2', label: 'b', tone: 'purple' }, { big: '3', label: 'c', tone: 'yellow' }] })
    expect(asked).toHaveLength(3)
    expect(asked[2]).toBe('#FDE9A8')
    expect(new Set([...asked, '#F9D2DE', '#CDEBDD']).size).toBe(5)
    const stampColors = all(group(parse(journalSvg({ ...BASE, stamps: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd', tone: 'teal' }] }).source), 'stamps') ?? { name: 'g', attrs: {}, kids: [] }, 'rect').map(rect => rect.attrs.stroke)
    expect(stampColors).toEqual(['#D85A30', '#534AB7', '#0F6E56', '#0F6E56'])
  })
})

// ---------- bars ----------

describe('journal: bars', () => {
  const chart = (bars: JournalBar[], width?: number) => {
    const r = journalSvg({ title: 't', subtitle: 's', notes: [], bars, width })
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
      // every bar starts on the same line, in the order given, one under the other
      expect(new Set(rows.map(row => row.x)).size).toBe(1)
      rows.forEach((row, i) => {
        const next = rows[i + 1]
        if (next) expect(next.top).toBeGreaterThan(row.bottom + 4)
      })
      // six colours, cycling
      const fills = groups(parse(journalSvg({ title: 't', subtitle: '', notes: [], bars: values.map(value => ({ label: 'x', value })), width }).source), 'row').map(g => all(g, 'path')[0]?.attrs.fill)
      expect(fills).toEqual(['#F0997B', '#85B7EB', '#97C459', '#AFA9EC', '#FAC775', '#F4C0D1'])
    }
  })

  test('the bars use the room between the labels and what is written after them', () => {
    for (const spec of [BASE, LONG]) {
      for (let width = 320; width <= 680; width += 30) {
        const svg = parse(journalSvg({ ...spec, width }).source)
        const paper = paperBox(svg)
        const rows = chartRows(svg)
        const longest = Math.max(...rows.map(row => row.len))
        expect(longest).toBeGreaterThan(60)
        for (const row of rows) {
          if (row.labelEl) expect(textBox(row.labelEl).x1).toBeLessThanOrEqual(row.x - 4)
          if (row.textEl) {
            expect(textBox(row.textEl).x0).toBeGreaterThanOrEqual(row.x + row.len + 4)
            expect(textBox(row.textEl).x1).toBeLessThanOrEqual(paper.x1 - 8)
          }
          expect(row.x + row.len).toBeLessThanOrEqual(paper.x1 - 8)
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

  test('the corners wobble by a px or two, the same way every time', () => {
    const bars = [1, 2, 3, 4, 5, 6].map(value => ({ label: 'w', value: 10 + value }))
    const paths = (width: number) => groups(parse(journalSvg({ title: 't', subtitle: '', notes: [], bars, width }).source), 'row').map(g => all(g, 'path')[0]?.attrs.d ?? '')
    expect(paths(460)).toEqual(paths(460))
    const offsets = paths(460).map(d => {
      const p = numbers(d)
      return [(p[3] ?? NaN) - (p[1] ?? NaN), (p[4] ?? NaN) - (p[2] ?? NaN), (p[5] ?? NaN) - (p[7] ?? NaN)].map(v => Math.round(v * 10) / 10)
    })
    for (const o of offsets) for (const v of o) expect(Math.abs(v)).toBeLessThanOrEqual(2)
    // not six rulers: the hands differ from bar to bar
    expect(new Set(offsets.map(o => o.join(','))).size).toBeGreaterThan(3)
    expect(offsets[0]).toEqual([2, -1, 2])
  })
})

// ---------- layout ----------

describe('journal: layout', () => {
  const sweep: number[] = []
  for (let width = 320; width <= 680; width += 20) sweep.push(width)

  test('long text is cut with an ellipsis, in CJK and in Latin', () => {
    for (const width of WIDTHS) {
      const svg = parse(journalSvg({ ...LONG, width }).source)
      const shown = all(svg, 'text').map(said)
      const head = all(group(svg, 'head') ?? svg, 'text').map(said)
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
      // nothing is written whole that could not fit
      for (const whole of [LONG.title, LONG.subtitle, LONG.barsTitle ?? '', ...(LONG.stamps ?? []).slice(0, 2).map(s => s.text)]) {
        expect(shown).not.toContain(whole)
      }
    }
  })

  test('every text stays inside the paper, by the half-size-per-cell estimate', () => {
    const pages = [...PAGES, ...NASTY.map(s => ['nasty', allFields(s)] as const)]
    for (const [, spec] of pages) {
      for (const width of sweep) {
        const r = journalSvg({ ...spec, width })
        const svg = parse(r.source)
        const paper = paperBox(svg)
        for (const el of all(svg, 'text')) {
          const box = textBox(el)
          expect(finite(box)).toBe(true)
          expect(box.x0).toBeGreaterThanOrEqual(paper.x0 + 8)
          expect(box.x1).toBeLessThanOrEqual(paper.x1 - 8)
          expect(box.y0).toBeGreaterThanOrEqual(paper.y0)
          expect(box.y1).toBeLessThanOrEqual(paper.y1 - 4)
        }
      }
    }
  })

  test('no text runs into another', () => {
    const pages = [...PAGES, ...NASTY.map(s => ['nasty', allFields(s)] as const)]
    for (const [, spec] of pages) {
      for (const width of sweep) {
        const boxes = all(parse(journalSvg({ ...spec, width }).source), 'text').map(el => ({ box: textBox(el), s: said(el) }))
        boxes.forEach((a, i) => {
          for (const b of boxes.slice(i + 1)) {
            if (overlap(a.box, b.box)) throw new Error(`at ${width}: "${a.s}" runs into "${b.s}"`)
          }
        })
      }
    }
  })

  test('shapes stay on the paper, each text in its own note or tag', () => {
    for (const [, spec] of PAGES) {
      for (const width of sweep) {
        const r = journalSvg({ ...spec, width })
        const svg = parse(r.source)
        const paper = paperBox(svg)
        const image = { x0: 0, x1: r.width, y0: 0, y1: r.height }

        // the notes: side by side with a gap, the same size, text inside its own
        const notes = group(svg, 'notes')
        if (notes) {
          const sheets = all(notes, 'rect').filter(rect => rect.attrs.fill !== '#E8DFC9').map(rectBox)
          expect(sheets.length).toBe(Math.min(3, spec.notes.length))
          sheets.forEach((sheet, i) => {
            expect(inside(sheet, paper)).toBe(true)
            expect(sheet.x1 - sheet.x0).toBeGreaterThan(70)
            const next = sheets[i + 1]
            if (next) {
              expect(next.x0).toBeGreaterThanOrEqual(sheet.x1 + 4)
              expect(Math.abs(next.x1 - next.x0 - (sheet.x1 - sheet.x0))).toBeLessThan(0.3)
              expect(next.y0).toBe(sheet.y0)
              expect(next.y1).toBe(sheet.y1)
            }
          })
          for (const el of all(notes, 'text')) {
            const box = textBox(el)
            expect(sheets.filter(sheet => inside(box, { x0: sheet.x0 + 4, x1: sheet.x1 - 4, y0: sheet.y0, y1: sheet.y1 - 2 }))).toHaveLength(1)
          }
          // the head ends above the notes
          for (const el of all(group(svg, 'head') ?? svg, 'text')) expect(textBox(el).y1).toBeLessThan(sheets[0]?.y0 ?? 0)
          for (const c of all(group(svg, 'head') ?? svg, 'circle')) expect(n(c, 'cy') + n(c, 'r')).toBeLessThan(sheets[0]?.y0 ?? 0)
        }

        // the seal: on the paper, its words inside the ring, clear of the title
        for (const c of all(svg, 'circle').filter(e => e.attrs.stroke === '#D85A30')) {
          const ring = { x0: n(c, 'cx') - n(c, 'r'), x1: n(c, 'cx') + n(c, 'r'), y0: n(c, 'cy') - n(c, 'r'), y1: n(c, 'cy') + n(c, 'r') }
          expect(inside(ring, paper)).toBe(true)
          const words = all(group(svg, 'head') ?? svg, 'text')
          for (const el of words) {
            const box = textBox(el)
            if (el.attrs['text-anchor'] === 'middle') expect(inside(box, ring)).toBe(true)
            else expect(box.x1).toBeLessThan(ring.x0)
          }
        }

        // the stamps: each tag on the paper, none on another, its text inside
        const stamps = group(svg, 'stamps')
        if (stamps) {
          const tags = all(stamps, 'rect').map(rectBox)
          const words = all(stamps, 'text').map(textBox)
          expect(words).toHaveLength(tags.length)
          tags.forEach((tag, i) => {
            expect(inside(tag, { x0: paper.x0 + 8, x1: paper.x1 - 8, y0: paper.y0, y1: paper.y1 - 8 })).toBe(true)
            for (const other of tags.slice(i + 1)) expect(overlap(tag, other)).toBe(false)
            const word = words[i]
            expect(word !== undefined && inside(word, { x0: tag.x0 + 4, x1: tag.x1 - 4, y0: tag.y0, y1: tag.y1 })).toBe(true)
          })
          // the chart ends above the tags
          const rows = chartRows(svg)
          const last = rows[rows.length - 1]
          if (last) expect(Math.min(...tags.map(tag => tag.y0))).toBeGreaterThan(last.bottom + 4)
        }

        // everything that is not turned tape is inside the image
        for (const rect of all(svg, 'rect')) {
          if (rect.attrs.transform === undefined && rect.attrs.x !== undefined && !all(group(svg, 'tape') ?? svg, 'rect').includes(rect)) {
            expect(inside(rectBox(rect), image)).toBe(true)
          }
        }
        for (const row of chartRows(svg)) {
          expect(row.x).toBeGreaterThanOrEqual(paper.x0 + 8)
          expect(row.top).toBeGreaterThan(paper.y0)
          expect(row.bottom).toBeLessThan(paper.y1 - 8)
        }
      }
    }
  })

  test('four long stamps wrap to more rows instead of leaving the paper', () => {
    const tops = (width: number) => new Set(all(group(parse(journalSvg({ ...LONG, width }).source), 'stamps') ?? { name: 'g', attrs: {}, kids: [] }, 'rect').map(rect => rect.attrs.y))
    expect(tops(320).size).toBeGreaterThan(1)
    expect(tops(680).size).toBeGreaterThan(1)
    // three that fit whole in two rows keep their text
    const three = [{ text: 'MEMORY.md 已对齐' }, { text: '3 条没链接' }, { text: '回收站 2' }]
    const kept = all(group(parse(journalSvg({ ...BASE, stamps: three, width: 320 }).source), 'stamps') ?? { name: 'g', attrs: {}, kids: [] }, 'text').map(said)
    expect(kept).toEqual(three.map(s => s.text))
    const short = journalSvg({ ...BASE, stamps: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }], width: 320 })
    expect(new Set(all(group(parse(short.source), 'stamps') ?? { name: 'g', attrs: {}, kids: [] }, 'rect').map(rect => rect.attrs.y)).size).toBe(1)
  })

  test('a note shrinks its big text before it cuts it, and wraps a long label onto a second line', () => {
    const size = (spec: JournalSpec, text: string) => {
      const el = all(parse(journalSvg(spec).source), 'text').find(e => said(e) === text)
      return el ? n(el, 'font-size') : NaN
    }
    expect(size({ ...BASE, width: 460 }, '24')).toBe(24)
    expect(size({ ...BASE, width: 460 }, '9.8k')).toBe(24)
    expect(size({ ...BASE, width: 460 }, '2 关 · 1 改')).toBeLessThan(24)
    expect(size({ ...BASE, width: 460 }, '2 关 · 1 改')).toBeGreaterThanOrEqual(14)
    expect(size({ ...BASE, width: 320 }, '2 关 · 1 改')).toBeGreaterThanOrEqual(11)
    expect(size({ ...BASE, width: 680 }, '24')).toBeGreaterThan(24)
    for (const width of WIDTHS) {
      const notes = group(parse(journalSvg({ ...LONG, width }).source), 'notes')
      const texts = notes ? all(notes, 'text') : []
      // per note: the big text and two lines of label
      expect(texts).toHaveLength(9)
      expect(new Set(texts.map(el => el.attrs.y)).size).toBe(3)
    }
    const wrapped = all(group(parse(journalSvg({ ...BASE, width: 320 }).source), 'notes') ?? { name: 'g', attrs: {}, kids: [] }, 'text').map(said)
    expect(wrapped.join('')).toContain('这个会话的改动')
    expect(wrapped).not.toContain('这个会话的改动')
  })
})

// ---------- alt ----------

describe('journal: alt', () => {
  test('alt says the title, each note and each bar, numbers included', () => {
    for (const width of WIDTHS) {
      const { alt } = journalSvg({ ...BASE, width })
      expect(alt).toBe(
        '手帐插图「Atlas 手帐」（11 月 12 日 · 提示词页）；便签：24 段系统提示词、9.8k tokens 左右、2 关 · 1 改 这个会话的改动；谁最占地方：doing_tasks 2.6k、tools 2.1k、memory 1.3k；标签：已关闭 · 本会话、2 处改动。',
      )
    }
  })

  test('alt is one plain sentence: no markup, no line breaks, the value when a bar has no text', () => {
    const { alt } = journalSvg({ title: 'T\n<i>', subtitle: '', notes: [{ big: '3', label: 'a&b' }], bars: [{ label: 'x', value: 12 }, { label: 'y', value: -1 }] })
    expect(alt).toBe('手帐插图「T <i>」；便签：3 a&b；条形图：x 12、y 0。')
    for (const [, spec] of PAGES) {
      const r = journalSvg(spec)
      expect(r.alt.endsWith('。')).toBe(true)
      expect(r.alt).not.toMatch(/[\r\n\t]/)
      expect(r.alt).not.toMatch(/&(amp|lt|gt|quot|#\d+);/)
      expect(r.alt).toContain(`「${spec.title}`.slice(0, 20))
    }
    expect(journalSvg({ title: '空', subtitle: '', notes: [] }).alt).toBe('手帐插图「空」。')
  })

  test('alt keeps the text the picture had to cut', () => {
    const { alt, source } = journalSvg({ ...LONG, width: 320 })
    expect(alt).toContain(LONG.title)
    expect(all(parse(source), 'text').map(said).join('\n')).not.toContain(LONG.title)
    expect(alt).toContain(LONG.subtitle.slice(0, 60))
    for (const note of LONG.notes) expect(alt).toContain(`${note.big} ${note.label}`)
    expect(alt).toContain('零 0')
    expect(alt).toContain('混合 mixed 标签 label 混合 mixed 2.25')
  })
})
