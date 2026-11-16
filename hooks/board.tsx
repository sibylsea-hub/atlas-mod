// atlas: a drag-and-drop board drawn by a Client. Columns side by side when
// each gets 24 cells, else stacked; one row per card, a header row per
// column, so a pointer's (x, y) is hit-tested from the props alone.
//
// Posts to the hooks module: { type: 'drop', card, from, to, index },
// { type: 'merge', card, onto }, { type: 'reorder', column, order },
// { type: 'open', card }; each also carries `board`.
// A press on a card Button selects it (`已选中`), a press on a column header
// drops the selected card there: the path for surfaces that send no pointer.

import type { ClientKeyEvent, ClientModule, ClientPointerEvent, ClientSurface, JsonValue, RenderElement } from 'claude-code'

type Card = { id: string; kind: string; label: string; hint?: string; badge?: string }
type Column = { id: string; title: string; subtitle?: string; accepts?: string[]; cards: Card[] }
type BoardProps = {
  boardId: string
  columns: Column[]
  allowMerge: boolean
  allowReorder: boolean
  page: number
  pageSize: number
  /**
   * Draw each column as a block of coloured paper (the desktop, under a skin that has sheets): a deeper
   * strip for its heading, a pale sheet of the same colour under its cards, the columns taking `sheets`
   * in turn. Colours only, with the skin's own dark ink: a row stays one cell tall, so the pointer's
   * hit-test (which counts rows) holds. Absent, plain rows.
   */
  paper?: { sheets: readonly { head: string; body: string }[]; ink: string; inkSoft: string }
}

type Drag = { card: string; from: string; sx: number; sy: number; x: number; y: number; moved: boolean }
type S = {
  box: { props: BoardProps; at: number }
  sel: { card: string; col: string } | null
  drag: Drag | null
  lastClick: { card: string; at: number } | null
}

const MIN_COL = 24

function wide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

function cut(s: string, cols: number): string {
  const flat = s.replace(/[\r\n\t]+/g, ' ')
  let w = 0
  let out = ''
  for (const ch of flat) {
    const cw = wide(ch.codePointAt(0) ?? 0) ? 2 : 1
    if (w + cw > cols) return cols > 0 ? out.replace(/.$/u, '…') : ''
    out += ch
    w += cw
  }
  return out
}

function cells(s: string): number {
  let w = 0
  for (const ch of s) w += wide(ch.codePointAt(0) ?? 0) ? 2 : 1
  return w
}

export type Layout = {
  isRow: boolean
  colWidth: number
  blocks: { x0: number; y0: number }[]
  height: number
}

/** Where each column sits in the region, from the props and its width. */
export function layoutBoard(p: BoardProps, width: number): Layout {
  const n = p.columns.length
  const isRow = n > 0 && width >= MIN_COL * n
  const colWidth = isRow ? Math.floor(width / n) : Math.max(1, width)
  const blockRows = p.pageSize + (isRow ? 1 : 2)
  const blocks = p.columns.map((_, i) => (isRow ? { x0: i * colWidth, y0: 0 } : { x0: 0, y0: i * blockRows }))
  return { isRow, colWidth, blocks, height: isRow ? p.pageSize + 1 : Math.max(0, n * blockRows - 1) }
}

/** The rows a board of these columns needs at this width. */
export function boardHeight(columns: number, pageSize: number, width: number): number {
  const isRow = columns > 0 && width >= MIN_COL * columns
  return isRow ? pageSize + 1 : Math.max(1, columns * (pageSize + 2) - 1)
}

function visible(p: BoardProps, col: Column): Card[] {
  const start = p.page * p.pageSize
  return col.cards.slice(start, start + p.pageSize)
}

type Hit = { col: number; slot: number | null }

/** The column and card slot under a cell; slot null on the header row. */
function hitTest(p: BoardProps, width: number, x: number, y: number): Hit | null {
  const lay = layoutBoard(p, width)
  for (let i = 0; i < lay.blocks.length; i++) {
    const b = lay.blocks[i]
    if (!b) continue
    const inX = lay.isRow ? x >= b.x0 && x < b.x0 + lay.colWidth : x >= 0 && x < width
    if (!inX) continue
    const dy = y - b.y0
    if (dy === 0) return { col: i, slot: null }
    if (dy >= 1 && dy <= p.pageSize) return { col: i, slot: dy - 1 }
  }
  return null
}

