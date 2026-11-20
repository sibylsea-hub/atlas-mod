// atlas: what the pane draws. Each view is a function of the state read
// once per draw; handlers write through core's functions, never while drawing.

import type { ButtonProps, Elements, RenderElement, RenderSurface } from 'claude-code'

import type {
  AtlasCtx,
  AtlasExtra,
  AtlasFile,
  AtlasFmDraft,
  AtlasLoaded,
  AtlasManage,
  AtlasMemoryState,
  AtlasMerge,
  AtlasOp,
  AtlasPrefs,
  AtlasPromptExtra,
  AtlasRoute,
  AtlasScan,
  AtlasScope,
  AtlasSearch,
  AtlasSwitches,
  AtlasTrash,
  AtlasView,
} from '../types'
import { boardHeight } from './board'
import { folioSvg } from './folio'
import { journalSvg } from './journal'
import type { JournalSpec } from './journal'
import { rivieraSvg } from './riviera'
import { journalSpec, kilo } from './journal-specs'
import { portoSvg } from './porto'
import { paperBand, paperHeading } from './paper'
import type { AtlasIndex, DocNode, Io, IoDir, Issue, MemoryFile, Project, Session, Skill, SkillSource } from './data'
import {
  EXTRA_PREFIX,
  HOOK_EVENTS,
  LEVELS,
  LEVEL_NAME,
  SOURCE_NAME,
  TOOL_SEARCH,
  approxTokens,
  editsIn,
  firesText,
  heldM,
  injectCaution,
  injectLevelsText,
  injectName,
  injectOffOf,
  levelEdits,
  outsideName,
  levelState,
  levelsText,
  levelsWhere,
  renameLevelsText,
  renameOf,
  renameUser,
  scriptPath,
  sectionName,
  sectionRows,
  settingsFiles,
  toolLevelState,
  toolMarks,
  toolNamesIn,
  toolOrigin,
  toolPlaceOf,
  toolRewriteOf,
  toolRow,
  toolRows,
} from './manage'
import type { HookPatch, HookRow, SectionRow, ToolMark, ToolPlace, ToolRow, ToolWhere } from './manage'
import * as core from './model'
import { SKINS, skinOf } from './skins'
import type { ButtonKind, ChipTone, PaperStyle, Skin } from './skins'
import { EDGE_TAG, IO_CLASS, NEVER, TRASH_DAYS, crossSvg, docMaps, held, isProjectKey, keepLabel, keepNote, keepShort, renameNote, scopeLabel, treeRoots } from './model'
import {
  basename,
  cellWidth,
  dirname,
  deleteLine,
  fit,
  fmtHM,
  fmtMD,
  fmtMDHM,
  fmtSize,
  insertLineAfter,
  isInside,
  parseFrontmatter,
  readableMarkdown,
  replaceLine,
  setFrontmatterField,
  shortPath,
  splitLines,
} from './text'

type UI = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button' | 'Input' | 'Select' | 'Code' | 'Markdown' | 'Client'> & {
  /** The desktop draws pictures; the terminal has no such element. */
  Svg?: Elements['desktop']['Svg']
}

/** What a press asks for; each closure is made by the render hook over its own `$`. */
export type Actions = {
  scan: () => void
  tab: (tab: AtlasView['tab']) => void
  push: (route: AtlasRoute) => void
  back: () => void
  view: (change: (v: AtlasView) => AtlasView) => void
  search: (query: string) => void
  memState: (groupId: string, state: AtlasMemoryState) => void
  skillState: (name: string, off: boolean) => void
  editor: (path: string) => void
  reveal: (path: string) => void
  copy: (text: string, surface: RenderSurface) => void
  undoFile: (path: string) => void
  reloadFile: () => void
  fileMode: (mode: 'read' | 'edit') => void
  fileAnchor: (line: number) => void
  save: (path: string, change: (text: string) => string, focusAfter?: string) => void
  startFmDraft: () => void
  fmDraft: (patch: Partial<AtlasFmDraft>) => void
  writeFm: () => void
  newFile: (path: string) => void
  applyMerge: () => void
  dropMerge: () => void
  undoOp: () => void
  fixOrphan: (issue: Issue) => void
  fixDeadLink: (issue: Issue) => void
  fixNoIndex: (issue: Issue) => void
  fixFrontmatter: (path: string, from: string) => void
  openAt: (path: string, line: number, from: string) => void
  sameTitle: (issue: Issue) => void
  openDir: (dir: string) => void
  trash: (paths: string[], label: string, kind?: string) => void
  restore: (ids: string[]) => void
  purgeNow: (id: string) => void
  setExpiry: (id: string, days: string) => void
  /** Empties the whole trash now, whatever each item's expiry says. */
  purgeAll: () => void
  /** This machine's keep period for what is deleted from now on: days, or `never`. */
  trashDefault: (days: string) => void
  archiveMemory: (path: string, label: string) => void
  setArchived: (kind: 'sessions' | 'projects', id: string, on: boolean) => void
  loadTrash: () => void
  pending: (key: string | null) => void
  promptLoad: () => void
  /** Each of these writes at the level the page's 改的是 names. */
  promptOff: (id: string, off: boolean) => void
  promptRewrite: (id: string, text: string | null) => void
  promptExtraNew: (name: string) => void
  promptExtra: (extra: AtlasPromptExtra) => void
  promptExtraDrop: (id: string) => void
  promptNow: (on: boolean) => void
  /** Leaves one kind of injected message out, or lets it back in, at the level 改的是 names. */
  injectOff: (type: string, off: boolean) => void
  /** Names who "the user" is, at the level 改的是 names; '' takes the name back. */
  promptRename: (name: string) => void
  /** Asks the engine for its tools again, and to describe each one again from the next turn. */
  toolsLoad: () => void
  /** Puts a tool where `place` says, at the level 改的是 names; null leaves it to the engine again. */
  toolPlace: (name: string, place: ToolPlace | null) => void
  /** Sends `text` in place of a tool's own description, at the level 改的是 names; null takes the rewrite back. */
  toolRewrite: (name: string, text: string | null) => void
  /** Puts a skin in force, for every session on this machine. */
  skin: (id: string) => void
  hooksLoad: () => void
  hooksUndo: () => void
  hookToggle: (id: string) => void
  hookSave: (id: string, patch: HookPatch) => void
  hookDelete: (id: string) => void
  hookDraft: () => void
  hookAdd: () => void
}

/** The state one draw reads, and the closures its presses call. */
export type Snap = {
  surface: RenderSurface
  scan: AtlasScan
  view: AtlasView
  search: AtlasSearch
  file: AtlasFile
  ctx: AtlasCtx
  sw: AtlasSwitches
  prefs: AtlasPrefs
  loaded: AtlasLoaded
  merge: AtlasMerge
  op: AtlasOp
  extra: AtlasExtra
  trash: AtlasTrash
  manage: AtlasManage
  editorModel: string
  /** The keep period a 删除 uses unless the Select says otherwise: this machine's pick on the 回收站 page, else the plugin's option. */
  trashDays: string
  act: Actions
}

export type R = Snap & {
  ui: UI
  cols: number
  rows: number
  idx: AtlasIndex
  tz: number
  home: string
  /** How many list rows this draw has made: each takes the next colour of the strip. */
  stripe: { n: number }
  /** How many section headings this draw has made: each takes the next tape. */
  heads: { n: number }
  /** The look in force: every colour and make the desktop draws comes from it. */
  skin: Skin
}

export const HONESTY = '开关从下一轮起生效；会话中途改动会让提示缓存重建一次。已经读进对话的内容要 /clear 或压缩后才会消失。'
const UNDO_NOTE = '撤销只存在内存里：重载 mod 或重开会话后就没有了。'
const SEVERITY: Record<string, string> = { error: '错误', warn: '警告', info: '提示' }
const SOURCE_LABEL: Record<SkillSource, string> = {
  user: '个人 user',
  synced: '同步 synced',
  plugin: '插件 plugin',
  project: '项目 project',
  builtin: '内置 builtin',
}
const SOURCE_BADGE: Record<SkillSource, string> = { user: '个人', synced: '同步', plugin: '插件', project: '项目', builtin: '内置' }
const STATE_LABEL: Record<AtlasMemoryState, string> = { mount: '挂载', read: '可读', off: '关闭' }
const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference']

// ---------- small pieces ----------

function sp(r: R, p: string): string {
  return shortPath(p, r.home)
}

/** The pane's width in CSS pixels, near enough: a column is about 9px on the desktop (measured on a screenshot). A picture wider than its slot is scaled down. */
function panePx(r: Pick<R, 'cols'>): number {
  return Math.round(r.cols * 9)
}

/** The desktop draws real type: sizes, weights and wrapped lines. The terminal keeps its one-line cells. */
function isDesk(r: Pick<R, 'surface'>): boolean {
  return r.surface === 'desktop'
}

function title(r: R, key: string, text: string): RenderElement {
  const { Box, Text } = r.ui
  if (isDesk(r)) {
    const Svg = r.ui.Svg
    if (Svg && r.skin.paper) {
      // written on the page's own paper, in the hand the skin names
      const pic = paperHeading(panePx(r), text, r.heads.n++, r.skin.paper)
      return (
        <Box key={`h:${key}`} marginTop="md">
          <Svg key={key} source={pic.source} alt={pic.alt} />
        </Box>
      )
    }
    return (
      <Box key={`h:${key}`} marginTop="md">
        <Text key={key} size="heading" weight="semibold">
          {text}
        </Text>
      </Box>
    )
  }
  return (
    <Text key={key} bold>
      {fit(text, r.cols)}
    </Text>
  )
}

/** A note: one dim line cut to the width in the terminal, a small paragraph that wraps on the desktop. */
function dim(r: R, key: string, text: string): RenderElement {
  const { Text } = r.ui
  if (isDesk(r)) {
    return (
      <Text key={key} size="footnote" dimColor wrap="wrap">
        {text}
      </Text>
    )
  }
  return (
    <Text key={key} dimColor>
      {fit(text, r.cols)}
    </Text>
  )
}

/** A state marked on a row: a coloured label on the desktop, words in the tail in the terminal. */
export type Chip = { text: string; tone: ChipTone }

/** Ink for what stands on the skin's own fills, or the surface's own text colour where the skin names none. */
function ink(r: Pick<R, 'skin'>, soft = false): { color?: string; dimColor?: boolean } {
  const colour = soft ? r.skin.inkSoft : r.skin.ink
  if (colour) return { color: colour }
  return soft ? { dimColor: true } : {}
}

export type { ButtonKind }

/** What a button does, read off how it is offered (one of a set) and what it says. */
export function buttonKind(label: string, isOneOfSet: boolean): ButtonKind {
  if (isOneOfSet) return 'pick'
  // 取消归档 puts a thing back on its list: a switch, though it says 取消
  if (/归档/.test(label)) return 'switch'
  if (/取消|撤销|知道了/.test(label)) return 'back'
  if (/删除|删掉|清空|放弃|^×$/.test(label)) return 'remove'
  if (/打开|显示|复制|读取|载入|扫描|刷新|返回|上一页|下一页|更多|看板里看/.test(label)) return 'look'
  if (/^\+|新建|添加|写入|生成|加入|补 |应用|保存|改写/.test(label)) return 'make'
  if (/关闭|开启|恢复|归档|收起|展开|阅读|编辑/.test(label)) return 'switch'
  return 'look'
}

/**
 * The desktop's Button drawn as a paper label whose make says what it does
 * (ButtonKind). The surface paints its own buttons grey and black and takes
 * no colour for them, so a button here is a plain one (text that presses) on
 * a small rounded box. A plain button, and a primary one (the surface's
 * black, which stays for the chosen one of a set and for a page's main
 * action), are passed as they are; the key, the press and every other prop
 * stay on the real Button, so it is found and pressed as before.
 */
function paperButton(ui: UI, makes: NonNullable<Skin['buttons']>, inkSoft: string | null): UI['Button'] {
  const { Box, Text } = ui
  const Real = ui.Button
  return (props: ButtonProps & { children?: unknown }): RenderElement => {
    if (props.plain || props.variant === 'primary') return Real(props as Parameters<typeof Real>[0])
    const { label, children, key: given, ...rest } = props
    const said = label !== undefined ? label : typeof children === 'string' ? children : ''
    const key = given ?? label ?? 'button'
    const make = makes[buttonKind(said, props.variant === 'secondary')]
    // no padding of the box's own down the page: a bordered box brings a card's worth unless told none
    return (
      <Box key={`pill:${key}`} backgroundColor={make.fill} borderStyle={make.border} borderColor={make.edge} paddingX="xs" paddingY={0}>
        <Real key={key} {...rest} plain>
          <Text weight={make.weight} color={props.dimColor && inkSoft ? inkSoft : make.ink}>
            {said}
          </Text>
        </Real>
      </Box>
    )
  }
}

function chipEls(r: R, key: string, chips: readonly Chip[]): RenderElement[] {
  const { Text } = r.ui
  return chips.map((c, i) => (
    <Text key={`${key}:chip:${i}`} size="caption" weight="medium" color={r.skin.chips[c.tone].fg} backgroundColor={r.skin.chips[c.tone].bg}>
      {` ${c.text} `}
    </Text>
  ))
}

/**
 * One list row. In the terminal: the Button (its label the main text) and a
 * dim tail beside it, on one line. On the desktop: a strip of its own colour
 * under a band of the page's paper, the name and its marks on one line and the
 * small print under them.
 */
function rowButton(
  r: R,
  key: string,
  main: string,
  tail: string,
  onPress: () => void,
  tone?: 'dim' | 'strong',
  chips: readonly Chip[] = [],
): RenderElement {
  const { Box, Button, Text } = r.ui
  if (isDesk(r)) {
    const n = r.stripe.n++
    const strip = r.skin.rows.length ? r.skin.rows[n % r.skin.rows.length] : undefined
    const filled = strip ? { backgroundColor: strip.tint, borderStyle: 'round', borderColor: strip.edge } : {}
    const Svg = r.ui.Svg
    const band = Svg && r.skin.paper ? paperBand(panePx(r), n, r.skin.paper) : null
    return (
      <Box key={`row:${key}`} flexDirection="column">
        {Svg && band ? <Svg key={`band:${key}`} source={band.source} alt={band.alt} /> : null}
        <Box key={`strip:${key}`} flexDirection="column" paddingX={strip ? 'sm' : 0} paddingY={strip ? 'sm' : 'xs'} gap="xs" {...filled}>
          <Box key={`rowtop:${key}`} flexDirection="row" gap="sm" alignItems="center" flexWrap="wrap">
            <Button key={key} plain onPress={onPress}>
              <Text weight={tone === 'strong' ? 'semibold' : 'medium'} {...ink(r, tone === 'dim')}>
                {main}
              </Text>
            </Button>
            {chipEls(r, key, chips)}
          </Box>
          {tail ? (
            <Box key={`tailbox:${key}`} paddingLeft="xs">
              <Text key={`${key}:tail`} size="footnote" {...ink(r, true)} wrap="wrap">
                {tail}
              </Text>
            </Box>
          ) : null}
        </Box>
      </Box>
    )
  }
  const said = [...chips.map(c => c.text), tail].filter(Boolean).join(' · ')
  const room = Math.max(8, r.cols - 2)
  const mainCut = fit(main, Math.max(6, room - Math.min(cellWidth(said) + 1, Math.floor(room / 2))))
  const tailCut = fit(said, Math.max(0, room - cellWidth(mainCut) - 1))
  return (
    <Box key={`row:${key}`} flexDirection="row" gap={1}>
      <Button key={key} label={mainCut} plain dimColor={tone === 'dim'} variant={tone === 'strong' ? 'primary' : undefined} onPress={onPress} />
      {tailCut ? (
        <Text key={`${key}:tail`} dimColor>
          {tailCut}
        </Text>
      ) : null}
    </Box>
  )
}

/** Where a list's rows are grouped; they stand as they are, on every surface. */
function listCard(_r: R, _key: string, rows: RenderElement[]): RenderElement[] {
  // each row is a bordered strip of its own: a frame around the group would be a border in a border
  return rows
}

/** A choice between a few things, each one in sight: buttons in a card on the desktop, a Select in the terminal. */
function choice(
  r: R,
  key: string,
  label: string,
  value: string,
  options: readonly { value: string; label: string; short?: string; why?: string }[],
  onPick: (value: string) => void,
): RenderElement {
  const { Box, Button, Select, Text } = r.ui
  if (!isDesk(r)) {
    return <Select key={key} label={label} value={value} options={options.map(o => ({ value: o.value, label: o.label }))} onSelect={onPick} />
  }
  const why = options.find(o => o.value === value)?.why
  return (
    <Box
      key={`card:${key}`}
      flexDirection="column"
      borderStyle={r.skin.card?.border ?? 'round'}
      {...(r.skin.card ? { borderColor: r.skin.card.edge, backgroundColor: r.skin.card.fill } : { borderColor: 'subtle' })}
      paddingX="md"
      paddingY="md"
      gap="sm"
    >
      <Text key={`${key}:cap`} size="footnote" weight="medium" {...(r.skin.card ? ink(r) : {})}>
        {label.replace(/[：:]\s*$/, '')}
      </Text>
      <Box key={`${key}:opts`} flexDirection="row" gap="sm" flexWrap="wrap">
        {options.map(o => (
          <Button key={`${key}:${o.value}`} label={o.short ?? o.label} variant={o.value === value ? 'primary' : 'secondary'} onPress={() => onPick(o.value)} />
        ))}
      </Box>
      {why ? (
        <Text key={`${key}:why`} size="footnote" {...(r.skin.card ? ink(r, true) : { dimColor: true })} wrap="wrap">
          {why}
        </Text>
      ) : null}
    </Box>
  )
}

