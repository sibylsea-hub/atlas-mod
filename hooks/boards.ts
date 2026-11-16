// atlas: the posts a board (board.tsx) sends, checked. What each one does is
// in register.tsx (handleBoard), next to the writes it makes.

export type BoardPost =
  | { board: string; type: 'drop'; card: string; from: string; to: string; index: number }
  | { board: string; type: 'merge'; card: string; onto: string }
  | { board: string; type: 'reorder'; column: string; order: string[] }
  | { board: string; type: 'open'; card: string }

export function asPost(data: unknown): BoardPost | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (typeof d.board !== 'string' || typeof d.type !== 'string') return null
  if (d.type === 'drop' && typeof d.card === 'string' && typeof d.to === 'string') {
    return { board: d.board, type: 'drop', card: d.card, from: String(d.from ?? ''), to: d.to, index: Number(d.index ?? 0) }
  }
  if (d.type === 'merge' && typeof d.card === 'string' && typeof d.onto === 'string') {
    return { board: d.board, type: 'merge', card: d.card, onto: d.onto }
  }
  if (d.type === 'reorder' && typeof d.column === 'string' && Array.isArray(d.order)) {
    return { board: d.board, type: 'reorder', column: d.column, order: d.order.filter((x): x is string => typeof x === 'string') }
  }
  if (d.type === 'open' && typeof d.card === 'string') return { board: d.board, type: 'open', card: d.card }
  return null
}