function findCard(p: BoardProps, id: string): { col: Column; card: Card; at: number } | null {
  for (const col of p.columns) {
    const at = col.cards.findIndex(c => c.id === id)
    const card = col.cards[at]
    if (card) return { col, card, at }
  }
  return null
}

type Outcome =
  | { type: 'drop'; card: string; from: string; to: string; index: number; text: string }
  | { type: 'merge'; card: string; onto: string; text: string }
  | { type: 'reorder'; column: string; order: string[]; text: string }

/** What letting go of `card` at (x, y) would do; null cancels. */
function outcome(p: BoardProps, width: number, card: string, x: number, y: number): Outcome | null {
  const src = findCard(p, card)
  const hit = hitTest(p, width, x, y)
  if (!src || !hit) return null
  const col = p.columns[hit.col]
  if (!col) return null
  const shown = visible(p, col)
  const over = hit.slot === null ? undefined : shown[hit.slot]
  if (col.id === src.col.id) {
    if (!p.allowReorder || hit.slot === null) return null
    const order = col.cards.map(c => c.id).filter(id => id !== card)
    const index = Math.min(p.page * p.pageSize + hit.slot, order.length)
    order.splice(index, 0, card)
    if (order.join('\n') === col.cards.map(c => c.id).join('\n')) return null
    return { type: 'reorder', column: col.id, order, text: `排到第 ${index + 1} 位` }
  }
  if (col.accepts && !col.accepts.includes(src.card.kind)) return null
  if (p.allowMerge && over && over.kind === src.card.kind) {
    return { type: 'merge', card, onto: over.id, text: `合并到 ${over.label}` }
  }
  const index = hit.slot === null ? col.cards.length : Math.min(p.page * p.pageSize + hit.slot, col.cards.length)
  return { type: 'drop', card, from: src.col.id, to: col.id, index, text: `移到 ${col.title}` }
}

function post(surface: ClientSurface<S>, p: BoardProps, data: Record<string, JsonValue>): void {
  surface.post({ ...data, board: p.boardId })
}

function now(): number {
  return Date.now()
}

function onPointer(surface: ClientSurface<S>, ev: ClientPointerEvent): void {
  const st = surface.state
  if (!st) return
  const p = st.box.props
  if (ev.type === 'down') {
    if (ev.button !== undefined && ev.button !== 'left') return
    const hit = hitTest(p, surface.columns, ev.x, ev.y)
    const col = hit ? p.columns[hit.col] : undefined
    const card = hit && col && hit.slot !== null ? visible(p, col)[hit.slot] : undefined
    if (!card || !col) return
    surface.setState({ ...st, drag: { card: card.id, from: col.id, sx: ev.x, sy: ev.y, x: ev.x, y: ev.y, moved: false } })
    return
  }
  const drag = st.drag
  if (!drag) return
  if (ev.type === 'move') {
    const moved = drag.moved || Math.abs(ev.x - drag.sx) + Math.abs(ev.y - drag.sy) >= 1
    if (ev.x === drag.x && ev.y === drag.y && moved === drag.moved) return
    surface.setState({ ...st, drag: { ...drag, x: ev.x, y: ev.y, moved } })
    return
  }
  if (ev.type === 'up') {
    const moved = drag.moved || Math.abs(ev.x - drag.sx) + Math.abs(ev.y - drag.sy) >= 1
    if (!moved) {
      surface.setState({ ...st, drag: null, lastClick: { card: drag.card, at: now() } })
      post(surface, p, { type: 'open', card: drag.card })
      return
    }
    const out = outcome(p, surface.columns, drag.card, ev.x, ev.y)
    surface.setState({ ...st, drag: null, sel: null })
    if (!out) return
    if (out.type === 'drop') post(surface, p, { type: 'drop', card: out.card, from: out.from, to: out.to, index: out.index })
    else if (out.type === 'merge') post(surface, p, { type: 'merge', card: out.card, onto: out.onto })
    else post(surface, p, { type: 'reorder', column: out.column, order: out.order })
    return
  }
  if (ev.type === 'leave' && ev.button === undefined) {
    // a hover leave with nothing held changes nothing
  }
}