function backButton(r: R): RenderElement {
  const { Button } = r.ui
  return <Button key="back" label="← 返回" onPress={() => r.act.back()} />
}

function go(r: R, route: AtlasRoute, from: string): () => void {
  return () => r.act.push({ ...route, from } as AtlasRoute)
}

function more(r: R, list: string, total: number, shown: number, step = 30): RenderElement | null {
  const { Button } = r.ui
  if (shown >= total) return null
  return (
    <Button
      key={`more:${list}`}
      label={`更多（还有 ${total - shown} 条）`}
      onPress={() => r.act.view(v => ({ ...v, limits: { ...v.limits, [list]: (v.limits[list] ?? step) + step } }))}
    />
  )
}

function limitOf(r: R, list: string, step = 30): number {
  return r.view.limits[list] ?? step
}

function issueCount(r: R, slug: string): number {
  return r.idx.health.filter(i => i.projectSlug === slug).length
}

function actions(r: R, items: (RenderElement | null | false)[]): RenderElement {
  const { Box } = r.ui
  return (
    <Box key={`actions:${items.length}`} flexDirection="row" gap={isDesk(r) ? 'sm' : 1} flexWrap="wrap" alignItems="center">
      {items}
    </Box>
  )
}

function pathActions(r: R, path: string, keyBase: string, withEditor: boolean): RenderElement {
  const { Button } = r.ui
  return actions(r, [
    withEditor && <Button key={`${keyBase}:editor`} label="用编辑器打开" onPress={() => r.act.editor(path)} />,
    <Button key={`${keyBase}:reveal`} label="在 Finder 显示" onPress={() => r.act.reveal(path)} />,
    <Button key={`${keyBase}:copy`} label="复制路径" onPress={press => r.act.copy(path, press.surface)} />,
  ])
}

/** A path and its two buttons, 打开 (Finder) and 复制路径: wherever a path shows. */
function pathRow(r: R, key: string, text: string, path: string, isDir: boolean): RenderElement {
  const { Box, Text, Button } = r.ui
  return (
    <Box key={`pathrow:${key}`} flexDirection="row" gap={isDesk(r) ? 'sm' : 1} alignItems="center" flexWrap={isDesk(r) ? 'wrap' : 'nowrap'}>
      <Text key={`pathtext:${key}`} dimColor>
        {isDesk(r) ? text : fit(text, Math.max(10, r.cols - 22))}
      </Text>
      <Button key={`open:${key}`} label="打开" onPress={() => (isDir ? r.act.openDir(path) : r.act.reveal(path))} />
      <Button key={`copy:${key}`} label="复制路径" onPress={press => r.act.copy(path, press.surface)} />
    </Box>
  )
}

function daysLabel(d: string): string {
  return keepLabel(d)
}

/**
 * 删除 → 确认删除（N 天后自动清空 / 不会自动清空）: two presses, the keep period beside it.
 * Everything goes through atlas.py trash; nothing here deletes.
 */
function deleteControl(r: R, key: string, paths: string[], label: string, kind?: string, warn?: string): RenderElement[] {
  const { Box, Button, Select } = r.ui
  const days = r.view.trashDays || r.trashDays
  const pendingKey = `del:${key}`
  const isPending = r.view.pending === pendingKey
  const out: RenderElement[] = [
    <Box key={`delrow:${key}`} flexDirection="row" gap={1} flexWrap="wrap">
      <Select
        key={`days:${key}`}
        label="回收站"
        value={days}
        options={TRASH_DAYS.map(d => ({ value: d, label: daysLabel(d) }))}
        onSelect={v => r.act.view(x => ({ ...x, trashDays: v }))}
      />
      {isPending ? (
        <Button key={`delok:${key}`} label={`确认删除（${keepNote(days)}）`} variant="primary" onPress={() => r.act.trash(paths, label, kind)} />
      ) : (
        <Button key={`del:${key}`} label="删除" onPress={() => r.act.pending(pendingKey)} />
      )}
      {isPending ? <Button key={`delno:${key}`} label="取消" onPress={() => r.act.pending(null)} /> : null}
    </Box>,
  ]
  if (warn) out.push(dim(r, `delwarn:${key}`, warn))
  return out
}

function ioSection(r: R, key: string, io: Io | undefined): RenderElement[] {
  if (!io) return []
  const out: RenderElement[] = [title(r, `io:${key}`, '去向')]
  const part = (name: string, list: IoDir[], sub: string) => {
    out.push(dim(r, `io:${key}:${sub}`, `${name} ${list.length}`))
    const shown = list.slice(0, limitOf(r, `io:${key}:${sub}`, 10))
    shown.forEach((d, i) => {
      const tags = [`×${d.count}`, IO_CLASS[d.class] ?? d.class, d.via === 'bash' ? 'bash' : ''].filter(Boolean).join(' · ')
      out.push(pathRow(r, `io:${key}:${sub}:${i}`, `${sp(r, d.dir)}  ${tags}`, d.dir, true))
    })
    const m = more(r, `io:${key}:${sub}`, list.length, shown.length, 10)
    if (m) out.push(m)
  }
  part('写到了哪', io.writes, 'w')
  part('从哪读', io.reads, 'r')
  return out
}

function isArchived(r: R, kind: 'sessions' | 'projects', id: string): boolean {
  return r.prefs.archived[kind].includes(id)
}

function archiveToggle(r: R, kind: 'sessions' | 'projects', id: string): RenderElement {
  const { Button } = r.ui
  const on = isArchived(r, kind, id)
  return (
    <Button
      key={`arch:${kind}:${id}`}
      label={on ? '取消归档' : '归档（只是从列表里收起，不动文件）'}
      plain
      onPress={() => r.act.setArchived(kind, id, !on)}
    />
  )
}

function showArchivedButton(r: R, kind: 'sessions' | 'projects'): RenderElement | null {
  const { Button } = r.ui
  const n = r.prefs.archived[kind].length
  if (n === 0) return null
  return (
    <Button
      key={`showarch:${kind}`}
      label={r.view.showArchived ? `隐藏已归档（${n}）` : `显示已归档（${n}）`}
      onPress={() => r.act.view(v => ({ ...v, showArchived: !v.showArchived }))}
    />
  )
}

// ---------- the frame ----------

export function drawPane(snap: Snap, size: { bodyColumns: number; bodyRows?: number; viewportRows?: number }, table: UI): RenderElement {
  // the look is the skin's: every button of the page takes its make from it, where the surface draws colour
  const skin = skinOf(snap.prefs.skin)
  const ui: UI = snap.surface === 'desktop' && skin.buttons ? { ...table, Button: paperButton(table, skin.buttons, skin.inkSoft) } : table
  const { Box, Text, Button } = ui
  const { scan, view, ctx, act } = snap
  const cols = Math.max(20, size.bodyColumns - 1)
  const rows = Math.max(12, size.bodyRows ?? size.viewportRows ?? 24)
  const idx = held.index
  const head: RenderElement[] = []
  if (!idx) {
    if (scan.status === 'error') {
      return (
        <Box flexDirection="column">
          <Text key="err" color="error">
            {scan.error ?? '扫描出错'}
          </Text>
          <Button key="refresh" label="重新扫描" autoFocus onPress={() => act.scan()} />
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Text key="scanning" dimColor>
          正在扫描…
        </Text>
        <Text key="scanning-hint" dimColor>
          第一次扫描可能要一分钟左右。
        </Text>
      </Box>
    )
  }
  const r: R = {
    ...snap,
    ui,
    cols,
    rows,
    idx,
    tz: scan.tzOffsetMin ?? -new Date().getTimezoneOffset(),
    home: ctx.home || idx.home,
    stripe: { n: 0 },
    heads: { n: 0 },
    skin,
  }
  const status =
    scan.status === 'scanning'
      ? '正在刷新…'
      : `上次扫描 ${fmtHM(scan.generatedAtMs || idx.generatedAtMs, r.tz)} · 用时 ${Math.round((scan.elapsedMs || idx.elapsedMs) / 100) / 10}s`
  const isDesktop = r.surface === 'desktop'
  head.push(
    // the row spans the pane on the desktop, so what stands last in it stands at its right end
    <Box key="head" flexDirection="row" gap={isDesktop ? 'md' : 1} alignItems="center" {...(isDesktop ? { justifyContent: 'space-between' as const, width: '100%' } : {})}>
      <Box key="head-left" flexDirection="row" gap={isDesktop ? 'md' : 1} alignItems="center">
        <Text key="status" dimColor>
          {status}
        </Text>
        <Button key="refresh" label="刷新" onPress={() => act.scan()} />
      </Box>
      {isDesktop ? (
        // which skin the pane wears, folded into one menu: kept per machine, the same in every session
        <ui.Select key="skin" label="皮肤 " value={skin.id} options={SKINS.map(one => ({ value: one.id, label: one.name }))} onSelect={id => act.skin(id)} />
      ) : null}
    </Box>,
  )
  if (scan.error) {
    head.push(
      <Text key="scan-error" color="error">
        {fit(scan.error, cols)}
      </Text>,
    )
  }
  const route = view.stack[view.stack.length - 1]
  const issues = idx.health.length
  const tabs: { id: AtlasView['tab']; label: string }[] = [
    { id: 'memory', label: '记忆' },
    { id: 'sessions', label: '会话' },
    { id: 'skills', label: 'Skills' },
    { id: 'prompt', label: '提示词' },
    { id: 'tools', label: '工具' },
    { id: 'hooks', label: 'Hooks' },
    { id: 'structure', label: '结构' },
    { id: 'health', label: issues ? `体检 ${issues}` : '体检' },
    { id: 'trash', label: '回收站' },
  ]
  head.push(
    <Box key="nav" flexDirection="row" gap={r.surface === 'desktop' ? 'sm' : 1} flexWrap="wrap">
      {tabs.map(t => (
        <Button
          key={`tab:${t.id}`}
          label={t.label}
          variant={view.tab === t.id ? 'primary' : 'secondary'}
          onPress={() => act.tab(t.id)}
        />
      ))}
    </Box>,
  )
  head.push(...opLine(r))
  if (!route) head.push(...journalHead(r))
  const body = route ? drawRoute(r, route) : drawTab(r)
  // on the desktop every row of the page stands a step apart: a row of buttons is not pressed against its neighbours
  return (
    <Box flexDirection="column" {...(snap.surface === 'desktop' ? { gap: 'sm' as const } : {})}>
      {head}
      {body}
    </Box>
  )
}

/** Who draws the illustration over a page, by the hand the skin names. */
const PAGE_PICTURES: Record<PaperStyle, (spec: JournalSpec) => { source: string; alt: string }> = {
  washi: journalSvg,
  folio: folioSvg,
  riviera: rivieraSvg,
  porto: portoSvg,
}

/**
 * The illustration over a page: the page's numbers as a spread of the skin's
 * paper (a 手帐 page, an archive page), where the surface draws pictures. It
 * folds away, and stays folded.
 */
function journalHead(r: R): RenderElement[] {
  const { Button } = r.ui
  const Svg = r.ui.Svg
  const style = r.skin.paper
  if (!Svg || r.surface !== 'desktop' || !style) return []
  const name = r.skin.pageName
  if (r.view.journalOff === true) {
    return [<Button key="journal-show" label={`展开${name}`} plain dimColor onPress={() => r.act.view(v => ({ ...v, journalOff: false }))} />]
  }
  const spec = journalSpec(r, Date.now(), r.skin.pageTitle)
  if (!spec) return []
  const picture = PAGE_PICTURES[style](spec)
  return [
    <Svg key="journal" source={picture.source} alt={picture.alt} />,
    <Button key="journal-hide" label={`收起${name}`} plain dimColor onPress={() => r.act.view(v => ({ ...v, journalOff: true }))} />,
  ]
}

function drawTab(r: R): RenderElement[] {
  switch (r.view.tab) {
    case 'memory':
      return r.view.memoryMode === 'sort' ? drawSort(r) : drawMemory(r)
    case 'sessions':
      return drawSessions(r)
    case 'skills':
      return drawSkills(r)
    case 'prompt':
      return drawPrompt(r)
    case 'tools':
      return drawTools(r)
    case 'hooks':
      return drawHooks(r)
    case 'structure':
      return drawStructure(r)
    case 'health':
      return drawHealth(r)
    case 'trash':
      return drawTrash(r)
  }
}

function drawRoute(r: R, route: AtlasRoute): RenderElement[] {
  switch (route.kind) {
    case 'project': {
      const p = core.projectBySlug(route.slug)
      return p ? drawProject(r, p) : [backButton(r), dim(r, 'gone', '这个项目不在最新的扫描里了')]
    }
    case 'custom':
      return drawCustom(r, route.name)
    case 'file':
      return drawFile(r, route.path)
    case 'session': {
      const s = r.idx.sessions.find(x => x.path === route.path)
      return s ? drawSession(r, s) : [backButton(r), dim(r, 'gone', '这个会话不在最新的扫描里了')]
    }
    case 'skill': {
      const s = r.idx.skills.find(x => x.name === route.name)
      return s ? drawSkill(r, s) : [backButton(r), dim(r, 'gone', '这个 skill 不在最新的扫描里了')]
    }
    case 'section':
      return drawSection(r, route.id)
    case 'hook':
      return drawHook(r, route.id)
    case 'hooknew':
      return drawHookNew(r)
    case 'inject':
      return drawInject(r, route.type)
    case 'outside':
      return drawOutside(r, route.index)
    case 'tool':
      return drawTool(r, route.name)
    case 'toolserver':
      return drawToolServer(r, route.server)
  }
}

// ---------- boards ----------

type BoardCard = { id: string; kind: string; label: string; hint?: string; badge?: string }
type BoardColumn = { id: string; title: string; subtitle?: string; accepts?: string[]; cards: BoardCard[] }

function drawBoard(
  r: R,
  boardId: string,
  columns: BoardColumn[],
  opts: { allowMerge: boolean; allowReorder: boolean; reserved: number },
): RenderElement[] {
  const { Client, Button, Box, Text } = r.ui
  const width = r.cols
  const n = columns.length
  const isRow = n > 0 && width >= 24 * n
  const avail = Math.max(6, r.rows - opts.reserved)
  const pageSize = isRow ? Math.min(20, Math.max(3, avail - 1)) : Math.min(10, Math.max(2, Math.floor(avail / Math.max(1, n)) - 2))
  const longest = Math.max(0, ...columns.map(c => c.cards.length))
  const pages = Math.max(1, Math.ceil(longest / pageSize))
  const page = Math.min(r.view.boardPage[boardId] ?? 0, pages - 1)
  // the columns' coloured sheets are the skin's, with its ink: a skin with none, or the terminal, has plain rows
  const sheets = isDesk(r) && r.skin.sheets.length > 0 && r.skin.ink && r.skin.inkSoft ? { sheets: r.skin.sheets, ink: r.skin.ink, inkSoft: r.skin.inkSoft } : null
  const props = { boardId, columns, allowMerge: opts.allowMerge, allowReorder: opts.allowReorder, page, pageSize, ...(sheets ? { paper: sheets } : {}) }
  const height = boardHeight(n, pageSize, width)
  const out: RenderElement[] = [
    <Client key={`board:${boardId}`} module="./board.tsx" props={props} width={width} height={height} />,
  ]
  if (pages > 1) {
    const setPage = (p: number) => () =>
      r.act.view(v => ({ ...v, boardPage: { ...v.boardPage, [boardId]: Math.max(0, Math.min(pages - 1, p)) } }))
    out.push(
      <Box key={`pager:${boardId}`} flexDirection="row" gap={1}>
        <Button key={`page:${boardId}:prev`} label="上一页" onPress={setPage(page - 1)} />
        <Text key={`page:${boardId}:n`} dimColor>{`第 ${page + 1}/${pages} 页`}</Text>
        <Button key={`page:${boardId}:next`} label="下一页" onPress={setPage(page + 1)} />
      </Box>,
    )
  }
  out.push(dim(r, `hint:${boardId}`, '拖动卡片；或点一下卡片选中，再点列标题放进去。再点一次选中的卡片打开它。'))
  return out
}

function scopeSelect(r: R, key: string, label = '拖动改的是：'): RenderElement {
  return choice(
    r,
    key,
    isDesk(r) ? (label.startsWith('拖动') ? '拖动的改动存到哪一层' : '改动存到哪一层') : label,
    r.view.scope,
    [
      { value: 'session', label: '本会话', why: '只影响现在这个会话，关掉会话就没了。' },
      { value: 'project', label: '本项目默认', short: '本项目', why: '以后在这个文件夹里新开的会话都带上；现在这个会话不变。' },
      { value: 'global', label: '全局默认', short: '全局', why: '以后任何项目里新开的会话都带上；现在这个会话不变。' },
    ],
    value => r.act.view(v => ({ ...v, scope: value as AtlasScope })),
  )
}

/** The 本会话加载 board's columns: groups, plus the loaded files no group holds. */
export function loadColumns(r: Pick<R, 'idx' | 'ctx' | 'sw' | 'prefs' | 'loaded' | 'view' | 'home'>): BoardColumn[] {
  const groups = core.allGroups(r.ctx, r.prefs)
  const curId = core.currentGroupId(r.ctx)
  const scope = r.view.scope
  const cols: Record<AtlasMemoryState, BoardColumn> = {
    mount: { id: 'mount', title: '挂载', cards: [] },
    read: { id: 'read', title: '可读', cards: [] },
    off: { id: 'off', title: '关闭', cards: [] },
  }
  for (const g of groups) {
    const state = scope === 'session' ? core.memState(r.sw, g.id, curId) : core.defaultState(r.prefs, scope, r.ctx.cwd, g.id, curId)
    const files = countFiles(r.idx, g.id)
    cols[state].cards.push(
      card({
        id: `g:${g.id}`,
        kind: 'item',
        label: g.id === curId ? `${g.name}（本会话）` : g.name,
        badge: '组',
        hint: files === null ? undefined : `${files} 个文件`,
      }),
    )
  }
  if (scope === 'session') {
    for (const f of r.loaded.files) {
      if (groups.some(g => g.paths.some(p => isInside(f.path, p)))) continue
      const state: AtlasMemoryState = r.sw.files[f.path] ?? 'mount'
      cols[state].cards.push({ id: `f:${f.path}`, kind: 'item', label: shortPath(f.path, r.home), badge: f.kind })
    }
  }
  return [cols.mount, cols.read, cols.off]
}

function countFiles(idx: AtlasIndex, id: string): number | null {
  if (id.startsWith('project:')) return idx.projects.find(p => `project:${p.slug}` === id)?.memoryFiles.length ?? null
  return idx.customMemory.find(c => c.name === id)?.files.length ?? null
}

export function skillColumns(r: Pick<R, 'idx' | 'ctx' | 'sw' | 'prefs' | 'view'>): BoardColumn[] {
  const off = new Set(core.skillOffIn(r.prefs, r.view.scope, r.ctx.cwd, r.sw))
  const on: BoardCard[] = []
  const offCards: BoardCard[] = []
  const order: SkillSource[] = ['user', 'project', 'synced', 'plugin', 'builtin']
  const skills = [...r.idx.skills].sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source) || b.useCount - a.useCount || a.name.localeCompare(b.name))
  for (const s of skills) {
    const card: BoardCard = {
      id: `s:${s.name}`,
      kind: 'skill',
      label: s.name,
      badge: SOURCE_BADGE[s.source],
      hint: s.useCount ? `用过 ${s.useCount} 次` : '从未调用',
    }
    if (off.has(s.name)) {
      if (r.view.scope === 'session') card.hint = `已关闭 · ${core.skillOffLevel(r.prefs, r.ctx.cwd, s.name)}`
      offCards.push(card)
    } else on.push(card)
  }
  return [
    { id: 'on', title: '开', cards: on },
    { id: 'off', title: '关', cards: offCards },
  ]
}

