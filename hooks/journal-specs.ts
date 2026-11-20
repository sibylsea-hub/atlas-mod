// atlas: what each page's 手帐 illustration says. Pure: the numbers come from
// the index and from what the module holds; journal.ts draws them.

import type { AtlasTab } from '../types'
import type { JournalBar, JournalSpec } from './journal'
import { approxTokens, heldM, sectionRows, sessionEdits, toolRows } from './manage'
import { fmtMD, fmtSize } from './text'
import type { R } from './views'

const PAGE: Record<AtlasTab, string> = {
  memory: '记忆页',
  sessions: '会话页',
  skills: 'Skills 页',
  prompt: '提示词页',
  tools: '工具页',
  hooks: 'Hooks 页',
  structure: '结构页',
  health: '体检页',
  trash: '回收站',
}

/** 950 → `950`, 9800 → `9.8k`, 13008 → `13k`. */
export function kilo(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`
  return String(Math.round(n))
}

function top<T>(list: readonly T[], value: (x: T) => number, n = 5): T[] {
  return [...list]
    .filter(x => value(x) > 0)
    .sort((a, b) => value(b) - value(a))
    .slice(0, n)
}

type Data = Pick<R, 'idx' | 'view' | 'sw' | 'trash' | 'tz' | 'cols'>

/** The illustration for the page a draw shows, under the title the skin's paper gives it; null for a page that has none. */
export function journalSpec(r: Data, nowMs: number, title = 'Atlas 手帐'): JournalSpec | null {
  const [month, day] = fmtMD(nowMs, r.tz).split('-')
  const base = {
    title,
    subtitle: `${Number(month)} 月 ${Number(day)} 日 · ${PAGE[r.view.tab]}`,
    // a pane's column is a little over 8px wide on the desktop; the surface scales a wider picture down to its slot
    width: Math.max(320, Math.min(680, Math.round(r.cols * 9))),
  }
  switch (r.view.tab) {
    case 'memory': {
      const withMemory = r.idx.projects.filter(p => p.memoryFiles.length > 0)
      const files = withMemory.reduce((n, p) => n + p.memoryFiles.length, 0)
      const bars: JournalBar[] = top(withMemory, p => p.memoryFiles.length).map(p => ({ label: p.label, value: p.memoryFiles.length, text: `${p.memoryFiles.length} 个` }))
      return {
        ...base,
        notes: [
          { big: String(withMemory.length), label: '个项目有记忆', tone: 'yellow' },
          { big: String(files), label: '个记忆文件', tone: 'pink' },
          { big: String(r.idx.health.length), label: '条体检提醒', tone: 'mint' },
        ],
        barsTitle: '谁的记忆最多',
        bars,
      }
    }
    case 'sessions': {
      const perProject = new Map<string, number>()
      let latest = 0
      for (const s of r.idx.sessions) {
        perProject.set(s.projectSlug, (perProject.get(s.projectSlug) ?? 0) + 1)
        if (s.lastMs > latest) latest = s.lastMs
      }
      const label = (slug: string) => r.idx.projects.find(p => p.slug === slug)?.label ?? slug
      const bars: JournalBar[] = top([...perProject], ([, n]) => n).map(([slug, n]) => ({ label: label(slug), value: n, text: `${n} 个` }))
      return {
        ...base,
        notes: [
          { big: String(r.idx.sessions.length), label: '个会话', tone: 'blue' },
          { big: String(perProject.size), label: '个项目里', tone: 'yellow' },
          { big: fmtMD(latest, r.tz), label: '最近一次', tone: 'pink' },
        ],
        barsTitle: '会话都开在哪',
        bars,
      }
    }
    case 'skills': {
      const skills = r.idx.skills
      const bars: JournalBar[] = top(skills, s => s.useCount).map(s => ({ label: s.name, value: s.useCount, text: `${s.useCount} 次` }))
      return {
        ...base,
        notes: [
          { big: String(skills.length), label: '个 skill', tone: 'mint' },
          { big: String(r.sw.skillsOff.length), label: '个这会话关着', tone: 'pink' },
          { big: String(skills.filter(s => !s.useCount).length), label: '个从没用过', tone: 'yellow' },
        ],
        barsTitle: '最常用的',
        bars,
      }
    }
    case 'prompt': {
      if (!heldM.composed) return { ...base, notes: [{ big: '?', label: '点「重新读取」', tone: 'yellow' }] }
      const edits = sessionEdits(r.sw)
      const rows = sectionRows(heldM.composed, heldM.original, edits)
      const own = edits.extra.filter(x => !x.off && x.text.trim())
      const tokens = rows.reduce((n, x) => n + (x.sent ? approxTokens(x.sent) : 0), 0) + own.reduce((n, x) => n + approxTokens(x.text), 0)
      const sized = [...rows.map(x => ({ label: x.id, tokens: x.sent ? approxTokens(x.sent) : 0 })), ...own.map(x => ({ label: x.name, tokens: approxTokens(x.text) }))]
      const bars: JournalBar[] = top(sized, x => x.tokens).map(x => ({ label: x.label, value: x.tokens, text: kilo(x.tokens) }))
      const injected = [...heldM.injects.values()].reduce((n, x) => n + x.chars, 0)
      const outside = (heldM.outside?.pieces ?? []).reduce((n, p) => n + approxTokens(p.text), 0)
      return {
        ...base,
        notes: [
          { big: String(rows.length + edits.extra.length), label: '段系统提示词', tone: 'yellow' },
          { big: kilo(tokens), label: 'tokens 左右', tone: 'pink' },
          { big: `${rows.filter(x => x.state === 'off').length} 关 · ${rows.filter(x => x.state === 'rewritten').length} 改`, label: '这个会话的改动', tone: 'mint' },
        ],
        barsTitle: '谁最占地方',
        bars,
        stamps: [
          ...(injected > 0 ? [{ text: `对话里另有注入 约 ${kilo(Math.ceil(injected / 3))} tokens`, tone: 'teal' as const }] : []),
          ...(outside > 0 ? [{ text: `段之外另有 约 ${kilo(outside)} tokens`, tone: 'purple' as const }] : []),
        ],
      }
    }
    case 'tools': {
      // as this session has them: its own edits over where the engine puts each tool
      const rows = toolRows(heldM.toolList, heldM.tools, sessionEdits(r.sw))
      if (rows.length === 0) return { ...base, notes: [{ big: '?', label: '点「重新读取」', tone: 'yellow' }] }
      const carried = rows.filter(x => x.where === 'carried')
      const sized = carried.map(x => ({ label: x.short, tokens: x.sent === null ? 0 : approxTokens(x.sent) }))
      const changed = rows.filter(x => x.place !== undefined || x.rewrite !== undefined).length
      const off = rows.filter(x => x.where === 'off').length
      // nothing described yet (a reload, or no message sent): the count is known, no size is
      if (heldM.tools.size === 0) {
        return {
          ...base,
          notes: [
            { big: String(rows.length), label: '个工具', tone: 'blue' },
            { big: '?', label: '发条消息才知道大小', tone: 'yellow' },
            { big: String(changed), label: '个你改过', tone: 'mint' },
          ],
        }
      }
      const bars: JournalBar[] = top(sized, x => x.tokens).map(x => ({ label: x.label, value: x.tokens, text: kilo(x.tokens) }))
      return {
        ...base,
        notes: [
          { big: String(carried.length), label: '个工具每次都带着', tone: 'blue' },
          { big: kilo(sized.reduce((n, x) => n + x.tokens, 0)), label: 'tokens 左右的说明', tone: 'pink' },
          { big: String(changed), label: '个你改过', tone: 'mint' },
        ],
        barsTitle: '谁的说明最长',
        bars,
        stamps: off > 0 ? [{ text: `${off} 个工具关着`, tone: 'coral' }] : [],
      }
    }
    case 'hooks': {
      const scan = heldM.hooks
      if (!scan) return { ...base, notes: [{ big: '?', label: '点「重新读取」', tone: 'yellow' }] }
      const fired = [...heldM.fires].map(([event, f]) => ({ event, count: f.count }))
      const bars: JournalBar[] = top(fired, f => f.count).map(f => ({ label: f.event, value: f.count, text: `${f.count} 次` }))
      return {
        ...base,
        notes: [
          { big: String(scan.rows.filter(x => x.isOn).length), label: '个 hook 开着', tone: 'mint' },
          { big: String(scan.rows.filter(x => !x.isOn).length), label: '个关着', tone: 'pink' },
          { big: String(fired.reduce((n, f) => n + f.count, 0)), label: '次事件（本会话）', tone: 'yellow' },
        ],
        barsTitle: '这个会话里哪个事件最忙',
        bars,
      }
    }
    case 'health': {
      const count = (severity: string) => r.idx.health.filter(i => i.severity === severity).length
      return {
        ...base,
        notes: [
          { big: String(count('error')), label: '个错误', tone: 'pink' },
          { big: String(count('warn')), label: '个警告', tone: 'yellow' },
          { big: String(count('info')), label: '个提示', tone: 'mint' },
        ],
      }
    }
    case 'trash':
      return {
        ...base,
        notes: [
          { big: String(r.trash.items.length), label: '样东西在回收站', tone: 'purple' },
          { big: fmtSize(r.trash.bytes), label: '占的空间', tone: 'blue' },
        ],
      }
    case 'structure':
      return null
  }
}