function onKey(surface: ClientSurface<S>, ev: ClientKeyEvent): void {
  const st = surface.state
  if (!st) return
  const p = st.box.props
  const cols = p.columns.filter(c => visible(p, c).length > 0)
  if (cols.length === 0) return
  const cur = st.sel ? findCard(p, st.sel.card) : null
  if (ev.key === 'return') {
    if (cur) post(surface, p, { type: 'open', card: cur.card.id })
    return
  }
  let ci = cur ? Math.max(0, cols.findIndex(c => c.id === cur.col.id)) : 0
  let ri = cur ? Math.max(0, visible(p, cur.col).findIndex(c => c.id === cur.card.id)) : 0
  if (cur) {
    if (ev.key === 'up') ri -= 1
    else if (ev.key === 'down') ri += 1
    else if (ev.key === 'left') ci -= 1
    else if (ev.key === 'right') ci += 1
    else return
  } else if (!['up', 'down', 'left', 'right'].includes(ev.key)) return
  ci = Math.min(Math.max(ci, 0), cols.length - 1)
  const col = cols[ci]
  if (!col) return
  const shown = visible(p, col)
  ri = Math.min(Math.max(ri, 0), shown.length - 1)
  const card = shown[ri]
  if (card) surface.setState({ ...st, sel: { card: card.id, col: col.id } })
}

function pressCard(surface: ClientSurface<S>, card: string, col: string): void {
  const st = surface.state
  if (!st) return
  const p = st.box.props
  if (st.lastClick && st.lastClick.card === card && now() - st.lastClick.at < 600) return
  if (st.sel && st.sel.card === card) {
    surface.setState({ ...st, sel: null })
    post(surface, p, { type: 'open', card })
    return
  }
  surface.setState({ ...st, sel: { card, col } })
}

function pressHeader(surface: ClientSurface<S>, colId: string): void {
  const st = surface.state
  if (!st || !st.sel) return
  const p = st.box.props
  const src = findCard(p, st.sel.card)
  const col = p.columns.find(c => c.id === colId)
  surface.setState({ ...st, sel: null })
  if (!src || !col || src.col.id === col.id) return
  if (col.accepts && !col.accepts.includes(src.card.kind)) return
  post(surface, p, { type: 'drop', card: src.card.id, from: src.col.id, to: col.id, index: col.cards.length })
}