/** The 记忆整理 board's columns, the groups picked. */
export function sortColumns(r: Pick<R, 'idx' | 'ctx' | 'prefs' | 'view'>): BoardColumn[] {
  const groups = core.allGroups(r.ctx, r.prefs)
  const ids = r.view.sortColumns ?? defaultSortColumns(r.idx, groups.map(g => g.id))
  const out: BoardColumn[] = []
  for (const id of ids) {
    const g = groups.find(x => x.id === id)
    if (!g) continue
    out.push({ id: g.id, title: g.name, cards: groupFiles(r.idx, g.id).map(f => fileCard(f)) })
  }
  return out
}

function fileCard(f: MemoryFile): BoardCard {
  return card({ id: f.path, kind: 'memory', label: f.title || f.name, badge: f.type ?? undefined, hint: f.linked ? undefined : '未索引' })
}

/** A card with no undefined field: a Client's props must be plain JSON. */
function card(c: BoardCard): BoardCard {
  const out: BoardCard = { id: c.id, kind: c.kind, label: c.label }
  if (c.hint !== undefined) out.hint = c.hint
  if (c.badge !== undefined) out.badge = c.badge
  return out
}

export function groupFiles(idx: AtlasIndex, id: string): MemoryFile[] {
  if (id.startsWith('project:')) {
    const p = idx.projects.find(x => `project:${x.slug}` === id)
    if (!p) return []
    const links = p.index?.links ?? []
    const rank = (f: MemoryFile) => {
      const i = links.indexOf(f.name)
      return i < 0 ? links.length + 1 : i
    }
    return [...p.memoryFiles].sort((a, b) => rank(a) - rank(b))
  }
  return idx.customMemory.find(c => c.name === id)?.files ?? []
}

export function defaultSortColumns(idx: AtlasIndex, available: readonly string[]): string[] {
  const out: string[] = []
  const cur = idx.projects.find(p => p.isCurrent)
  if (cur) out.push(`project:${cur.slug}`)
  for (const name of ['shared-memory', 'memory-archive']) if (available.includes(name)) out.push(name)
  const recent = idx.projects
    .filter(p => !p.isCurrent && p.memoryFiles.length > 0)
    .sort((a, b) => b.lastActiveMs - a.lastActiveMs)
    .slice(0, 2)
  for (const p of recent) out.push(`project:${p.slug}`)
  return out.filter(id => available.includes(id))
}

// ---------- 记忆 ----------

function memoryModes(r: R): RenderElement {
  const { Button } = r.ui
  return actions(r, [
    <Button
      key="mode:overview"
      label="概览"
      variant={r.view.memoryMode === 'overview' ? 'primary' : 'secondary'}
      onPress={() => r.act.view(v => ({ ...v, memoryMode: 'overview' }))}
    />,
    <Button
      key="mode:sort"
      label="记忆整理"
      variant={r.view.memoryMode === 'sort' ? 'primary' : 'secondary'}
      onPress={() => r.act.view(v => ({ ...v, memoryMode: 'sort' }))}
    />,
  ])
}

function drawMemory(r: R): RenderElement[] {
  const { Input, Text } = r.ui
  const out: RenderElement[] = [memoryModes(r)]
  out.push(title(r, 'load-title', '本会话加载'))
  out.push(scopeSelect(r, 'scope:load'))
  out.push(...drawBoard(r, 'load', loadColumns(r), { allowMerge: false, allowReorder: false, reserved: 16 }))
  if (r.view.scope !== 'session') out.push(dim(r, 'scope-note', '改的是默认值：从下一个会话起生效，本会话不变。'))
  out.push(dim(r, 'honesty', HONESTY))
  for (const s of r.loaded.skipped) out.push(dim(r, `skip:${s.path}`, `${sp(r, s.path)}：${s.reason}`))
  if (r.loaded.recordedAtMs === 0) out.push(dim(r, 'loaded-none', '本会话还没发出第一条消息，加载了哪些说明文件要等那时才知道。'))

  out.push(title(r, 'search-title', '搜索记忆'))
  out.push(
    <Input
      key="search"
      placeholder="关键词，回车搜索"
      value={r.search.query}
      submitLabel="搜索"
      onSubmit={value => r.act.search(value)}
    />,
  )
  if (r.search.status === 'searching') out.push(dim(r, 'searching', '正在搜索…'))
  if (r.search.status === 'error' && r.search.error) {
    out.push(
      <Text key="search-error" color="error">
        {fit(r.search.error, r.cols)}
      </Text>,
    )
  }
  if (r.search.status === 'done') {
    const hits = r.search.results
    if (hits.length === 0) out.push(dim(r, 'no-hits', `没有找到「${r.search.query}」`))
    const shown = hits.slice(0, limitOf(r, 'search', 20))
    shown.forEach((h, i) => {
      const label = hitLabel(r, h.path, h.projectSlug)
      out.push(rowButton(r, `hit:${i}`, `${label}:${h.line}`, h.text.trim(), go(r, { kind: 'file', path: h.path, line: Math.max(0, h.line - 1) }, `hit:${i}`)))
    })
    const m = more(r, 'search', hits.length, shown.length, 20)
    if (m) out.push(m)
  }

  const projects = r.idx.projects.filter(p => p.isCurrent || r.view.showArchived || !isArchived(r, 'projects', p.slug))
  const cur = projects.find(p => p.isCurrent)
  const withMemory = projects.filter(p => !p.isCurrent && hasMemory(p))
  const empty = projects.filter(p => !p.isCurrent && !hasMemory(p))
  out.push(title(r, 'projects-title', '项目记忆'))
  const showArch = showArchivedButton(r, 'projects')
  if (showArch) out.push(showArch)
  if (cur) out.push(projectRow(r, cur, true))
  for (const p of withMemory) out.push(projectRow(r, p, false))
  if (empty.length) {
    const fromScratch = empty.filter(p => p.kind !== 'project').length
    out.push(dim(r, 'empty-dirs', `另有 ${empty.length} 个空记忆目录（${fromScratch} 个来自无文件夹会话）`))
  }
  out.push(title(r, 'custom-title', '自建目录'))
  for (const c of r.idx.customMemory) {
    out.push(rowButton(r, `custom:${c.name}`, c.name, `${c.files.length} 个文件`, go(r, { kind: 'custom', name: c.name }, `custom:${c.name}`)))
  }
  const g = r.idx.globalClaudeMd
  out.push(
    rowButton(
      r,
      'global-claude-md',
      '全局 CLAUDE.md',
      g.exists ? `${g.lines} 行` : '不存在',
      go(r, { kind: 'file', path: g.path }, 'global-claude-md'),
    ),
  )
  return out
}

function hasMemory(p: Project): boolean {
  return p.memoryFiles.length > 0 || Boolean(p.index?.exists && p.index.bytes > 0)
}

function hitLabel(r: R, path: string, slug: string | null): string {
  if (slug) {
    const p = core.projectBySlug(slug)
    if (p) return `${p.label}/${basename(path)}`
  }
  for (const c of r.idx.customMemory) if (isInside(path, c.path)) return `${c.name}/${path.slice(c.path.length + 1)}`
  return sp(r, path)
}

function projectRow(r: R, p: Project, isCurrent: boolean): RenderElement {
  const lines = p.index?.exists ? `MEMORY.md ${p.index.lines} 行` : '无 MEMORY.md'
  const n = issueCount(r, p.slug)
  const tail = [
    `${p.memoryFiles.length} 个文件`,
    lines,
    n ? `${n} 个问题` : '',
    renameNote(p, r.home),
    isArchived(r, 'projects', p.slug) ? '已归档' : '',
    fmtMD(p.lastActiveMs, r.tz),
  ]
    .filter(Boolean)
    .join(' · ')
  return rowButton(r, `proj:${p.slug}`, isCurrent ? `${p.label} · 本会话` : p.label, tail, go(r, { kind: 'project', slug: p.slug }, `proj:${p.slug}`), isCurrent ? 'strong' : undefined)
}

function drawSort(r: R): RenderElement[] {
  const { Button, Box, Text, Code } = r.ui
  const out: RenderElement[] = [memoryModes(r)]
  const groups = core.allGroups(r.ctx, r.prefs)
  const shownIds = r.view.sortColumns ?? defaultSortColumns(r.idx, groups.map(g => g.id))
  out.push(dim(r, 'pick-hint', '显示哪些列：'))
  out.push(
    <Box key="picker" flexDirection="row" gap={1} flexWrap="wrap">
      {groups.map(g => (
        <Button
          key={`pick:${g.id}`}
          label={g.name}
          variant={shownIds.includes(g.id) ? 'primary' : 'secondary'}
          onPress={() =>
            r.act.view(v => {
              const cur = v.sortColumns ?? shownIds
              return { ...v, sortColumns: cur.includes(g.id) ? cur.filter(x => x !== g.id) : [...cur, g.id] }
            })
          }
        />
      ))}
    </Box>,
  )
  const m = r.merge
  if (m.status === 'running') out.push(dim(r, 'merge-running', `正在合并 ${basename(m.source)} → ${basename(m.target)}…`))
  if (m.status === 'error' && m.error) {
    out.push(
      <Text key="merge-error" color="error">
        {fit(m.error, r.cols)}
      </Text>,
    )
    out.push(<Button key="merge-dismiss" label="知道了" onPress={() => r.act.dropMerge()} />)
  }
  if (m.status === 'ready') {
    out.push(title(r, 'merge-title', `合并到 ${sp(r, m.target)}`))
    out.push(m.diff ? <Code key="merge-diff" source={m.diff} format="diff" /> : dim(r, 'merge-same', '合并结果和目标文件一样'))
    out.push(dim(r, 'merge-note', `合并后 ${basename(m.source)} 会移进回收站（${keepNote(r.view.trashDays || r.trashDays)}），并从 MEMORY.md 去掉`))
    out.push(
      actions(r, [
        <Button key="merge-apply" label="应用" variant="primary" onPress={() => r.act.applyMerge()} />,
        <Button key="merge-drop" label="放弃" onPress={() => r.act.dropMerge()} />,
      ]),
    )
  }
  out.push(...drawBoard(r, 'sort', sortColumns(r), { allowMerge: true, allowReorder: true, reserved: 14 }))
  out.push(dim(r, 'sort-hint', '拖到列标题或空处 = 移动文件；拖到另一张卡片上 = 合并；同一列里上下拖 = 调整 MEMORY.md 顺序。'))
  return out
}

function opLine(r: R): RenderElement[] {
  const { Box, Text, Button } = r.ui
  const o = r.op
  if (o.id === 0) return []
  if (o.error && !o.canUndo) {
    return [
      <Text key="op-error" color="error">
        {fit(o.error, r.cols)}
      </Text>,
    ]
  }
  if (!o.label) return []
  return [
    <Box key="op" flexDirection="row" gap={1}>
      <Text key="op-label" color="success">
        {fit(o.label, Math.max(10, r.cols - 10))}
      </Text>
      {o.canUndo ? <Button key="op-undo" label="撤销" onPress={() => r.act.undoOp()} /> : null}
    </Box>,
  ]
}

// ---------- project / custom / file ----------

function stateControl(r: R, groupId: string): RenderElement {
  const { Box, Button, Text } = r.ui
  const cur = core.memState(r.sw, groupId, core.currentGroupId(r.ctx))
  return (
    <Box key={`state:${groupId}`} flexDirection="row" gap={1}>
      <Text key="state-label">本会话：</Text>
      {(['mount', 'read', 'off'] as const).map(s => (
        <Button
          key={`state:${groupId}:${s}`}
          label={STATE_LABEL[s]}
          variant={cur === s ? 'primary' : 'secondary'}
          onPress={() => r.act.memState(groupId, s)}
        />
      ))}
    </Box>
  )
}

function drawProject(r: R, p: Project): RenderElement[] {
  const { Text, Button } = r.ui
  const out: RenderElement[] = [backButton(r)]
  out.push(title(r, 'p-title', p.isCurrent ? `${p.label} · 本会话` : p.label))
  const where = p.resolvedCwd ?? p.cwd
  if (where) out.push(pathRow(r, 'p-cwd', `目录：${sp(r, where)}`, where, true))
  else out.push(dim(r, 'p-cwd', '目录：（不知道）'))
  const moved = renameNote(p, r.home)
  if (moved) out.push(dim(r, 'p-moved', moved))
  if (p.memoryDir) out.push(pathRow(r, 'p-memdir', `记忆：${sp(r, p.memoryDir)}`, p.memoryDir, true))
  else out.push(dim(r, 'p-memdir', '记忆：没有 memory 目录'))
  if (p.memoryDir) out.push(stateControl(r, `project:${p.slug}`))
  out.push(title(r, 'p-loads', '每次启动加载'))
  if (p.loads.length === 0) out.push(dim(r, 'p-loads-none', '没有记录'))
  p.loads.forEach((l, i) => out.push(rowButton(r, `load:${i}`, `${l.type} ${sp(r, l.path)}`, '', go(r, { kind: 'file', path: l.path }, `load:${i}`))))
  const ix = p.index
  if (ix?.exists) {
    const over = ix.overLineLimit || ix.overByteLimit
    out.push(
      rowButton(
        r,
        'p-index',
        `MEMORY.md ${ix.lines}/200 行 · ${ix.bytes}/25000 字节`,
        over ? '超出部分不会加载' : '',
        go(r, { kind: 'file', path: ix.path }, 'p-index'),
        over ? 'strong' : undefined,
      ),
    )
  } else if (p.memoryDir) out.push(dim(r, 'p-noindex', '没有 MEMORY.md'))

  out.push(title(r, 'p-claude', 'CLAUDE.md'))
  const cm = r.extra.claudeMds?.slug === p.slug ? r.extra.claudeMds : null
  if (!p.cwd) out.push(dim(r, 'p-claude-none', '不知道项目目录'))
  else if (!cm) out.push(dim(r, 'p-claude-loading', '正在查看…'))
  else {
    for (const it of cm.items) {
      if (it.exists) out.push(rowButton(r, `cm:${it.path}`, sp(r, it.path), '', go(r, { kind: 'file', path: it.path }, `cm:${it.path}`)))
    }
    const main = cm.items[0]
    if (main && !main.exists) {
      out.push(
        <Button
          key="cm-new"
          label={`新建 ${basename(main.path)}`}
          onPress={() => r.act.newFile(main.path)}
        />,
      )
    }
    if (cm.items.every(i => !i.exists)) out.push(dim(r, 'p-claude-missing', '这个项目还没有 CLAUDE.md'))
  }

  out.push(title(r, 'p-files', `记忆文件 ${p.memoryFiles.length}`))
  const shown = p.memoryFiles.slice(0, limitOf(r, `pf:${p.slug}`, 40))
  for (const f of shown) {
    const tail = [f.type ?? '', f.linked ? '' : '未索引', f.description].filter(Boolean).join(' · ')
    out.push(rowButton(r, `mf:${f.path}`, f.title || f.name, tail, go(r, { kind: 'file', path: f.path }, `mf:${f.path}`)))
  }
  const m = more(r, `pf:${p.slug}`, p.memoryFiles.length, shown.length, 40)
  if (m) out.push(m)
  if (ix && ix.deadLinks.length) {
    out.push(title(r, 'p-dead', '失效链接'))
    for (const d of ix.deadLinks) {
      out.push(
        <Text key={`dead:${d}`} color="warning">
          {fit(`MEMORY.md → ${d}（文件不存在）`, r.cols)}
        </Text>,
      )
    }
  }
  const issues = r.idx.health.filter(i => i.projectSlug === p.slug)
  if (issues.length) out.push(dim(r, 'p-issues', `体检：${issues.length} 个问题（在「体检」里一键修）`))
  const history = p.pathHistory ?? []
  if (history.length) {
    out.push(title(r, 'p-history', '路径历史'))
    history.forEach((h, i) => {
      const when = h.lastSeenMs ? `${fmtMD(h.firstSeenMs ?? h.lastSeenMs, r.tz)}–${fmtMD(h.lastSeenMs, r.tz)}` : ''
      const tags = [h.launch ? '启动处' : '进过', h.source === 'relocated' ? '迁移记录' : h.source === 'slug-match' ? '按名字找到' : '', h.exists ? '' : '（不存在）', when]
        .filter(Boolean)
        .join(' · ')
      out.push(pathRow(r, `ph:${i}`, `${sp(r, h.path)}  ${tags}`, h.path, true))
    })
  }
  const related = (p.relatedSlugs ?? []).filter(x => x !== p.slug)
  if (related.length) {
    out.push(title(r, 'p-related', '同一个项目的其他记录'))
    for (const slug of related) {
      const q = core.projectBySlug(slug)
      out.push(rowButton(r, `rel:${slug}`, q?.label ?? slug, q ? `${q.sessionCount} 个会话 · ${fmtMD(q.lastActiveMs, r.tz)}` : slug, go(r, { kind: 'project', slug }, `rel:${slug}`)))
    }
  }
  out.push(...ioSection(r, `p:${p.slug}`, p.io))
  if (p.diskBytes !== undefined) out.push(dim(r, 'p-disk', `Claude 数据占用 ${fmtSize(p.diskBytes)}`))
  out.push(title(r, 'p-archive-title', '归档'))
  out.push(archiveToggle(r, 'projects', p.slug))
  if (!p.isCurrent) {
    out.push(title(r, 'p-delete-title', '删除（进回收站）'))
    out.push(dim(r, 'p-delete-what', '删的是这个项目在 ~/.claude/projects 里的会话记录和记忆，不碰项目目录本身。'))
    out.push(...deleteControl(r, `project:${p.slug}`, [`${r.idx.claudeDir}/projects/${p.slug}`], `项目 ${p.label} 的 Claude 数据`, 'project'))
  }
  return out
}

