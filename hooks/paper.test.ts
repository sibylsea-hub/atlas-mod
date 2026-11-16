import { describe, expect, test } from 'claude-code/testing'

import { serifWidth } from './folio'
import { paperBand, paperHeading, paperWidth } from './paper'
import { displayWidth } from './riviera'

/** Every tag opened is closed, in order; self-closing ones count as both. */
function balanced(svg: string): boolean {
  const stack: string[] = []
  for (const m of svg.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>/g)) {
    const [, close, name, , self] = m
    if (self === '/') continue
    if (close === '/') {
      if (stack.pop() !== name) return false
    } else stack.push(name ?? '')
  }
  return stack.length === 0
}

describe('paper', () => {
  test('a band is one small well-formed picture of the width asked, clamped', () => {
    const band = paperBand(548, 0)
    expect(band.width).toBe(548)
    expect(band.source.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="548" height="${band.height}" viewBox="0 0 548 ${band.height}"`)).toBe(true)
    expect(balanced(band.source)).toBe(true)
    expect(band.source.length).toBeLessThan(1500)
    // a band says what it is: a surface leaves out a picture with nothing to say
    for (let i = 0; i < 6; i++) expect(paperBand(548, i).alt.length, `band ${i}`).toBeGreaterThan(0)
    expect(paperWidth(10)).toBe(240)
    expect(paperWidth(5000)).toBe(900)
    expect(paperWidth(Number.NaN)).toBe(460)
    expect(paperBand(Number.NaN, Number.NaN).width).toBe(460)
  })

  test('every third band carries a strip of tape, and a page draws the same each time', () => {
    const taped = [0, 1, 2, 3, 4, 5, 6].map(i => paperBand(548, i).source.includes('<g transform="rotate('))
    expect(taped).toEqual([true, false, false, true, false, false, true])
    expect(paperBand(548, 3).source).toBe(paperBand(548, 3).source)
    // neighbouring tapes differ: colour or print
    expect(paperBand(548, 0).source).not.toBe(paperBand(548, 3).source)
    for (let i = 0; i < 40; i++) {
      const s = paperBand(320, i).source
      expect(s, `band ${i}`).not.toMatch(/NaN|Infinity|undefined/)
      for (const m of s.matchAll(/<rect x="(-?\d+)"[^>]* width="(\d+)"/g)) {
        expect(Number(m[1]), `band ${i} tape left`).toBeGreaterThanOrEqual(0)
        expect(Number(m[1]) + Number(m[2]), `band ${i} tape right`).toBeLessThanOrEqual(320)
      }
    }
  })

  test('a heading writes its words escaped, cut to the width, and says them as its alt', () => {
    const head = paperHeading(548, '会话 · <b>&"\'', 0)
    expect(balanced(head.source)).toBe(true)
    expect(head.alt).toBe('会话 · <b>&"\'')
    expect(head.source).toContain('会话 · &lt;b&gt;&amp;&quot;&#39;')
    expect(head.source).not.toContain('<b>')
    const long = paperHeading(320, '很长很长的标题'.repeat(20), 1)
    expect(long.source).toContain('…')
    expect(long.source.length).toBeLessThan(2500)
    expect(paperHeading(548, 'x', 0).source).not.toMatch(/<script|foreignObject|href=|on[a-z]+=/)
    expect(Number(/font-size="(\d+)"/.exec(head.source)?.[1])).toBeGreaterThanOrEqual(11)
  })
})

describe('paper: the folio hand', () => {
  /** Every hairline of a piece as [from, to, y]. */
  const rules = (svg: string) => [...svg.matchAll(/<path d="M(-?[\d.]+) (-?[\d.]+) H(-?[\d.]+)"/g)].map(m => [Number(m[1]), Number(m[3]), Number(m[2])] as const)

  test('a band is ivory paper: every third carries a rule with an ornament, the others three lozenges', () => {
    const ruled = [0, 1, 2, 3, 4, 5, 6].map(i => paperBand(548, i, 'folio').alt.includes('花饰'))
    expect(ruled).toEqual([true, false, false, true, false, false, true])
    for (const w of [10, 320, 548, 5000]) {
      for (let i = 0; i < 12; i++) {
        const band = paperBand(w, i, 'folio')
        expect(balanced(band.source), `band ${w}/${i}`).toBe(true)
        expect(band.alt.length, `band ${w}/${i}`).toBeGreaterThan(0)
        expect(band.source, `band ${w}/${i}`).not.toMatch(/NaN|Infinity|undefined|<pattern|rotate\(/)
        expect(band.source.length, `band ${w}/${i}`).toBeLessThan(1500)
        for (const [from, to] of rules(band.source)) {
          expect(from, `band ${w}/${i} rule`).toBeGreaterThanOrEqual(0)
          expect(to, `band ${w}/${i} rule`).toBeGreaterThan(from)
          expect(to, `band ${w}/${i} rule`).toBeLessThanOrEqual(band.width)
        }
      }
    }
    expect(paperBand(548, 3, 'folio').source).toBe(paperBand(548, 3, 'folio').source)
    expect(paperBand(Number.NaN, Number.NaN, 'folio').width).toBe(460)
  })

  test('the hand asked for is the one drawn; none asked is washi, as before a skin named one', () => {
    expect(paperBand(548, 0)).toEqual(paperBand(548, 0, 'washi'))
    expect(paperHeading(548, '会话', 2)).toEqual(paperHeading(548, '会话', 2, 'washi'))
    expect(paperBand(548, 0, 'folio').source).not.toBe(paperBand(548, 0).source)
    expect(paperHeading(548, '会话', 2, 'folio').source).not.toBe(paperHeading(548, '会话', 2).source)
  })

  test('a heading is numbered on a tab, written escaped and cut to the width, its rule clear of the words', () => {
    const head = paperHeading(548, '会话 · <b>&"\'', 0, 'folio')
    expect(balanced(head.source)).toBe(true)
    expect(head.alt).toBe('会话 · <b>&"\'')
    expect(head.source).toContain('会话 · &lt;b&gt;&amp;&quot;&#39;')
    expect(head.source).not.toContain('<b>')
    expect(head.source).toContain('>01</text>')
    expect(paperHeading(548, 'x', 11, 'folio').source).toContain('>12</text>')
    expect(paperHeading(548, 'x', Number.NaN, 'folio').source).toContain('>01</text>')
    const long = paperHeading(320, '很长很长的标题'.repeat(20), 1, 'folio')
    expect(long.source).toContain('…')
    expect(long.source.length).toBeLessThan(2500)
    for (const w of [240, 320, 460, 548, 900]) {
      for (const text of ['会话', 'Hooks', 'MMMMWWWW@@@@', '系统提示词的段', '很长很长的标题'.repeat(20), 'a long heading in Latin letters '.repeat(6)]) {
        const pic = paperHeading(w, text, 3, 'folio')
        expect(pic.source, `${w}/${text.slice(0, 8)}`).not.toMatch(/NaN|Infinity|undefined|<script|foreignObject|href=|on[a-z]+=/)
        const words = /<text x="([\d.]+)" y="31" font-size="(\d+)"[^>]*>([^<]*)<\/text>/.exec(pic.source)
        expect(words, `${w}/${text.slice(0, 8)}`).not.toBeNull()
        const [from, size] = [Number(words?.[1]), Number(words?.[2])]
        // by the serif's own measure the words end inside the picture
        const said = (words?.[3] ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
        const run = serifWidth(said, size)
        expect(from + run, `${w}/${text.slice(0, 8)} words end`).toBeLessThanOrEqual(pic.width)
        for (const [ruleFrom, ruleTo] of rules(pic.source)) {
          expect(ruleFrom, `${w}/${text.slice(0, 8)} rule clear of the words`).toBeGreaterThanOrEqual(from + run)
          expect(ruleTo, `${w}/${text.slice(0, 8)} rule inside`).toBeLessThanOrEqual(pic.width)
        }
        for (const m of pic.source.matchAll(/font-size="(\d+)"/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(11)
      }
    }
  })
})

describe('paper: the riviera hand', () => {
  const rules = (svg: string) => [...svg.matchAll(/<path d="M(-?[\d.]+) (-?[\d.]+) H(-?[\d.]+)"/g)].map(m => [Number(m[1]), Number(m[3])] as const)

  test('a band is white paper under a hairline; every third carries tiles or waves by turns', () => {
    const kinds = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => paperBand(548, i, 'riviera').alt)
    expect(kinds.map(a => (a.includes('瓷砖') ? 'tiles' : a.includes('波浪') ? 'waves' : 'rule'))).toEqual(['tiles', 'rule', 'rule', 'waves', 'rule', 'rule', 'tiles', 'rule', 'rule', 'waves'])
    for (const w of [10, 320, 548, 5000]) {
      for (let i = 0; i < 12; i++) {
        const band = paperBand(w, i, 'riviera')
        expect(balanced(band.source), `band ${w}/${i}`).toBe(true)
        expect(band.alt.length, `band ${w}/${i}`).toBeGreaterThan(0)
        expect(band.source, `band ${w}/${i}`).not.toMatch(/NaN|Infinity|undefined|<pattern|rotate\(/)
        expect(band.source.length, `band ${w}/${i}`).toBeLessThan(3000)
        for (const [from, to] of rules(band.source)) {
          expect(from, `band ${w}/${i} rule`).toBeGreaterThanOrEqual(0)
          expect(to, `band ${w}/${i} rule`).toBeGreaterThan(from)
          expect(to, `band ${w}/${i} rule`).toBeLessThanOrEqual(band.width)
        }
        // every tile stands inside the picture
        for (const m of band.source.matchAll(/<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)) {
          expect(Number(m[1]), `band ${w}/${i} tile left`).toBeGreaterThanOrEqual(0)
          expect(Number(m[1]) + Number(m[3]), `band ${w}/${i} tile right`).toBeLessThanOrEqual(band.width)
          expect(Number(m[2]) + Number(m[4]), `band ${w}/${i} tile foot`).toBeLessThanOrEqual(band.height)
        }
      }
    }
    expect(paperBand(548, 3, 'riviera').source).toBe(paperBand(548, 3, 'riviera').source)
    expect(paperBand(548, 0, 'riviera').source).not.toBe(paperBand(548, 0, 'folio').source)
  })

  test('a heading stands under a thick and a thin rule, after its number in italics, escaped and cut to the width', () => {
    const head = paperHeading(548, '会话 · <b>&"\'', 0, 'riviera')
    expect(balanced(head.source)).toBe(true)
    expect(head.alt).toBe('会话 · <b>&"\'')
    expect(head.source).toContain('会话 · &lt;b&gt;&amp;&quot;&#39;')
    expect(head.source).not.toContain('<b>')
    expect(head.source).toMatch(/font-style="italic"[^>]*>01<\/text>/)
    expect(paperHeading(548, 'x', 11, 'riviera').source).toContain('>12</text>')
    // the thick rule spans the picture
    expect(head.source).toContain('<rect x="0" y="6" width="548" height="3"')
    for (const w of [240, 320, 460, 548, 900]) {
      for (const text of ['会话', 'Hooks', 'MMMMWWWW@@@@', '系统提示词的段', '很长很长的标题'.repeat(20), 'a long heading in Latin letters '.repeat(6)]) {
        const pic = paperHeading(w, text, 3, 'riviera')
        expect(pic.source, `${w}/${text.slice(0, 8)}`).not.toMatch(/NaN|Infinity|undefined|<script|foreignObject|href=|on[a-z]+=/)
        expect(pic.source.length).toBeLessThan(2500)
        const words = /<text x="([\d.]+)" y="43" font-size="(\d+)"[^>]*>([^<]*)<\/text>/.exec(pic.source)
        expect(words, `${w}/${text.slice(0, 8)}`).not.toBeNull()
        const said = (words?.[3] ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
        const end = Number(words?.[1]) + displayWidth(said, Number(words?.[2]))
        expect(end, `${w}/${text.slice(0, 8)} words end`).toBeLessThanOrEqual(pic.width)
        // the sun, when drawn, is clear of the words
        const sun = /<circle cx="([\d.]+)" cy="36" r="([\d.]+)"/.exec(pic.source)
        if (sun) expect(Number(sun[1]) - Number(sun[2]), `${w}/${text.slice(0, 8)} sun`).toBeGreaterThan(end)
        for (const m of pic.source.matchAll(/font-size="(\d+)"/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(11)
      }
    }
  })
})

describe('paper: the porto hand', () => {
  /** Every number that is an x in the piece's rects and path starts. */
  const lefts = (svg: string) => [...svg.matchAll(/<rect x="(-?[\d.]+)"[^>]* width="([\d.]+)"/g)].map(m => [Number(m[1]), Number(m[1]) + Number(m[2])] as const)

  test('a band is cream paper with a line of sea; every third carries a row of houses or a boat by turns', () => {
    const kinds = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => paperBand(548, i, 'porto').alt)
    expect(kinds.map(a => (a.includes('小房子') ? 'town' : a.includes('帆船') ? 'boat' : 'sea'))).toEqual(['town', 'sea', 'sea', 'boat', 'sea', 'sea', 'town', 'sea', 'sea', 'boat'])
    for (const w of [10, 240, 320, 548, 5000]) {
      for (let i = 0; i < 12; i++) {
        const band = paperBand(w, i, 'porto')
        expect(balanced(band.source), `band ${w}/${i}`).toBe(true)
        expect(band.alt.length, `band ${w}/${i}`).toBeGreaterThan(0)
        expect(band.source, `band ${w}/${i}`).not.toMatch(/NaN|Infinity|undefined|<pattern|rotate\(/)
        expect(band.source.length, `band ${w}/${i}`).toBeLessThan(9000)
        // every house and the quay stand inside the picture
        for (const [left, right] of lefts(band.source)) {
          expect(left, `band ${w}/${i} left`).toBeGreaterThanOrEqual(0)
          expect(right, `band ${w}/${i} right`).toBeLessThanOrEqual(band.width)
        }
      }
    }
    // a row of houses is several houses, not all of one colour
    const walls = new Set([...paperBand(548, 0, 'porto').source.matchAll(/fill="(#[0-9A-F]{6})"/g)].map(m => m[1]))
    expect(walls.size).toBeGreaterThan(6)
    expect(paperBand(548, 3, 'porto').source).toBe(paperBand(548, 3, 'porto').source)
    // two rows of houses on a page are not twins
    expect(paperBand(548, 0, 'porto').source).not.toBe(paperBand(548, 6, 'porto').source)
  })

  test('a heading stands beside a house, the sea under both; escaped, cut to the width, the boat clear of the words', () => {
    const head = paperHeading(548, '会话 · <b>&"\'', 0, 'porto')
    expect(balanced(head.source)).toBe(true)
    expect(head.alt).toBe('会话 · <b>&"\'')
    expect(head.source).toContain('会话 · &lt;b&gt;&amp;&quot;&#39;')
    expect(head.source).not.toContain('<b>')
    // each heading down a page gets the next house
    expect(paperHeading(548, 'x', 0, 'porto').source).not.toBe(paperHeading(548, 'x', 1, 'porto').source)
    for (const w of [240, 320, 460, 548, 900]) {
      for (const text of ['会话', 'Hooks', 'MMMMWWWW@@@@', '系统提示词的段', '很长很长的标题'.repeat(20), 'a long heading in Latin letters '.repeat(6)]) {
        const pic = paperHeading(w, text, 3, 'porto')
        expect(pic.source, `${w}/${text.slice(0, 8)}`).not.toMatch(/NaN|Infinity|undefined|<script|foreignObject|href=|on[a-z]+=/)
        expect(pic.source.length).toBeLessThan(4000)
        const words = /<text x="([\d.]+)" y="42" font-size="(\d+)"[^>]*>([^<]*)<\/text>/.exec(pic.source)
        expect(words, `${w}/${text.slice(0, 8)}`).not.toBeNull()
        const said = (words?.[3] ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
        const end = Number(words?.[1]) + displayWidth(said, Number(words?.[2]))
        expect(end, `${w}/${text.slice(0, 8)} words end`).toBeLessThanOrEqual(pic.width)
        // the boat's hull, when a boat is drawn, lies beyond the words
        const hull = /<path d="M([\d.]+) [\d.]+ H[\d.]+ L[\d.]+ [\d.]+ H[\d.]+ Z"/.exec(pic.source)
        if (hull) expect(Number(hull[1]), `${w}/${text.slice(0, 8)} boat`).toBeGreaterThan(end)
        for (const m of pic.source.matchAll(/font-size="(\d+)"/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(11)
      }
    }
  })
})