const Board: ClientModule<BoardProps, S> = (props, surface): RenderElement => {
  const { Box, Text, Button } = surface.elements
  if (surface.state === undefined) {
    surface.onPointer(ev => onPointer(surface, ev))
    surface.onKey(ev => onKey(surface, ev))
    surface.setState({ box: { props, at: 0 }, sel: null, drag: null, lastClick: null })
  } else {
    surface.state.box.props = props
  }
  const st = surface.state
  const width = surface.columns > 0 ? surface.columns : 80
  const lay = layoutBoard(props, width)
  const drag = st?.drag?.moved ? st.drag : null
  const target = drag ? outcome(props, width, drag.card, drag.x, drag.y) : null
  const hoverCol = drag ? hitTest(props, width, drag.x, drag.y)?.col ?? -1 : -1
  const sel = st?.sel?.card ?? null

  const column = (col: Column, i: number): RenderElement => {
    const w = lay.colWidth - (lay.isRow ? 1 : 0)
    const paper = props.paper && props.paper.sheets.length > 0 ? props.paper : null
    const sheet = paper ? paper.sheets[i % paper.sheets.length] ?? null : null
    const INK = paper?.ink
    const INK_SOFT = paper?.inkSoft
    const shown = visible(props, col)
    const isHover = i === hoverCol && target !== null && target.type !== 'merge'
    const count = `${col.cards.length}`
    const head = cut(col.title, Math.max(1, w - cells(count) - 2))
    const rows: RenderElement[] = []
    for (let k = 0; k < props.pageSize; k++) {
      const card = shown[k]
      if (!card) {
        rows.push(
          sheet ? (
            <Box key={`emptyrow:${col.id}:${k}`} flexDirection="row" width={w} backgroundColor={sheet.body}>
              <Text key={`empty:${col.id}:${k}`} color={sheet.head}>
                {k === shown.length ? '  ┄ 空位：把卡片拖到这里' : ' '}
              </Text>
            </Box>
          ) : (
            <Text key={`empty:${col.id}:${k}`}> </Text>
          ),
        )
        continue
      }
      const isSel = sel === card.id
      const isMergeTarget = target?.type === 'merge' && target.onto === card.id
      const mark = isSel ? '▸ ' : '  '
      const tail = isSel ? ' 已选中' : `${card.badge ? ` ${card.badge}` : ''}${card.hint ? ` ${card.hint}` : ''}`
      const labelRoom = Math.max(4, w - 2 - Math.min(cells(tail), Math.floor(w / 2)))
      const label = cut(card.label, labelRoom)
      const rest = cut(tail, Math.max(0, w - 2 - cells(label)))
      if (sheet) {
        rows.push(
          <Box key={`row:${card.id}`} flexDirection="row" width={w} backgroundColor={isSel || isMergeTarget ? sheet.head : sheet.body}>
            <Button key={`card:${card.id}`} plain onPress={() => pressCard(surface, card.id, col.id)}>
              <Text weight={isSel || isMergeTarget ? 'semibold' : 'medium'} color={INK}>
                {mark + label}
              </Text>
            </Button>
            <Text key={`card:${card.id}:tail`} color={INK_SOFT}>
              {rest}
            </Text>
          </Box>,
        )
        continue
      }
      rows.push(
        <Box key={`row:${card.id}`} flexDirection="row">
          <Button
            key={`card:${card.id}`}
            label={mark + label}
            plain
            variant={isMergeTarget || isSel ? 'primary' : undefined}
            onPress={() => pressCard(surface, card.id, col.id)}
          />
          <Text key={`card:${card.id}:tail`} dimColor>
            {rest}
          </Text>
        </Box>,
      )
    }
    return (
      <Box key={`col:${col.id}`} flexDirection="column" width={lay.colWidth} marginBottom={lay.isRow ? 0 : 1}>
        {sheet ? (
          <Box key={`headrow:${col.id}`} flexDirection="row" width={w} backgroundColor={sheet.head}>
            <Button key={`head:${col.id}`} plain onPress={() => pressHeader(surface, col.id)}>
              <Text weight="semibold" color={INK} underline={isHover}>
                {` ${head}`}
              </Text>
            </Button>
            <Text key={`head:${col.id}:count`} weight="medium" color={INK}>
              {` ${count}`}
            </Text>
          </Box>
        ) : (
          <Box key={`headrow:${col.id}`} flexDirection="row">
            <Button key={`head:${col.id}`} label={head} plain variant={isHover ? 'primary' : undefined} onPress={() => pressHeader(surface, col.id)} />
            <Text key={`head:${col.id}:count`} dimColor>
              {` ${count}`}
            </Text>
          </Box>
        )}
        {rows}
      </Box>
    )
  }

  const ghost = drag ? (
    <Box
      key="ghost"
      position="absolute"
      top={Math.max(0, Math.min(drag.y, lay.height - 1))}
      left={Math.max(0, Math.min(drag.x + 1, width - 12))}
    >
      <Text inverse>{cut(`${findCard(props, drag.card)?.card.label ?? ''}${target ? ` → ${target.text}` : ' （放开取消）'}`, Math.max(8, width - drag.x - 2))}</Text>
    </Box>
  ) : null

  return (
    <Box key="board" flexDirection={lay.isRow ? 'row' : 'column'} width={width} height={lay.height} position="relative">
      {props.columns.map(column)}
      {ghost}
    </Box>
  )
}

export default Board