function drawCustom(r: R, name: string): RenderElement[] {
  const c = r.idx.customMemory.find(x => x.name === name)
  const out: RenderElement[] = [backButton(r)]
  if (!c) return [...out, dim(r, 'gone', '这个目录不在最新的扫描里了')]
  out.push(title(r, 'c-title', c.name))
  out.push(dim(r, 'c-path', sp(r, c.path)))
  out.push(stateControl(r, c.name))
  const shown = c.files.slice(0, limitOf(r, `cf:${name}`, 40))
  for (const f of shown) {
    out.push(rowButton(r, `cf:${f.path}`, f.name, [f.type ?? '', f.description].filter(Boolean).join(' · '), go(r, { kind: 'file', path: f.path }, `cf:${f.path}`)))
  }
  const m = more(r, `cf:${name}`, c.files.length, shown.length, 40)
  if (m) out.push(m)
  out.push(pathActions(r, c.path, 'c', false))
  return out
}

function editorPageSize(r: R): number {
  return Math.max(6, Math.min(40, r.rows - 14))
}

function drawFile(r: R, path: string): RenderElement[] {
  const { Text, Button, Markdown, Input, Select, Box } = r.ui
  const f = r.file
  const out: RenderElement[] = [backButton(r)]
  out.push(title(r, 'f-path', sp(r, path)))
  if (f.path !== path || f.status === 'loading' || f.status === 'idle') {
    out.push(dim(r, 'f-loading', '正在读取…'))
    return out
  }
  if (f.status === 'error') {
    out.push(
      <Text key="f-error" color="error">
        {f.error ?? '读不到这个文件'}
      </Text>,
    )
    out.push(pathActions(r, path, 'f', false))
    return out
  }
  const info = core.editInfo(path, r.ctx)
  const lines = splitLines(f.text)
  out.push(dim(r, 'f-meta', f.isNew ? '新文件（还没保存）' : `${fmtSize(f.size)} · ${lines.length} 行 · 改于 ${fmtMDHM(f.mtimeMs, r.tz)}`))
  if (info.note) out.push(dim(r, 'f-readonly', info.note))
  const canUndo = held.undo.has(path)
  out.push(
    actions(r, [
      info.editable && (
        <Button key="f-mode" label={f.mode === 'edit' ? '阅读' : '编辑'} onPress={() => r.act.fileMode(f.mode === 'edit' ? 'read' : 'edit')} />
      ),
      !f.isNew && <Button key="f-editor" label="用编辑器打开" onPress={() => r.act.editor(path)} />,
      !f.isNew && <Button key="f-reveal" label="在 Finder 显示" onPress={() => r.act.reveal(path)} />,
      <Button key="f-copy" label="复制路径" onPress={press => r.act.copy(path, press.surface)} />,
      canUndo && <Button key="f-undo" label="撤销上次修改" onPress={() => r.act.undoFile(path)} />,
    ]),
  )
  if (canUndo) out.push(dim(r, 'f-undo-note', UNDO_NOTE))
  if (f.stale) {
    out.push(
      <Box key="f-stale" flexDirection="row" gap={1}>
        <Text key="f-stale-text" color="error">
          文件在外面被改过了
        </Text>
        <Button key="f-reload" label="重新载入" onPress={() => r.act.reloadFile()} />
      </Box>,
    )
  }
  if (f.note) {
    out.push(
      <Text key="f-note" color="warning">
        {fit(f.note, r.cols)}
      </Text>,
    )
  }
  if (!f.isNew) out.push(...fileDeleteArchive(r, path, info))
  if (f.mode !== 'edit' || !info.editable) {
    const md = readableMarkdown(f.text)
    out.push(<Markdown key="f-md" text={md.length > 60_000 ? md.slice(0, 60_000) + '\n\n…（太长，后面没有显示）' : md} />)
    return out
  }
  // ---- the structured editor ----
  const fm = parseFrontmatter(f.text)
  const bodyStart = fm ? fm.end + 1 : 0
  if (fm) {
    out.push(title(r, 'fm-title', 'frontmatter'))
    out.push(
      <Input key="fm:name" label="name " value={fm.name?.value ?? ''} submitLabel="保存" onSubmit={v => saveField(r, path, 'name', v)} />,
    )
    out.push(
      <Input
        key="fm:description"
        label="description "
        value={fm.description?.value ?? ''}
        submitLabel="保存"
        onSubmit={v => saveField(r, path, 'description', v)}
      />,
    )
    if (info.isMemory) {
      const cur = fm.type?.value ?? ''
      const opts = [...new Set([...(cur ? [cur] : []), ...MEMORY_TYPES])]
      out.push(
        <Select
          key="fm:type"
          label="type "
          value={cur || undefined}
          options={[...(cur ? [] : [{ value: '', label: '（没有）' }]), ...opts.map(o => ({ value: o, label: o }))]}
          onSelect={v => {
            if (v) saveField(r, path, 'type', v)
          }}
        />,
      )
    }
  } else if (f.fmDraft) {
    const d = f.fmDraft
    out.push(title(r, 'fmd-title', '补 frontmatter'))
    const setDraft = (patch: Partial<typeof d>) => r.act.fmDraft(patch)
    out.push(<Input key="fmd:name" label="name " value={d.name} onInput={v => setDraft({ name: v })} onSubmit={v => setDraft({ name: v })} />)
    out.push(
      <Input key="fmd:description" label="description " value={d.description} onInput={v => setDraft({ description: v })} onSubmit={v => setDraft({ description: v })} />,
    )
    out.push(
      <Select
        key="fmd:type"
        label="type "
        value={d.type || ''}
        options={[{ value: '', label: '（不写）' }, ...MEMORY_TYPES.map(o => ({ value: o, label: o }))]}
        onSelect={v => setDraft({ type: v })}
      />,
    )
    out.push(<Button key="fmd:write" label="写入 frontmatter" variant="primary" onPress={() => r.act.writeFm()} />)
  } else if (info.isMemory && !info.isIndexFile) {
    out.push(<Button key="fmd:start" label="补 frontmatter" onPress={() => r.act.startFmDraft()} />)
  }
  const body = lines.slice(bodyStart)
  const size = editorPageSize(r)
  const pages = Math.max(1, Math.ceil(body.length / size))
  const page = Math.min(pages - 1, Math.max(0, Math.floor(Math.max(0, f.anchor - bodyStart) / size)))
  const from = page * size
  if (info.isIndexFile && lines.length > 200) {
    out.push(
      <Text key="f-over" color="warning">
        {fit(`MEMORY.md 有 ${lines.length} 行：第 201 行起启动时不会加载`, r.cols)}
      </Text>,
    )
  }
  out.push(title(r, 'body-title', `正文（第 ${page + 1}/${pages} 页；改一行后回车即保存整个文件）`))
  const numW = String(lines.length).length
  body.slice(from, from + size).forEach((l, k) => {
    const i = bodyStart + from + k
    const notLoaded = info.isIndexFile && i >= 200
    out.push(
      <Box key={`row:${i}`} flexDirection="row" gap={1}>
        <Input key={`line:${i}`} label={String(i + 1).padStart(numW)} value={l.text} submitLabel="保存" onSubmit={v => saveLine(r, path, i, v)} />
        <Button key={`ins:${i}`} label="+" onPress={() => insertLine(r, path, i)} />
        <Button key={`del:${i}`} label="×" onPress={() => removeLine(r, path, i)} />
        {notLoaded ? (
          <Text key={`nl:${i}`} dimColor>
            不会加载
          </Text>
        ) : null}
      </Box>,
    )
  })
  if (body.length === 0) {
    out.push(<Button key={`ins:${bodyStart - 1}`} label="+ 加一行" onPress={() => insertLine(r, path, bodyStart - 1)} />)
  }
  if (pages > 1) {
    out.push(
      <Box key="f-pager" flexDirection="row" gap={1}>
        <Button key="f-prev" label="上一页" onPress={() => r.act.fileAnchor(bodyStart + Math.max(0, from - size))} />
        <Button key="f-next" label="下一页" onPress={() => r.act.fileAnchor(bodyStart + Math.min((pages - 1) * size, from + size))} />
      </Box>,
    )
  }
  return out
}


function saveField(r: R, path: string, key: 'name' | 'description' | 'type', value: string): void {
  r.act.save(path, text => setFrontmatterField(text, key, value))
}

function saveLine(r: R, path: string, i: number, value: string): void {
  r.act.save(path, text => (text === '' && i === 0 ? value : replaceLine(text, i, value)))
}

function insertLine(r: R, path: string, i: number): void {
  r.act.save(path, text => insertLineAfter(text, i), `line:${i + 1}`)
}

function removeLine(r: R, path: string, i: number): void {
  r.act.save(path, text => deleteLine(text, i))
}

// ---------- 会话 ----------

function skillNames(s: Session): string {
  const names = [...new Set(s.skillsInvoked.map(k => k.name))]
  return names.length ? names.join(', ') : '未调用 skill'
}

function drawSessions(r: R): RenderElement[] {
  const out: RenderElement[] = []
  const list = [...r.idx.sessions]
    .filter(s => r.view.showArchived || !isArchived(r, 'sessions', s.path))
    .sort((a, b) => b.lastMs - a.lastMs)
  const shown = list.slice(0, limitOf(r, 'sessions'))
  out.push(dim(r, 's-count', `${list.length} 个会话，最新的在前`))
  const showArch = showArchivedButton(r, 'sessions')
  if (showArch) out.push(showArch)
  for (const s of shown) {
    const label = core.projectBySlug(s.projectSlug)?.label ?? s.projectSlug
    const arch = isArchived(r, 'sessions', s.path) ? ' · 已归档' : ''
    out.push(rowButton(r, `sess:${s.path}`, s.title, `${label} · ${fmtMDHM(s.lastMs, r.tz)} · ${skillNames(s)}${arch}`, go(r, { kind: 'session', path: s.path }, `sess:${s.path}`)))
  }
  const m = more(r, 'sessions', list.length, shown.length)
  if (m) out.push(m)
  return out
}

function drawSession(r: R, s: Session): RenderElement[] {
  const { Button, Box, Text } = r.ui
  const out: RenderElement[] = [backButton(r)]
  out.push(title(r, 'ss-title', s.title))
  out.push(
    <Box key="ss-id" flexDirection="row" gap={1}>
      <Text key="ss-id-text" dimColor>
        {fit(`ID ${s.id}`, Math.max(10, r.cols - 12))}
      </Text>
      <Button key="ss-copy" label="复制 ID" onPress={press => r.act.copy(s.id, press.surface)} />
    </Box>,
  )
  if (s.cwd) out.push(pathRow(r, 'ss-cwd', `目录：${sp(r, s.cwd)}`, s.cwd, true))
  else out.push(dim(r, 'ss-cwd', '目录：（不知道）'))
  out.push(dim(r, 'ss-entry', `入口：${s.entrypoint ?? '（不知道）'} · 版本 ${s.version ?? '（不知道）'} · ${fmtMDHM(s.startedMs, r.tz)} 开始`))
  out.push(title(r, 'ss-loads', '启动时加载'))
  if (s.loads.length === 0) out.push(dim(r, 'ss-loads-none', '没有记录'))
  s.loads.forEach((l, i) => out.push(rowButton(r, `sl:${i}`, `${l.type} ${sp(r, l.path)}`, '', go(r, { kind: 'file', path: l.path }, `sl:${i}`))))
  out.push(title(r, 'ss-skills', '调用的 skills'))
  if (s.skillsInvoked.length === 0) out.push(dim(r, 'ss-skills-none', '未调用 skill'))
  s.skillsInvoked.forEach((k, i) => {
    const marks = [k.inSubagent ? '子代理' : '', k.via === 'command' ? '命令' : ''].filter(Boolean).join(' ')
    out.push(rowButton(r, `sk:${i}`, `${k.name} ×${k.count}`, marks, go(r, { kind: 'skill', name: k.name }, `sk:${i}`)))
  })
  out.push(title(r, 'ss-reads', `读过的记忆 ${s.memoryReads.length}`))
  s.memoryReads.forEach((p, i) => out.push(rowButton(r, `read:${i}`, sp(r, p), '', go(r, { kind: 'file', path: p }, `read:${i}`))))
  out.push(title(r, 'ss-writes', `写过的记忆 ${s.memoryWrites.length}`))
  s.memoryWrites.forEach((p, i) => out.push(rowButton(r, `write:${i}`, sp(r, p), '', go(r, { kind: 'file', path: p }, `write:${i}`))))
  out.push(dim(r, 'ss-sub', `子代理 ${s.subagentCount} 个`))
  out.push(
    <Button
      key="ss-avail"
      label={`可用 skills ${s.skillsAvailable.length} 个${r.view.showSkillNames ? '（收起）' : '（展开）'}`}
      onPress={() => r.act.view(v => ({ ...v, showSkillNames: !v.showSkillNames }))}
    />,
  )
  if (r.view.showSkillNames) out.push(dim(r, 'ss-avail-names', s.skillsAvailable.join(', ')))
  out.push(...ioSection(r, `s:${s.id}`, s.io))
  if (s.diskBytes !== undefined) out.push(dim(r, 'ss-disk', `占用 ${fmtSize(s.diskBytes)}`))
  out.push(title(r, 'ss-archive-title', '归档'))
  out.push(archiveToggle(r, 'sessions', s.path))
  if (s.id === r.ctx.sessionId) {
    out.push(dim(r, 'ss-current', '这是当前会话，不能删除。'))
  } else {
    out.push(title(r, 'ss-delete-title', '删除（进回收站）'))
    out.push(
      ...deleteControl(
        r,
        `session:${s.path}`,
        [s.path],
        `会话「${s.title}」`,
        'session',
        '桌面 app 侧栏里这条会话还在，但打不开了；要从侧栏去掉，请在 app 里删除或归档它',
      ),
    )
  }
  return out
}

// ---------- Skills ----------

function drawSkills(r: R): RenderElement[] {
  const { Button, Text } = r.ui
  const out: RenderElement[] = [
    actions(r, [
      <Button
        key="smode:board"
        label="开关看板"
        variant={r.view.skillsMode === 'board' ? 'primary' : 'secondary'}
        onPress={() => r.act.view(v => ({ ...v, skillsMode: 'board' }))}
      />,
      <Button
        key="smode:list"
        label="用量列表"
        variant={r.view.skillsMode === 'list' ? 'primary' : 'secondary'}
        onPress={() => r.act.view(v => ({ ...v, skillsMode: 'list' }))}
      />,
    ]),
  ]
  if (r.view.skillsMode === 'board') {
    out.push(scopeSelect(r, 'scope:skills'))
    out.push(...drawBoard(r, 'skills', skillColumns(r), { allowMerge: false, allowReorder: false, reserved: 12 }))
    if (r.view.scope !== 'session') out.push(dim(r, 'scope-note', '改的是默认值：从下一个会话起生效，本会话不变。'))
    out.push(dim(r, 'honesty', HONESTY))
    return out
  }
  const order: SkillSource[] = ['user', 'synced', 'plugin', 'project', 'builtin']
  const off = new Set(r.sw.skillsOff)
  for (const src of order) {
    const list = r.idx.skills.filter(s => s.source === src)
    if (!list.length) continue
    out.push(title(r, `src:${src}`, `${SOURCE_LABEL[src]} ${list.length}`))
    const shown = list.slice(0, limitOf(r, `skills:${src}`, 40))
    for (const s of shown) {
      const tail = off.has(s.name)
        ? `已关闭 · ${core.skillOffLevel(r.prefs, r.ctx.cwd, s.name)}`
        : s.useCount
          ? `用过 ${s.useCount} 次 · ${s.sessionsUsing} 个会话 · ${s.lastUsedMs ? fmtMD(s.lastUsedMs, r.tz) : ''}`
          : '从未调用'
      out.push(rowButton(r, `skill:${s.name}`, s.name, tail, go(r, { kind: 'skill', name: s.name }, `skill:${s.name}`), s.useCount ? undefined : 'dim'))
    }
    const m = more(r, `skills:${src}`, list.length, shown.length, 40)
    if (m) out.push(m)
  }
  if (r.idx.skills.length === 0) out.push(<Text key="no-skills" dimColor>没有找到 skill</Text>)
  return out
}

function drawSkill(r: R, s: Skill): RenderElement[] {
  const { Button, Text } = r.ui
  const out: RenderElement[] = [backButton(r)]
  out.push(title(r, 'sk-title', s.name))
  out.push(dim(r, 'sk-src', `来源：${SOURCE_LABEL[s.source]}${s.plugin ? ` · 插件 ${s.plugin}` : ''}${s.projectCwd ? ` · ${sp(r, s.projectCwd)}` : ''}`))
  if (s.path) out.push(dim(r, 'sk-path', sp(r, s.path)))
  if (s.description) {
    out.push(
      <Text key="sk-desc" wrap="wrap">
        {s.description}
      </Text>,
    )
  }
  const isOff = r.sw.skillsOff.includes(s.name)
  out.push(dim(r, 'sk-state', isOff ? `本会话：已关闭（${core.skillOffLevel(r.prefs, r.ctx.cwd, s.name)}）` : '本会话：开'))
  out.push(
    <Button
      key="sk-toggle"
      label={isOff ? '本会话开启' : '本会话关闭'}
      onPress={() => r.act.skillState(s.name, !isOff)}
    />,
  )
  out.push(dim(r, 'sk-uses', s.useCount ? `用过 ${s.useCount} 次 · ${s.sessionsUsing} 个会话 · 出现在 ${s.listedIn} 个会话的列表里` : `从未调用 · 出现在 ${s.listedIn} 个会话的列表里`))
  if (s.path) {
    const ro = s.source === 'synced' || s.source === 'plugin'
    out.push(title(r, 'sk-files', '文件'))
    if (ro) out.push(dim(r, 'sk-ro', '只读：由 Claude 应用同步/插件提供，改了会被覆盖'))
    const sf = r.extra.skillFiles?.name === s.name ? r.extra.skillFiles : null
    if (!sf || sf.status === 'loading') out.push(dim(r, 'sk-files-loading', '正在列出…'))
    else for (const f of sf.files) out.push(rowButton(r, `skf:${f.path}`, f.rel, fmtSize(f.size), go(r, { kind: 'file', path: f.path }, `skf:${f.path}`)))
  }
  const using = r.idx.sessions.filter(x => x.skillsInvoked.some(k => k.name === s.name)).sort((a, b) => b.lastMs - a.lastMs)
  out.push(title(r, 'sk-sessions', `调用过它的会话 ${using.length}`))
  const shown = using.slice(0, limitOf(r, `sks:${s.name}`))
  for (const x of shown) out.push(rowButton(r, `sks:${x.path}`, x.title, fmtMDHM(x.lastMs, r.tz), go(r, { kind: 'session', path: x.path }, `sks:${x.path}`)))
  const m = more(r, `sks:${s.name}`, using.length, shown.length)
  if (m) out.push(m)
  if (s.path) out.push(pathActions(r, s.path, 'sk', true))
  if (s.path && (s.source === 'user' || s.source === 'project')) {
    out.push(title(r, 'sk-delete-title', '删除（进回收站）'))
    out.push(...deleteControl(r, `skill:${s.name}`, [dirname(s.path)], `skill ${s.name}`, s.source === 'user' ? 'user-skill' : 'project-skill'))
  }
  return out
}

// ---------- 提示词 ----------

const PROMPT_WHEN =
  '系统提示词在一条对话开始时就定下了：这里的改动从新会话、/clear 或压缩之后生效。把「生效」改成下一轮，本会话就不用等，但每改一次会重建一次提示缓存、丢掉模型之前的思考。'
const SECTION_SCOPE: Record<string, string> = { shared: '公共段', session: '会话段' }
const LEVELS_NOTE =
  '括号里是这个改动存在哪几层。带「本会话」的才是这个会话正在用的；只有「本项目」或「全局」的，是之后改的默认值，从新会话起生效。'

function sizeText(text: string | null): string {
  return text === null ? '' : `${text.length} 字符 · 约 ${approxTokens(text)} tokens`
}

function promptRows(r: R): SectionRow[] {
  return sectionRows(heldM.composed ?? [], heldM.original, editsIn(r.prefs, r.view.scope, r.ctx.cwd, r.sw), levelEdits(r.prefs, r.ctx.cwd, r.sw).session)
}

function promptLoadLine(r: R): RenderElement {
  const { Box, Text, Button } = r.ui
  const m = r.manage.prompt
  const text = m.status === 'loading' ? '正在读取…' : m.status === 'error' ? m.error ?? '没能读出系统提示词' : m.atMs ? `读取于 ${fmtHM(m.atMs, r.tz)}` : '还没有读取'
  return (
    <Box key="p-load" flexDirection="row" gap={1}>
      <Text key="p-load-text" dimColor={m.status !== 'error'} color={m.status === 'error' ? 'error' : undefined}>
        {fit(text, Math.max(10, r.cols - 12))}
      </Text>
      <Button key="p-reload" label="重新读取" onPress={() => r.act.promptLoad()} />
    </Box>
  )
}

/** The levels that switch a section off or rewrite it, as marks for its row. */
function sectionChips(all: ReturnType<typeof levelEdits>, id: string): Chip[] {
  const off = levelsWhere(all, e => e.off.includes(id))
  const rewritten = levelsWhere(all, e => e.rewrite[id] !== undefined)
  return [
    ...(off.length ? [{ text: `已关闭（${levelsText(off)}）`, tone: 'off' as const }] : []),
    ...(rewritten.length ? [{ text: `已改写（${levelsText(rewritten)}）`, tone: 'rewritten' as const }] : []),
  ]
}

function drawPrompt(r: R): RenderElement[] {
  const { Input } = r.ui
  const out: RenderElement[] = [scopeSelect(r, 'scope:prompt', '改的是：')]
  out.push(
    choice(
      r,
      'p-now',
      isDesk(r) ? '本会话里的改动什么时候生效' : '生效：',
      r.sw.promptNow === true ? 'now' : 'later',
      [
        { value: 'later', label: '新会话 / 压缩后（默认）', short: '新会话或压缩后', why: '默认。不打断现在的对话，也不多花钱。' },
        { value: 'now', label: '下一轮（每次改动重建缓存）', short: '下一轮', why: '本会话不用等，但每改一次会重建一次提示缓存，并丢掉模型之前的思考。' },
      ],
      v => r.act.promptNow(v === 'now'),
    ),
  )
  const level = editsIn(r.prefs, r.view.scope, r.ctx.cwd, r.sw)
  out.push(<Input key="rn-name" label="把指令里的 the user 换成 " value={renameOf(level)} placeholder="留空 = 不换" submitLabel="保存" onSubmit={v => r.act.promptRename(v)} />)
  out.push(dim(r, 'rn-levels', renameLevelsText(levelEdits(r.prefs, r.ctx.cwd, r.sw)) || '三层都没设名字：指令里写的还是 the user。'))
  out.push(promptLoadLine(r))
  if (!heldM.composed) {
    if (r.manage.prompt.status !== 'loading') out.push(dim(r, 'p-none', '点「重新读取」，看这个会话的系统提示词由哪些段组成。'))
    return out
  }
  const rows = promptRows(r)
  const edits = editsIn(r.prefs, r.view.scope, r.ctx.cwd, r.sw)
  const all = levelEdits(r.prefs, r.ctx.cwd, r.sw)
  const sent = rows.reduce((n, x) => n + (x.sent?.length ?? 0), 0) + edits.extra.reduce((n, x) => n + (x.off ? 0 : x.text.length), 0)
  const tokens = rows.reduce((n, x) => n + (x.sent ? approxTokens(x.sent) : 0), 0) + edits.extra.reduce((n, x) => n + (x.off ? 0 : approxTokens(x.text)), 0)
  const name = renameOf(edits)
  const swapped = name ? rows.reduce((n, x) => n + (x.sent ? renameUser(x.sent, name).count : 0), 0) : 0
  if (name) out.push(dim(r, 'rn-count', `这一层设的名字是 ${name}：按现在这些段会换掉 ${swapped} 处，对话里的注入和工具说明也一并换。桌面 App 自己追加的那部分换不到。`))
  out.push(title(r, 'p-title', isDesk(r) ? `系统提示词的段 · ${rows.length} 段` : `引擎的段 ${rows.length}`))
  out.push(dim(r, 'p-total', `按现在的开关共发出 ${sent} 字符 · 约 ${tokens} tokens（工具说明和 CLAUDE.md 不在这里面）`))
  const sectionEls: RenderElement[] = []
  for (const x of rows) {
    const hits = name && x.sent ? renameUser(x.sent, name).count : 0
    const chips: Chip[] = [...sectionChips(all, x.id), ...(hits ? [{ text: `换名 ${hits} 处`, tone: 'name' as const }] : [])]
    const known = sectionName(x.id)
    const tail = [known === x.id ? '' : x.id, x.scope ? SECTION_SCOPE[x.scope] : '', x.original === null ? '' : `${x.original.length} 字符`].filter(Boolean).join(' · ')
    sectionEls.push(rowButton(r, `sec:${x.id}`, isDesk(r) ? known : x.id, tail, go(r, { kind: 'section', id: x.id }, `sec:${x.id}`), x.state === 'off' ? 'dim' : x.state === 'rewritten' ? 'strong' : undefined, chips))
  }
  out.push(...listCard(r, 'sections', sectionEls))
  out.push(title(r, 'px-title', `自己加的段 ${edits.extra.length}`))
  const extraEls: RenderElement[] = []
  for (const x of edits.extra) {
    const at = levelsText(levelsWhere(all, e => e.extra.some(y => y.id === x.id)))
    const chips: Chip[] = [...(x.off ? [{ text: '已关闭', tone: 'off' as const }] : []), ...(at ? [{ text: `在：${at}`, tone: 'note' as const }] : [])]
    const tail = x.text.trim() ? `${x.text.length} 字符` : '还没写内容'
    extraEls.push(rowButton(r, `sec:${x.id}`, x.name, tail, go(r, { kind: 'section', id: x.id }, `sec:${x.id}`), x.off ? 'dim' : undefined, chips))
  }
  out.push(...listCard(r, 'extras', extraEls))
  out.push(<Input key="px-new" label="新加一段，起个名字 " placeholder="比如：说话方式" submitLabel="新建" onSubmit={v => r.act.promptExtraNew(v)} />)
  out.push(dim(r, 'px-note', '自己加的段排在系统提示词最后；它只在新会话、/clear 或压缩之后才进提示词。'))
  out.push(...injectList(r, all))
  out.push(...outsideList(r))
  out.push(dim(r, 'p-levels', LEVELS_NOTE))
  if (r.view.scope !== 'session') out.push(dim(r, 'p-scope-note', '改的是默认值：从下一个会话起生效，本会话不变。'))
  out.push(dim(r, 'p-when', PROMPT_WHEN))
  return out
}

const ORIGIN_NAME: Record<string, string> = { engine: '引擎', hook: 'settings hook', plugin: '插件' }
const INJECT_NOTE =
  '关闭只管之后的注入：已经进了对话的，要 /clear 或压缩之后才消失。这里记的是这个会话从 Atlas 加载之后看到的注入。'

/** The kinds of message the engine has injected into this conversation, and the ones a level switches off. */
function injectList(r: R, all: ReturnType<typeof levelEdits>): RenderElement[] {
  const types = [...new Set([...heldM.injects.keys(), ...LEVELS.flatMap(l => injectOffOf(all[l]))])]
  const seen = [...heldM.injects.values()]
  const chars = seen.reduce((n, x) => n + x.chars, 0)
  const out: RenderElement[] = [title(r, 'inj-title', `对话里的注入 ${types.length} 种`)]
  out.push(dim(r, 'inj-total', `系统提示词之外，引擎还会把这些作为 system reminder 放进对话。这个会话到现在共 ${chars} 字符 · 约 ${Math.ceil(chars / 3)} tokens。`))
  if (types.length === 0) {
    out.push(dim(r, 'inj-none', '还没记录到：注入在每一轮对话里才出现，发一条消息后再回来看。'))
    return out
  }
  types.sort((a, b) => (heldM.injects.get(b)?.chars ?? 0) - (heldM.injects.get(a)?.chars ?? 0))
  const injectEls: RenderElement[] = []
  for (const type of types) {
    const s = heldM.injects.get(type)
    const isOff = injectOffOf(all[r.view.scope]).includes(type)
    const offAt = injectLevelsText(all, type)
    const chips: Chip[] = [...(offAt ? [{ text: offAt, tone: 'off' as const }] : []), ...(s?.blocked ? [{ text: `拦下 ${s.blocked} 次`, tone: 'note' as const }] : [])]
    const tail = [injectName(type) === type ? '' : type, s ? `出现 ${s.count} 次 · ${s.chars} 字符` : ''].filter(Boolean).join(' · ')
    injectEls.push(rowButton(r, `inj:${type}`, injectName(type), tail, go(r, { kind: 'inject', type }, `inj:${type}`), isOff ? 'dim' : undefined, chips))
  }
  out.push(...listCard(r, 'injects', injectEls))
  out.push(dim(r, 'inj-note', INJECT_NOTE))
  return out
}

const OUTSIDE_WHY = '这些文字不走「段」这条路，所以上面的开关和改写管不到它们。Atlas 只是把它们从发出去的请求里读出来给你看，关不掉也改不了。'

/**
 * What the system prompt carries beside the sections: the engine's own opening lines, and what the
 * app that started the session appended. Read off the request the engine last sent; shown, never changed.
 */
function outsideList(r: R): RenderElement[] {
  const seen = heldM.outside
  const out: RenderElement[] = [title(r, 'out-title', `段之外的部分 ${seen ? seen.pieces.length : 0} 块`)]
  out.push(dim(r, 'out-what', '系统提示词里还有不属于任何一段的文字：引擎自己加的开头，和启动这个会话的 App 追加的规则（比如桌面 App 的浏览器安全规则）。'))
  if (!seen) {
    out.push(
      dim(
        r,
        'out-none',
        heldM.outsideLooked === 0
          ? '还没读到：Atlas 加载（或重新加载）之后，这个会话还没有发出过请求。发一条消息，这里就会有内容。'
          : `看过 ${heldM.outsideLooked} 个请求，还没有一个对得上上面这些段。点「重新读取」，再发一条消息试试。`,
      ),
    )
    out.push(dim(r, 'out-old', '终端里较旧的 CLI 不把发出的请求交给 mod 看，在那里这一栏会一直是空的。'))
    return out
  }
  const chars = seen.pieces.reduce((n, p) => n + p.text.length, 0)
  const tokens = seen.pieces.reduce((n, p) => n + approxTokens(p.text), 0)
  out.push(dim(r, 'out-total', `读自 ${fmtHM(seen.atMs, r.tz)} 发出的请求：共 ${chars} 字符 · 约 ${tokens} tokens。`))
  const els: RenderElement[] = []
  seen.pieces.forEach((p, i) => {
    els.push(rowButton(r, `out:${i}`, outsideName(p.text), `${p.text.length} 字符 · 约 ${approxTokens(p.text)} tokens · 只读`, go(r, { kind: 'outside', index: i }, `out:${i}`)))
  })
  out.push(...listCard(r, 'outside', els))
  out.push(dim(r, 'out-why', OUTSIDE_WHY))
  return out
}

function drawOutside(r: R, index: number): RenderElement[] {
  const { Button } = r.ui
  const piece = heldM.outside?.pieces[index]
  if (!piece) {
    return [backButton(r), title(r, 'out-name', '段之外的部分'), dim(r, 'out-gone', '这一块现在读不到了（Atlas 重新加载过）。发一条消息，回到提示词页点「重新读取」再看。')]
  }
  const out: RenderElement[] = [backButton(r), title(r, 'out-name', outsideName(piece.text))]
  out.push(dim(r, 'out-meta', `在系统提示词的第 ${piece.block + 1} 块里 · ${piece.text.length} 字符 · 约 ${approxTokens(piece.text)} tokens · 只读`))
  out.push(dim(r, 'out-why', OUTSIDE_WHY))
  out.push(actions(r, [<Button key="out-copy" label="复制内容" onPress={press => r.act.copy(piece.text, press.surface)} />]))
  out.push(title(r, 'out-text-title', '发出去的原文'))
  out.push(sectionBox(r, 'out-text', piece.text))
  return out
}

function drawInject(r: R, type: string): RenderElement[] {
  const { Button } = r.ui
  const out: RenderElement[] = [backButton(r), title(r, 'inj-name', injectName(type))]
  const s = heldM.injects.get(type)
  out.push(dim(r, 'inj-meta', [type, s ? `来自${ORIGIN_NAME[s.origin] ?? s.origin}` : '', s ? `出现 ${s.count} 次 · 共 ${s.chars} 字符` : '这个会话还没出现过', s?.blocked ? `拦下 ${s.blocked} 次` : ''].filter(Boolean).join(' · ')))
  out.push(scopeSelect(r, 'scope:inject', '改的是：'))
  const all = levelEdits(r.prefs, r.ctx.cwd, r.sw)
  for (const l of LEVELS) {
    const isOff = injectOffOf(all[l]).includes(type)
    const name = l === 'session' ? '本会话' : `${LEVEL_NAME[l]}默认`
    out.push(dim(r, `inj-lv-${l}`, `${name}：${isOff ? '已关闭' : '照常注入'}${r.view.scope === l ? '  ← 现在改的是这一层' : ''}`))
  }
  const isOff = injectOffOf(all[r.view.scope]).includes(type)
  out.push(
    actions(r, [
      <Button key="inj-toggle" label={isOff ? '重新开启' : '关闭这一种'} onPress={() => r.act.injectOff(type, !isOff)} />,
      s?.lastText ? <Button key="inj-copy" label="复制最近一次的内容" onPress={press => r.act.copy(s.lastText, press.surface)} /> : null,
    ]),
  )
  const caution = injectCaution(type)
  if (caution) out.push(dim(r, 'inj-caution', caution))
  if (r.view.scope !== 'session') out.push(dim(r, 'inj-scope-note', '改的是默认值：从下一个会话起生效，本会话不变。'))
  out.push(title(r, 'inj-text-title', s?.blocked && !s.count ? '被拦下的内容（最近一次）' : '最近一次的内容'))
  if (s?.lastText) out.push(sectionBox(r, 'inj-text', s.lastText))
  else out.push(dim(r, 'inj-text-none', '还没见到它的内容。'))
  out.push(dim(r, 'inj-note', INJECT_NOTE))
  return out
}

function sectionBox(r: R, key: string, text: string): RenderElement {
  const { Text } = r.ui
  return (
    <Text key={key} wrap="wrap">
      {text.length > 60_000 ? text.slice(0, 60_000) + '\n…（太长，后面没有显示）' : text}
    </Text>
  )
}

/** One line per level: what it does to the section, and which one the buttons write. */
function levelLines(r: R, id: string): RenderElement[] {
  const all = levelEdits(r.prefs, r.ctx.cwd, r.sw)
  return LEVELS.map(l => {
    const what = levelState(all[l], id)
    const effect = l !== 'session' ? '' : what === '已关闭' ? '，不发给模型' : what === '已改写' ? '，发的是改写后的文字' : '，原样发出'
    const name = l === 'session' ? '本会话' : `${LEVEL_NAME[l]}默认`
    return dim(r, `s-lv-${l}`, `${name}：${what}${effect}${r.view.scope === l ? '  ← 现在改的是这一层' : ''}`)
  })
}

function drawSection(r: R, id: string): RenderElement[] {
  const { Button, Input } = r.ui
  const out: RenderElement[] = [backButton(r)]
  const edits = editsIn(r.prefs, r.view.scope, r.ctx.cwd, r.sw)
  const areaRows = Math.max(4, Math.min(24, r.rows - 16))
  if (id.startsWith(EXTRA_PREFIX)) {
    const x = edits.extra.find(e => e.id === id)
    out.push(scopeSelect(r, 'scope:section', '改的是：'))
    if (!x) {
      out.push(dim(r, 'px-gone', '这一段不在现在选的这一层里（换一下「改的是」，或者它已经被删掉了）。'))
      return out
    }
    out.push(title(r, 'px-name', x.name))
    out.push(dim(r, 'px-meta', [x.id, x.off ? '已关闭' : '开', sizeText(x.text)].filter(Boolean).join(' · ')))
    const all = levelEdits(r.prefs, r.ctx.cwd, r.sw)
    const at = levelsWhere(all, e => e.extra.some(y => y.id === id))
    out.push(dim(r, 'px-levels', `存在于：${levelsText(at)}${at.includes('session') ? '' : '。这个会话里没有它，从新会话起才有'}`))
    const pendingKey = `px-del:${id}`
    const isPending = r.view.pending === pendingKey
    out.push(
      actions(r, [
        <Button key="px-toggle" label={x.off ? '开启这一段' : '关闭这一段'} onPress={() => r.act.promptExtra({ ...x, off: !x.off })} />,
        isPending ? (
          <Button key="px-delok" label="确认删除（不进回收站）" variant="primary" onPress={() => r.act.promptExtraDrop(id)} />
        ) : (
          <Button key="px-del" label="删除" onPress={() => r.act.pending(pendingKey)} />
        ),
        isPending && <Button key="px-delno" label="取消" onPress={() => r.act.pending(null)} />,
        <Button key="px-copy" label="复制内容" onPress={press => r.act.copy(x.text, press.surface)} />,
      ]),
    )
    out.push(<Input key="px-rename" label="名字 " value={x.name} submitLabel="保存" onSubmit={v => (v.trim() ? r.act.promptExtra({ ...x, name: v.trim() }) : undefined)} />)
    out.push(title(r, 'px-text-title', '内容（回车保存；换行和输入框里一样）'))
    out.push(<Input key="px-text" rows={areaRows} value={x.text} placeholder="写给模型看的话…" submitLabel="保存" onSubmit={v => r.act.promptExtra({ ...x, text: v })} />)
    out.push(dim(r, 'px-when', '自己加的段只在新会话、/clear 或压缩之后才进提示词。'))
    return out
  }
  const row = promptRows(r).find(x => x.id === id)
  out.push(title(r, 's-id', isDesk(r) && sectionName(id) !== id ? `${sectionName(id)}（${id}）` : id))
  out.push(scopeSelect(r, 'scope:section', '改的是：'))
  if (!row) {
    out.push(promptLoadLine(r))
    out.push(dim(r, 's-gone', '这一段不在最新读到的系统提示词里。'))
    return out
  }
  out.push(dim(r, 's-meta', [row.scope ? `${SECTION_SCOPE[row.scope]}${row.scope === 'shared' ? '（所有人都一样的部分）' : '（随会话变的部分）'}` : '', sizeText(row.original)].filter(Boolean).join(' · ')))
  out.push(...levelLines(r, id))
  const rewrite = edits.rewrite[id]
  out.push(
    actions(r, [
      <Button key="s-toggle" label={row.state === 'off' ? '重新开启' : '关闭这一段'} onPress={() => r.act.promptOff(id, row.state !== 'off')} />,
      rewrite === undefined
        ? row.original !== null && <Button key="s-rewrite" label="改写这一段" onPress={() => r.act.promptRewrite(id, row.original)} />
        : <Button key="s-restore" label="恢复原文" onPress={() => r.act.promptRewrite(id, null)} />,
      row.original !== null && <Button key="s-copy" label="复制原文" onPress={press => r.act.copy(row.original ?? '', press.surface)} />,
    ]),
  )
  if (rewrite !== undefined) {
    out.push(title(r, 's-rw-title', `改写后的文字（${sizeText(rewrite)}；回车保存，换行和输入框里一样）`))
    out.push(<Input key="s-rw" rows={areaRows} value={rewrite} submitLabel="保存" onSubmit={v => r.act.promptRewrite(id, v)} />)
    if (row.scope === 'shared') out.push(dim(r, 's-shared', '这是公共段：改写后这一段不再和别人共用缓存，只是第一次请求稍慢一点。'))
  }
  out.push(title(r, 's-orig-title', '原文'))
  if (row.original === null) out.push(dim(r, 's-orig-none', '还没读到这一段的原文：它关着，引擎下次组装提示词时才会再给出原文。'))
  else out.push(sectionBox(r, 's-orig', row.original))
  if (r.view.scope === 'project' && levelEdits(r.prefs, r.ctx.cwd, r.sw).global.off.includes(id)) {
    out.push(dim(r, 's-global-off', '全局默认已经关了这一段：新会话是全局加项目两层叠加，项目这一层没法单独把它打开。'))
  }
  if (r.view.scope !== 'session') out.push(dim(r, 's-scope-note', '改的是默认值：从下一个会话起生效，本会话不变。'))
  out.push(dim(r, 's-when', PROMPT_WHEN))
  return out
}

// ---------- 工具 ----------

// two short lines, so the terminal (which cuts a note to one line) keeps both
const TOOLS_WHAT = '这个会话给模型的全部工具。大小只算每个工具的说明文字，参数表不算在内，所以实际占的还要多一些。'
const TOOLS_UNSEEN = 'Atlas 还没见到说明的工具先不显示大小：发一条消息之后就有了。'
const TOOLS_WHEN = '工具清单在一条对话开始时就定下了：改写的说明从新会话、/clear 或压缩之后生效；挪位置要等新会话或 /clear（压缩不会重排工具）。'
const TOOLS_OFF_NOW = '只有关掉是马上的：本会话里从现在起，模型每次调用关掉的工具都会被拒绝。'
const TOOL_SEARCH_NOTE = 'ToolSearch 是模型加载其他工具的入口，所以它不能关，也不能改成「用到再加载」；只能改写它的说明。'
const TOOL_SHORT_NOTE =
  '要改写它，最好等下面出现完整的说明之后：MCP 工具在被加载之前，引擎只给一句短说明，模型用 ToolSearch 加载它之后才有完整的，而改写会把两份一起换掉。下面显示的是最近见到的那一份。'
const WHERE_NAME: Record<ToolWhere, string> = { carried: '每次都带着', deferred: '用到才加载', off: '关掉了', unknown: '还不知道' }
const PLACE_NAME: Record<ToolPlace, string> = { pin: '一直带着', defer: '用到再加载', off: '关掉' }
const MARK_TONE: Record<ToolMark['what'], ChipTone> = { off: 'off', rewritten: 'rewritten', pin: 'on', defer: 'note' }

/** Every tool the page knows of, under the level 改的是 names; the tools only another level names are among them. */
function toolsOf(r: R): ToolRow[] {
  const all = levelEdits(r.prefs, r.ctx.cwd, r.sw)
  return toolRows(heldM.toolList, heldM.tools, all[r.view.scope], LEVELS.flatMap(l => toolNamesIn(all[l])))
}

function toolTokens(x: ToolRow): number {
  return x.sent === null ? 0 : approxTokens(x.sent)
}

function toolsLoadLine(r: R): RenderElement {
  const { Box, Text, Button } = r.ui
  const m = r.manage.tools
  const isError = m?.status === 'error'
  const text = m?.status === 'loading' ? '正在读取…' : isError ? m.error ?? '没能读出工具清单' : m?.atMs ? `读取于 ${fmtHM(m.atMs, r.tz)}` : '还没有读取'
  return (
    <Box key="t-load" flexDirection="row" gap={1}>
      <Text key="t-load-text" dimColor={!isError} color={isError ? 'error' : undefined}>
        {fit(text, Math.max(10, r.cols - 12))}
      </Text>
      <Button key="t-reload" label="重新读取" onPress={() => r.act.toolsLoad()} />
    </Box>
  )
}

/**
 * When a change reaches the model, in three lines: the rule, the one thing
 * that is immediate, and where 下一轮就生效 is switched and how it stands (the
 * 提示词 page keeps that one switch for sections and tools alike).
 */
function toolsWhenLines(r: R): RenderElement[] {
  const where = isDesk(r) ? '「本会话里的改动什么时候生效」' : '「生效」'
  // how it stands comes first: the terminal cuts a note to one line
  const now = `本会话里的改动，现在定的是「${r.sw.promptNow === true ? '下一轮' : '新会话或压缩后'}」生效。要改这个，到「提示词」页的${where}：工具和提示词共用这一个开关，选「下一轮」后每改一次会重建一次提示缓存。`
  return [dim(r, 't-when', TOOLS_WHEN), dim(r, 't-off-now', TOOLS_OFF_NOW), dim(r, 't-now', now)]
}

/** What the levels do to a tool, as marks for its row. */
function toolChips(all: ReturnType<typeof levelEdits>, name: string): Chip[] {
  return toolMarks(all, name).map(m => ({ text: m.text, tone: MARK_TONE[m.what] }))
}

/** One tool's row. `withWhere` writes where it waits in the small print, for a list that mixes the three. */
function toolListRow(r: R, all: ReturnType<typeof levelEdits>, x: ToolRow, withWhere = false): RenderElement {
  const size = x.sent !== null ? `说明约 ${kilo(toolTokens(x))} tokens` : x.isMissing ? '这个会话里没有这个工具' : '还没见到说明'
  const tail = [withWhere && x.where !== 'unknown' ? WHERE_NAME[x.where] : '', size, withWhere ? '' : toolOrigin(x)].filter(Boolean).join(' · ')
  const tone = x.where === 'off' ? 'dim' : x.rewrite !== undefined ? 'strong' : undefined
  return rowButton(r, `tool:${x.name}`, isDesk(r) ? x.short : x.name, tail, go(r, { kind: 'tool', name: x.name }, `tool:${x.name}`), tone, toolChips(all, x.name))
}

/** A group's rows where MCP tools are many: a tool that is no MCP server's on a row of its own, then one row per server that opens its tools. */
function toolFoldedRows(r: R, all: ReturnType<typeof levelEdits>, rows: readonly ToolRow[], keyBase: string): RenderElement[] {
  const out: RenderElement[] = []
  const servers = new Map<string, ToolRow[]>()
  for (const x of rows) {
    if (x.server) servers.set(x.server, [...(servers.get(x.server) ?? []), x])
    else out.push(toolListRow(r, all, x))
  }
  for (const [server, tools] of servers) {
    const changed = tools.filter(x => toolMarks(all, x.name).length > 0).length
    const tail = ['MCP 服务，点开看每一个', changed ? `其中 ${changed} 个改过` : ''].filter(Boolean).join(' · ')
    out.push(rowButton(r, `${keyBase}:${server}`, `${server}（${tools.length} 个工具）`, tail, go(r, { kind: 'toolserver', server }, `${keyBase}:${server}`)))
  }
  return out
}

function drawTools(r: R): RenderElement[] {
  const out: RenderElement[] = [dim(r, 't-what', TOOLS_WHAT), dim(r, 't-unseen', TOOLS_UNSEEN), scopeSelect(r, 'scope:tools', '改的是：')]
  // the groups below follow the level chosen above, as the 提示词 page's rows do: said, so a default is not read as this session
  if (r.view.scope !== 'session') out.push(dim(r, 't-scope-view', `下面几组是按「${LEVEL_NAME[r.view.scope]}默认」这一层的设置排的，不是这个会话现在的样子；要看现在的，把上面切回「本会话」。`))
  out.push(toolsLoadLine(r))
  const all = levelEdits(r.prefs, r.ctx.cwd, r.sw)
  const rows = toolsOf(r)
  if (rows.length === 0) {
    if (r.manage.tools?.status !== 'loading') out.push(dim(r, 't-none', '还没有工具的记录：点「重新读取」，看这个会话给了模型哪些工具。'))
    return out
  }
  const carried = rows.filter(x => x.where === 'carried').sort((a, b) => toolTokens(b) - toolTokens(a))
  const deferred = rows.filter(x => x.where === 'deferred')
  const off = rows.filter(x => x.where === 'off')
  const unknown = rows.filter(x => x.where === 'unknown')
  const tokens = carried.reduce((n, x) => n + toolTokens(x), 0)
  const unsized = carried.filter(x => x.sent === null).length
  out.push(title(r, 't-carried-title', `每次都带着 · ${carried.length} 个`))
  const total = `按现在的开关，说明共约 ${kilo(tokens)} tokens${unsized ? `（有 ${unsized} 个还没见到说明，没算进去）` : ''}`
  out.push(dim(r, 't-carried-note', carried.length ? `${total}。这些工具的说明和参数表每一轮都在提示词里，说明最长的排在最前面。` : '这一层的设置下，没有工具排在这里。'))
  out.push(...listCard(r, 'tools-carried', carried.map(x => toolListRow(r, all, x))))
  out.push(title(r, 't-deferred-title', `用到才加载 · ${deferred.length} 个`))
  out.push(dim(r, 't-deferred-note', deferred.length ? '提示词里只有它们的名字；模型要用哪个，先经 ToolSearch 把它加载进来。MCP 服务的工具按服务收成一行。' : '这一层的设置下，没有工具排在这里。'))
  out.push(...listCard(r, 'tools-deferred', toolFoldedRows(r, all, deferred, 'tsrv')))
  out.push(title(r, 't-off-title', `关掉的 · ${off.length} 个`))
  out.push(dim(r, 't-off-note', off.length ? '它们的名字还留在「可以加载」的清单里，但每次调用都会被拒绝。括号里是哪几层关的。' : `${LEVEL_NAME[r.view.scope]}这一层没有关掉任何工具。`))
  out.push(...listCard(r, 'tools-off', off.map(x => toolListRow(r, all, x))))
  if (unknown.length) {
    out.push(title(r, 't-unknown-title', `还没见到说明的 · ${unknown.length} 个`))
    out.push(dim(r, 't-unknown-note', '发一条消息之后，它们会归到上面几组里，也才有大小。现在引擎还没把它们的说明交给 Atlas（刚重载过，或者这个会话还没发过消息）。'))
    out.push(...listCard(r, 'tools-unknown', toolFoldedRows(r, all, unknown, 'tsrv-new')))
  }
  out.push(dim(r, 't-levels', LEVELS_NOTE))
  if (r.view.scope !== 'session') out.push(dim(r, 't-scope-note', '改的是默认值：从下一个会话起生效，本会话不变。'))
  out.push(...toolsWhenLines(r))
  return out
}

/** The tools of one MCP server, wherever each of them waits. */
function drawToolServer(r: R, server: string): RenderElement[] {
  const all = levelEdits(r.prefs, r.ctx.cwd, r.sw)
  const rows = toolsOf(r).filter(x => x.server === server)
  const out: RenderElement[] = [backButton(r), title(r, 'ts-name', `${server}（${rows.length} 个工具）`)]
  out.push(dim(r, 'ts-meta', 'MCP 服务的工具。每一行写着它排在哪一组；点开一个，可以改它怎么带、改写它的说明。'))
  out.push(scopeSelect(r, 'scope:toolserver', '改的是：'))
  if (rows.length === 0) {
    out.push(toolsLoadLine(r))
    out.push(dim(r, 'ts-gone', '最新读到的工具清单里没有这个服务的工具。'))
    return out
  }
  out.push(...listCard(r, 'tools-server', rows.map(x => toolListRow(r, all, x, true))))
  out.push(dim(r, 'ts-levels', LEVELS_NOTE))
  return out
}

/** One line per level: what it does to the tool, and which one the page writes. */
function toolLevelLines(r: R, all: ReturnType<typeof levelEdits>, name: string): RenderElement[] {
  return LEVELS.map(l => {
    const level = l === 'session' ? '本会话' : `${LEVEL_NAME[l]}默认`
    return dim(r, `t-lv-${l}`, `${level}：${toolLevelState(all[l], name)}${r.view.scope === l ? '  ← 现在改的是这一层' : ''}`)
  })
}

function drawTool(r: R, name: string): RenderElement[] {
  const { Button, Input } = r.ui
  const out: RenderElement[] = [backButton(r), title(r, 't-name', name)]
  const all = levelEdits(r.prefs, r.ctx.cwd, r.sw)
  const edits = all[r.view.scope]
  const row = toolRow(name, heldM.toolList, heldM.tools, edits)
  // where it stands in this session, whatever level the page is writing
  const now = toolRow(name, heldM.toolList, heldM.tools, all.session)
  out.push(dim(r, 't-meta', [toolOrigin(row) || (row.isMissing ? '这个会话里没有这个工具' : '来源还不知道'), sizeText(row.original)].filter(Boolean).join(' · ')))
  const by = now.place === undefined ? '引擎默认' : `${levelsText(levelsWhere(all, e => toolPlaceOf(e, name) === now.place))}定的`
  out.push(dim(r, 't-where', now.where === 'unknown' ? '按这个会话现在的设置：还不知道它排在哪，引擎还没把它的说明交给 Atlas。' : `按这个会话现在的设置：${WHERE_NAME[now.where]}（${by}）`))
  out.push(scopeSelect(r, 'scope:tool', '改的是：'))
  out.push(...toolLevelLines(r, all, name))
  if (name === TOOL_SEARCH) out.push(dim(r, 't-search', TOOL_SEARCH_NOTE))
  else {
    const engine = row.engineDeferred === null ? '引擎自己决定它排在哪（Atlas 还没见到）。' : `引擎自己的安排是：${row.engineDeferred ? '用到才加载' : '每次都带着'}。`
    const options = [
      { value: 'auto', label: '跟引擎默认', why: `这一层不管它。${engine}` },
      { value: 'pin', label: PLACE_NAME.pin, why: '它的说明和参数表每一轮都放进提示词，模型随时能直接用；它占的 tokens 每一轮都算。' },
      { value: 'defer', label: PLACE_NAME.defer, why: '提示词里只留它的名字；模型要用时先经 ToolSearch 加载它，多一步，平时不占地方。' },
      { value: 'off', label: PLACE_NAME.off, why: '它的名字还留在「可以加载」的工具清单里，但每次调用都会被拒绝，并且告诉模型这是你关的。' },
    ]
    const value = row.place ?? 'auto'
    out.push(choice(r, 't-place', isDesk(r) ? '怎么带这个工具' : '怎么带：', value, options, v => r.act.toolPlace(name, v === 'pin' || v === 'defer' || v === 'off' ? v : null)))
    // the desktop's card says what the chosen one means; the terminal's Select has no room for it
    if (!isDesk(r)) out.push(dim(r, 't-place-why', options.find(o => o.value === value)?.why ?? ''))
    const globalPlace = toolPlaceOf(all.global, name)
    if (r.view.scope === 'project' && globalPlace && !row.place) {
      out.push(dim(r, 't-global-place', `全局默认给它定了位置（${PLACE_NAME[globalPlace]}）：新会话是全局加项目两层叠加，项目这一层选「跟引擎默认」盖不掉它。想让本项目不一样，在这里直接选另外三种里的一种。`))
    }
  }
  const rewrite = toolRewriteOf(edits, name)
  const original = row.original
  if (row.kind === 'mcp' && row.engineDeferred === true) out.push(dim(r, 't-short', TOOL_SHORT_NOTE))
  if (rewrite !== undefined || original !== null) {
    out.push(
      actions(r, [
        rewrite === undefined
          ? original !== null && <Button key="t-rewrite" label="改写说明" onPress={() => r.act.toolRewrite(name, original)} />
          : <Button key="t-restore" label="恢复原文" onPress={() => r.act.toolRewrite(name, null)} />,
        original !== null && <Button key="t-copy" label="复制原文" onPress={press => r.act.copy(original, press.surface)} />,
      ]),
    )
  }
  if (rewrite !== undefined) {
    out.push(title(r, 't-rw-title', `改写后的说明（${sizeText(rewrite)}；回车保存，换行和输入框里一样）`))
    out.push(<Input key="t-rw" rows={Math.max(4, Math.min(24, r.rows - 16))} value={rewrite} submitLabel="保存" onSubmit={v => r.act.toolRewrite(name, v)} />)
  }
  const person = renameOf(edits)
  const swapped = person && row.sent !== null ? renameUser(row.sent, person).count : 0
  if (swapped) out.push(dim(r, 't-named', `发出去的时候，说明里的 the user 会写成 ${person}（${swapped} 处）。`))
  out.push(title(r, 't-orig-title', rewrite === undefined ? '说明（这一层没改写，用的是原文）' : '原文'))
  if (original === null) out.push(dim(r, 't-orig-none', row.isMissing ? '这个会话里没有这个工具，所以看不到它自己的说明。' : '还没见到它的说明：发一条消息之后，引擎才会把它交给 Atlas，那时才能改写。'))
  else out.push(sectionBox(r, 't-orig', original))
  if (r.view.scope !== 'session') out.push(dim(r, 't-scope-note', '改的是默认值：从下一个会话起生效，本会话不变。'))
  out.push(...toolsWhenLines(r))
  return out
}

// ---------- Hooks ----------

const HOOKS_NOTE =
  '关闭 = 把这个 hook 从 settings 文件里拿出来，由 Atlas 替你留着；开启时原样放回去。改动直接写进 settings 文件，一般马上生效，没生效就新开一个会话。'

function hookName(x: HookRow): string {
  return x.matcher ? `${x.event}（${x.matcher}）` : x.event
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function drawHooks(r: R): RenderElement[] {
  const { Box, Text, Button } = r.ui
  const m = r.manage.hooks
  const scan = heldM.hooks
  const status = m.status === 'loading' ? '正在读取…' : m.status === 'error' ? m.error ?? '没能读出 hooks' : m.atMs ? `读取于 ${fmtHM(m.atMs, r.tz)}` : '还没有读取'
  const out: RenderElement[] = [
    <Box key="h-load" flexDirection="row" gap={1} flexWrap="wrap">
      <Text key="h-load-text" dimColor={m.status !== 'error'} color={m.status === 'error' ? 'error' : undefined}>
        {fit(status, Math.max(10, r.cols - 24))}
      </Text>
      <Button key="h-reload" label="重新读取" onPress={() => r.act.hooksLoad()} />
      <Button key="hook-new" label="+ 新 hook" onPress={() => r.act.hookDraft()} />
    </Box>,
  ]
  if (r.manage.hooksUndo) {
    out.push(
      <Box key="h-undo-row" flexDirection="row" gap={1}>
        <Text key="h-undo-text" dimColor>
          {fit(`刚才：${r.manage.hooksUndo}`, Math.max(10, r.cols - 12))}
        </Text>
        <Button key="h-undo" label="撤销" onPress={() => r.act.hooksUndo()} />
      </Box>,
    )
  }
  if (!scan) return out
  const known = new Set(scan.files.map(f => f.path))
  for (const f of scan.files) {
    const rows = scan.rows.filter(x => x.file === f.path)
    const on = rows.filter(x => x.isOn).length
    out.push(title(r, `hf:${f.source}`, `${SOURCE_NAME[f.source]} · ${on} 个开着${rows.length > on ? ` · ${rows.length - on} 个关着` : ''}`))
    out.push(pathRow(r, `hf:${f.source}`, f.text === null && !f.unreadable ? `${sp(r, f.path)}（还没有这个文件）` : sp(r, f.path), f.path, false))
    if (f.error) {
      out.push(
        <Text key={`hf-err:${f.source}`} color="error">
          {fit(`读不懂这个文件：${f.error}`, r.cols)}
        </Text>,
      )
    }
    out.push(...listCard(r, `hooks:${f.source}`, rows.map(x => hookListRow(r, x))))
  }
  const strays = scan.rows.filter(x => !known.has(x.file))
  if (strays.length) {
    out.push(title(r, 'hf:stray', `别的项目里关着的 ${strays.length}`))
    out.push(...listCard(r, 'hooks:stray', strays.map(x => hookListRow(r, x, sp(r, x.file)))))
  }
  if (scan.rows.length === 0) out.push(dim(r, 'h-none', '这几个 settings 文件里都没有 hook。'))
  out.push(dim(r, 'h-note', HOOKS_NOTE))
  out.push(dim(r, 'h-scope', '这里管的是 settings 文件里的 hook；插件和 mod 自带的 hook 跟着插件走，在这里不显示。'))
  return out
}

function hookListRow(r: R, x: HookRow, where?: string): RenderElement {
  const fires = x.isOn ? firesText(x.event) : ''
  const chips: Chip[] = [...(x.isOn ? [] : [{ text: '已关闭', tone: 'off' as const }]), ...(x.type === 'command' ? [] : [{ text: x.type, tone: 'note' as const }])]
  const tail = [oneLine(x.body), fires, where ?? ''].filter(Boolean).join(' · ')
  return rowButton(r, `hook:${x.id}`, hookName(x), tail, go(r, { kind: 'hook', id: x.id }, `hook:${x.id}`), x.isOn ? undefined : 'dim', chips)
}

function drawHook(r: R, id: string): RenderElement[] {
  const { Button, Input, Text } = r.ui
  const out: RenderElement[] = [backButton(r)]
  const x = heldM.hooks?.rows.find(h => h.id === id)
  if (!x) {
    out.push(dim(r, 'hk-gone', r.manage.hooks.status === 'loading' ? '正在读取…' : '这个 hook 不在最新读到的列表里了。'))
    return out
  }
  out.push(title(r, 'hk-title', hookName(x)))
  out.push(dim(r, 'hk-meta', [x.source ? SOURCE_NAME[x.source] : '别的项目', x.type, x.isOn ? '开着' : '已关闭（Atlas 替你留着）', x.isOn ? firesText(x.event) : ''].filter(Boolean).join(' · ')))
  out.push(pathRow(r, 'hk-file', sp(r, x.file), x.file, false))
  const pendingKey = `hk-del:${id}`
  const isPending = r.view.pending === pendingKey
  out.push(
    actions(r, [
      <Button key="hk-toggle" label={x.isOn ? '关闭' : '开启'} variant="primary" onPress={() => r.act.hookToggle(id)} />,
      isPending ? (
        <Button key="hk-delok" label="确认删除（不进回收站，可撤销一次）" onPress={() => r.act.hookDelete(id)} />
      ) : (
        <Button key="hk-del" label="删除" onPress={() => r.act.pending(pendingKey)} />
      ),
      isPending && <Button key="hk-delno" label="取消" onPress={() => r.act.pending(null)} />,
      <Button key="hk-copy" label="复制内容" onPress={press => r.act.copy(x.body, press.surface)} />,
    ]),
  )
  const bodyLabel = x.type === 'command' ? 'command' : x.type === 'http' ? 'url' : 'prompt'
  if (x.isOn) {
    out.push(<Input key="hk-matcher" label="matcher " value={x.matcher} placeholder="留空 = 每次都触发" submitLabel="保存" onSubmit={v => r.act.hookSave(id, { matcher: v.trim() })} />)
    out.push(title(r, 'hk-body-title', `${bodyLabel}（回车保存）`))
    out.push(<Input key="hk-body" rows={Math.max(3, Math.min(10, x.body.split('\n').length + 1))} value={x.body} submitLabel="保存" onSubmit={v => r.act.hookSave(id, { body: v })} />)
    out.push(<Input key="hk-timeout" label="timeout（秒） " value={x.timeout === null ? '' : String(x.timeout)} placeholder="留空 = 默认" submitLabel="保存" onSubmit={v => r.act.hookSave(id, { timeout: v })} />)
  } else {
    if (x.matcher) out.push(dim(r, 'hk-matcher-off', `matcher：${x.matcher}`))
    out.push(title(r, 'hk-body-title', bodyLabel))
    out.push(
      <Text key="hk-body-off" wrap="wrap">
        {x.body}
      </Text>,
    )
    out.push(dim(r, 'hk-off-note', '关着的 hook 要先开启才能改。'))
  }
  const script = x.type === 'command' ? scriptPath(x.body, r.home, r.ctx.cwd) : null
  if (script) out.push(rowButton(r, 'hk-script', `看它跑的脚本：${sp(r, script)}`, '', go(r, { kind: 'file', path: script }, 'hk-script')))
  out.push(dim(r, 'hk-note', HOOKS_NOTE))
  return out
}

function drawHookNew(r: R): RenderElement[] {
  const { Button, Input, Select } = r.ui
  const out: RenderElement[] = [backButton(r), title(r, 'hd-title', '新 hook')]
  const d = r.view.hookDraft
  if (!d) {
    out.push(dim(r, 'hd-none', '没有正在写的 hook。'))
    return out
  }
  const set = (patch: Partial<typeof d>) => r.act.view(v => (v.hookDraft ? { ...v, hookDraft: { ...v.hookDraft, ...patch } } : v))
  const files = settingsFiles(r.ctx)
  out.push(
    <Select
      key="hd-file"
      label="写到："
      value={d.file}
      options={files.map(f => ({ value: f.path, label: `${SOURCE_NAME[f.source]} · ${sp(r, f.path)}` }))}
      onSelect={v => set({ file: v })}
    />,
  )
  out.push(<Select key="hd-event" label="事件：" value={d.event} options={HOOK_EVENTS.map(e => ({ value: e, label: e }))} onSelect={v => set({ event: v })} />)
  out.push(<Input key="hd-matcher" label="matcher " value={d.matcher} placeholder="留空 = 每次都触发；比如 Bash 或 Edit|Write" onInput={v => set({ matcher: v })} onSubmit={v => set({ matcher: v })} />)
  out.push(title(r, 'hd-command-title', 'command（到点要跑的 shell 命令）'))
  out.push(<Input key="hd-command" rows={4} value={d.command} placeholder="比如：bash ~/.claude/hooks/my-hook.sh" onInput={v => set({ command: v })} onSubmit={v => set({ command: v })} />)
  out.push(<Input key="hd-timeout" label="timeout（秒） " value={d.timeout} placeholder="留空 = 默认" onInput={v => set({ timeout: v })} onSubmit={v => set({ timeout: v })} />)
  out.push(
    actions(r, [
      <Button key="hd-add" label="添加" variant="primary" onPress={() => r.act.hookAdd()} />,
      <Button key="hd-clear" label="清空重写" onPress={() => r.act.view(v => ({ ...v, hookDraft: v.hookDraft ? { ...v.hookDraft, matcher: '', command: '', timeout: '' } : v.hookDraft }))} />,
    ]),
  )
  out.push(dim(r, 'hd-note', 'hook 是到点自动跑的命令，跑的时候不会再问你；只加你看得懂、信得过的命令。'))
  return out
}

// ---------- 体检 ----------

function issueTarget(r: R, i: Issue): AtlasRoute | null {
  const fileKinds = ['orphan', 'no-frontmatter', 'same-title']
  if (fileKinds.includes(i.kind) && i.path.endsWith('.md')) return { kind: 'file', path: i.path }
  if (i.projectSlug && core.projectBySlug(i.projectSlug)) return { kind: 'project', slug: i.projectSlug }
  if (i.path.endsWith('.md')) return { kind: 'file', path: i.path }
  const c = r.idx.customMemory.find(x => isInside(i.path, x.path))
  return c ? { kind: 'custom', name: c.name } : null
}

function fixButton(r: R, i: Issue, n: number): RenderElement | null {
  const { Button } = r.ui
  const key = `fix:${n}`
  switch (i.kind) {
    case 'orphan':
      return <Button key={key} label="加入索引" onPress={() => r.act.fixOrphan(i)} />
    case 'dead-link':
      return core.deadLinkName(i) ? <Button key={key} label="删掉这条链接" onPress={() => r.act.fixDeadLink(i)} /> : null
    case 'no-index':
      return <Button key={key} label="生成 MEMORY.md" onPress={() => r.act.fixNoIndex(i)} />
    case 'no-frontmatter':
      return <Button key={key} label="补 frontmatter" onPress={() => r.act.fixFrontmatter(i.path, key)} />
    case 'index-over-limit': {
      const p = i.projectSlug ? core.projectBySlug(i.projectSlug) : undefined
      const path = p?.index?.path ?? (i.path.endsWith('MEMORY.md') ? i.path : null)
      return path ? (
        <Button key={key} label="打开第 201 行" onPress={() => r.act.openAt(path, 200, key)} />
      ) : null
    }
    case 'same-title':
      return <Button key={key} label="在整理看板里看" onPress={() => r.act.sameTitle(i)} />
    default:
      return null
  }
}

function drawHealth(r: R): RenderElement[] {
  const { Box, Text } = r.ui
  const out: RenderElement[] = []
  const all = r.idx.health
  if (all.length === 0) out.push(dim(r, 'h-none', '没有发现问题'))
  let n = 0
  for (const sev of ['error', 'warn', 'info'] as const) {
    const list = all.filter(i => i.severity === sev)
    if (!list.length) continue
    out.push(title(r, `h:${sev}`, `${SEVERITY[sev]} ${list.length}`))
    const shown = list.slice(0, limitOf(r, `h:${sev}`, 40))
    for (const i of shown) {
      const k = n++
      const target = issueTarget(r, i)
      const color = sev === 'error' ? 'error' : sev === 'warn' ? 'warning' : undefined
      const label = i.projectSlug ? `${core.projectBySlug(i.projectSlug)?.label ?? i.projectSlug} · ${i.message}` : i.message
      const fix = fixButton(r, i, k)
      const line = target
        ? rowButton({ ...r, cols: Math.max(20, r.cols - (fix ? 16 : 0)) }, `issue:${k}`, label, sp(r, i.path), go(r, target, `issue:${k}`), sev === 'error' ? 'strong' : undefined)
        : (
            <Text key={`issue:${k}`} color={color}>
              {fit(`${label} ${sp(r, i.path)}`, r.cols - (fix ? 16 : 0))}
            </Text>
          )
      out.push(
        <Box key={`issue-row:${k}`} flexDirection="row" gap={1}>
          {line}
          {fix}
        </Box>,
      )
    }
    const m = more(r, `h:${sev}`, list.length, shown.length, 40)
    if (m) out.push(m)
  }
  if (r.idx.warnings.length) {
    out.push(title(r, 'h-warn', `扫描警告 ${r.idx.warnings.length}`))
    r.idx.warnings.slice(0, 10).forEach((w, i) => out.push(dim(r, `hw:${i}`, w)))
  }
  return out
}

// ---------- delete / archive in the file view ----------

function fileDeleteArchive(r: R, path: string, info: ReturnType<typeof core.editInfo>): RenderElement[] {
  const { Button } = r.ui
  const out: RenderElement[] = []
  const name = basename(path)
  const project = r.idx.projects.find(p => p.memoryDir && isInside(path, p.memoryDir))
  const isProjectMemory = Boolean(project) && info.isMemory && !info.isIndexFile
  const isCustomMemory = info.isMemory && !project && name !== 'MEMORY.md'
  const isProjectClaudeMd = r.idx.projects.some(p => {
    const c = p.resolvedCwd ?? p.cwd
    return c ? core.projectClaudeMdPaths(c).includes(path) : false
  })
  const mf = project?.memoryFiles.find(f => f.path === path)
  if (isProjectMemory && project && !(mf as { symlinkTo?: string | null } | undefined)?.symlinkTo) {
    out.push(title(r, 'f-archive-title', '归档（不删除）'))
    out.push(
      <Button
        key="f-archive"
        label={`归档到 memory-archive/${project.label}/`}
        plain
        onPress={() => r.act.archiveMemory(path, project.label)}
      />,
    )
    out.push(dim(r, 'f-archive-note', '归档：移进 memory-archive 永久保留，并从 MEMORY.md 去掉。'))
  }
  if (isProjectMemory || isCustomMemory || isProjectClaudeMd) {
    out.push(title(r, 'f-delete-title', '删除（进回收站）'))
    const kind = isProjectClaudeMd ? 'project-claude-md' : undefined
    out.push(...deleteControl(r, `file:${path}`, [path], name, kind, isProjectMemory ? '会一起从 MEMORY.md 去掉；恢复时放回去。' : undefined))
  }
  return out
}

// ---------- 结构 ----------

function structureModes(r: R): RenderElement {
  const { Button } = r.ui
  return actions(r, [
    <Button
      key="smode:tree"
      label="文档树"
      variant={r.view.structureMode === 'tree' ? 'primary' : 'secondary'}
      onPress={() => r.act.view(v => ({ ...v, structureMode: 'tree' }))}
    />,
    <Button
      key="smode:cross"
      label="交织"
      variant={r.view.structureMode === 'cross' ? 'primary' : 'secondary'}
      onPress={() => r.act.view(v => ({ ...v, structureMode: 'cross' }))}
    />,
  ])
}

function drawStructure(r: R): RenderElement[] {
  const out: RenderElement[] = [structureModes(r)]
  if (!r.idx.docs) {
    out.push(dim(r, 'no-docs', '这份扫描结果没有文档树（atlas.py 需要 version 2）。'))
    return out
  }
  return r.view.structureMode === 'cross' ? [...out, ...drawCross(r)] : [...out, ...drawTree(r)]
}

const TREE_CAP = 300

function drawTree(r: R): RenderElement[] {
  const { Select, Box, Button, Text } = r.ui
  const out: RenderElement[] = []
  const cur = r.idx.projects.find(p => p.isCurrent)
  const slug = r.view.treeSlug ?? cur?.slug ?? r.idx.projects[0]?.slug ?? ''
  const withDocs = r.idx.projects.filter(p => p.isCurrent || (r.idx.docs?.nodes ?? []).some(n => n.projectSlug === p.slug))
  if (withDocs.length) {
    out.push(
      <Select
        key="tree-project"
        label="项目："
        value={slug}
        options={withDocs.map(p => ({ value: p.slug, label: p.isCurrent ? `${p.label}（本会话）` : p.label }))}
        onSelect={v => r.act.view(x => ({ ...x, treeSlug: v }))}
      />,
    )
  }
  if (r.idx.docs?.truncated) out.push(dim(r, 'tree-trunc', '文档太多，只收了前 4000 个节点。'))
  const maps = docMaps(r.idx)
  const roots = treeRoots(r.idx, slug)
  if (roots.length === 0) out.push(dim(r, 'tree-empty', '这个项目没有 CLAUDE.md 或 MEMORY.md'))
  const toggled = new Set(r.view.treeToggled)
  let rows = 0
  const walk = (node: DocNode, edgeType: string | null, prefix: string, isLast: boolean, depth: number, ancestors: readonly string[], addr: string) => {
    if (rows >= TREE_CAP) return
    rows++
    const isCycle = ancestors.includes(node.id)
    const kids = isCycle ? [] : maps.out.get(node.id) ?? []
    const isOpen = kids.length > 0 && (depth === 0) !== toggled.has(node.id)
    const glyph = depth === 0 ? '' : isLast ? '└─ ' : '├─ '
    const marks = [
      edgeType ? EDGE_TAG[edgeType] ?? edgeType : '',
      node.isSymlink ? `↪ ${sp(r, node.realPath)}` : '',
      node.exists ? '' : '（不存在）',
      isCycle ? '（循环）' : '',
    ]
      .filter(Boolean)
      .join(' ')
    const name = node.title || basename(node.path)
    const room = Math.max(8, r.cols - cellWidth(prefix + glyph) - 30)
    out.push(
      <Box key={`tree:${addr}`} flexDirection="row" gap={1}>
        <Text key={`tg:${addr}`} dimColor>
          {prefix + glyph}
        </Text>
        {kids.length ? (
          <Button key={`tog:${addr}`} label={isOpen ? '▾' : '▸'} plain onPress={() => r.act.view(v => ({ ...v, treeToggled: v.treeToggled.includes(node.id) ? v.treeToggled.filter(x => x !== node.id) : [...v.treeToggled, node.id] }))} />
        ) : null}
        <Button key={`node:${addr}`} label={fit(name, room)} plain dimColor={!node.exists} onPress={() => (node.exists ? r.act.push({ kind: 'file', path: node.path, from: `node:${addr}` }) : undefined)} />
        {marks ? (
          <Text key={`tm:${addr}`} dimColor>
            {fit(marks, Math.max(6, room))}
          </Text>
        ) : null}
        <Button key={`open:${addr}`} label="打开" onPress={() => r.act.reveal(node.exists ? node.path : node.realPath)} />
        <Button key={`copy:${addr}`} label="复制路径" onPress={press => r.act.copy(node.path, press.surface)} />
      </Box>,
    )
    if (!isOpen) return
    const childPrefix = depth === 0 ? '' : prefix + (isLast ? '   ' : '│  ')
    kids.forEach((e, i) => {
      const child = maps.byId.get(e.to)
      if (!child) return
      walk(child, e.type, childPrefix, i === kids.length - 1, depth + 1, [...ancestors, node.id], `${addr}.${i}`)
    })
  }
  roots.forEach((root, i) => walk(root, null, '', i === roots.length - 1, 0, [], String(i)))
  if (rows >= TREE_CAP) out.push(dim(r, 'tree-cap', `只画了前 ${TREE_CAP} 行；收起一些节点再看。`))
  return out
}

function drawCross(r: R): RenderElement[] {
  const ui = r.ui as UI & { Svg?: Elements['desktop']['Svg'] }
  const edges = r.idx.crossProject ?? []
  const out: RenderElement[] = []
  if (edges.length === 0) {
    out.push(dim(r, 'cross-none', '项目之间没有交叉引用。'))
    return out
  }
  const Svg = r.surface === 'desktop' ? ui.Svg : undefined
  if (Svg) {
    const source = crossSvg(r.idx, edges)
    out.push(
      <Svg
        key="cross-svg"
        source={source}
        alt={`项目交织图：${edges.length} 条跨项目引用`}
        width={Math.min(640, Math.max(320, r.cols * 7))}
        isInteractive
      />,
    )
  }
  out.push(title(r, 'cross-list', `跨项目引用 ${edges.length}`))
  const shown = edges.slice(0, limitOf(r, 'cross', 50))
  shown.forEach((e, i) => {
    const text = `${scopeLabel(r.idx, e.from)} → ${scopeLabel(r.idx, e.to)} · ${EDGE_TAG[e.kind] ?? e.kind} · ${e.count}`
    if (isProjectKey(r.idx, e.from)) out.push(rowButton(r, `cross:${i}`, text, '', go(r, { kind: 'project', slug: e.from }, `cross:${i}`)))
    else out.push(dim(r, `cross:${i}`, text))
  })
  const m = more(r, 'cross', edges.length, shown.length, 50)
  if (m) out.push(m)
  return out
}

// ---------- 回收站 ----------

function drawTrash(r: R): RenderElement[] {
  const { Box, Button, Select, Text } = r.ui
  const out: RenderElement[] = []
  const t = r.trash
  const bytes = t.status === 'ready' ? t.bytes : r.idx.trash?.bytes ?? 0
  out.push(title(r, 'trash-total', `回收站占用 ${fmtSize(bytes)}`))
  // how long a deleted thing is kept from now on: this machine's default, for every session and project
  const keep = r.trashDays
  out.push(
    choice(
      r,
      'trash-keep',
      '以后删除的东西保留多久：',
      (TRASH_DAYS as readonly string[]).includes(keep) ? keep : '',
      [
        ...((TRASH_DAYS as readonly string[]).includes(keep) ? [] : [{ value: '', label: keepLabel(keep), short: keepShort(keep), why: `现在是${keepLabel(keep)}（插件设置里填的）。选一项就改成这台电脑的默认值。` }]),
        ...TRASH_DAYS.map(d => ({
          value: d,
          label: keepLabel(d),
          short: keepShort(d),
          why:
            d === NEVER
              ? '删除的东西一直留在回收站，只有你点「清空」才会消失。这台电脑的所有会话都用这个默认值；每次删除时还能单独改。'
              : `删除后保留 ${d} 天，到期自动清空。这台电脑的所有会话都用这个默认值；每次删除时还能单独改。`,
        })),
      ],
      v => {
        if (v) r.act.trashDefault(v)
      },
    ),
  )
  out.push(dim(r, 'trash-auto', '到期的东西会自动清空：开着带 Atlas 的会话时，每 6 小时检查一次。'))
  out.push(dim(r, 'trash-auto-2', '改默认值只管以后删除的；已经在回收站里的各按各的，可以在下面逐项改。'))
  if (t.status === 'ready' && t.items.length > 0) {
    const isAll = r.view.pending === 'purge:all'
    out.push(
      <Box key="trash-all-row" flexDirection="row" gap={1} flexWrap="wrap">
        {isAll ? (
          <Button key="purgeallok" label={`确认永久删除全部 ${t.items.length} 项`} variant="primary" onPress={() => r.act.purgeAll()} />
        ) : (
          <Button key="purgeall" label="清空回收站" onPress={() => r.act.pending('purge:all')} />
        )}
        {isAll ? <Button key="purgeallno" label="取消" onPress={() => r.act.pending(null)} /> : null}
      </Box>,
    )
  }
  if (t.status === 'loading') out.push(dim(r, 'trash-loading', '正在读回收站…'))
  if (t.status === 'error' && t.error) {
    out.push(
      <Text key="trash-error" color="error">
        {fit(t.error, r.cols)}
      </Text>,
    )
  }
  if (t.status === 'ready' && t.items.length === 0) out.push(dim(r, 'trash-empty', '回收站是空的'))
  for (const it of t.items) {
    out.push(title(r, `ti:${it.id}`, `${it.label}（${it.kind}）`))
    out.push(dim(r, `tm:${it.id}`, `${fmtSize(it.sizeBytes)} · ${fmtMD(it.deletedAtMs, r.tz)} 删除 · ${it.expiresAtMs > 0 ? `${fmtMD(it.expiresAtMs, r.tz)} 自动清空` : '不会自动清空'}`))
    out.push(dim(r, `tp:${it.id}`, `原位置：${sp(r, it.originalPath)}${it.exists ? '' : '（内容已不在）'}`))
    const pendingKey = `purge:${it.id}`
    const isPending = r.view.pending === pendingKey
    out.push(
      <Box key={`ta:${it.id}`} flexDirection="row" gap={1} flexWrap="wrap">
        <Button key={`restore:${it.id}`} label="恢复" onPress={() => r.act.restore([it.id])} />
        {isPending ? (
          <Button key={`purgeok:${it.id}`} label="确认永久删除" variant="primary" onPress={() => r.act.purgeNow(it.id)} />
        ) : (
          <Button key={`purge:${it.id}`} label="立即清空" onPress={() => r.act.pending(pendingKey)} />
        )}
        {isPending ? <Button key={`purgeno:${it.id}`} label="取消" onPress={() => r.act.pending(null)} /> : null}
        <Select
          key={`expiry:${it.id}`}
          label="改保存时间"
          options={TRASH_DAYS.map(d => ({ value: d, label: keepShort(d) }))}
          onSelect={v => r.act.setExpiry(it.id, v)}
        />
      </Box>,
    )
  }
  const big = [...r.idx.projects].filter(p => (p.diskBytes ?? 0) > 0).sort((a, b) => (b.diskBytes ?? 0) - (a.diskBytes ?? 0))
  if (big.length) {
    out.push(title(r, 'disk-title', '占用最多的项目（Claude 数据）'))
    const shown = big.slice(0, limitOf(r, 'disk', 10))
    for (const p of shown) out.push(rowButton(r, `disk:${p.slug}`, p.label, fmtSize(p.diskBytes ?? 0), go(r, { kind: 'project', slug: p.slug }, `disk:${p.slug}`)))
    const m = more(r, 'disk', big.length, shown.length, 10)
    if (m) out.push(m)
  }
  const ws = r.idx.scratchWorkspaces ?? []
  if (ws.length) {
    out.push(title(r, 'ws-title', `临时工作区 ${ws.length}`))
    const shown = [...ws].sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, limitOf(r, 'ws', 10))
    shown.forEach((w, i) => {
      out.push(pathRow(r, `ws:${i}`, `${sp(r, w.path)}  ${fmtSize(w.sizeBytes)} · ${fmtMD(w.mtimeMs, r.tz)}`, w.path, true))
      if (!w.sessionIds.includes(r.ctx.sessionId)) out.push(...deleteControl(r, `ws:${w.path}`, [w.path], `临时工作区 ${basename(w.path)}`, 'scratch-workspace'))
      else out.push(dim(r, `ws-cur:${i}`, '当前会话在用，不能删除'))
    })
    const m = more(r, 'ws', ws.length, shown.length, 10)
    if (m) out.push(m)
  }
  return out
}
