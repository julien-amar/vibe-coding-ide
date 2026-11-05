import type { GitCommit } from '@shared/types'

/**
 * Lane layout for a commit graph (commits in date/topo order, newest first).
 * Each lane holds the hash of the commit it is waiting for; a commit sits in the
 * lane waiting for it, lanes waiting for the same commit converge into it, and
 * its parents continue in its lane (first parent) or in new/free lanes (merges).
 */
export interface GraphRow {
  /** Lane of this commit. */
  col: number
  /** Lane contents entering the row (top edge). */
  before: (string | null)[]
  /** Lanes (other than `col`) that end in this commit. */
  converging: number[]
  /** Lanes the parents continue in (bottom edge). */
  parentCols: number[]
  /** Whether a child commit above connects into this one. */
  hasChild: boolean
}

export function computeGraph(commits: GitCommit[]): { rows: GraphRow[]; maxLanes: number } {
  const lanes: (string | null)[] = []
  const rows: GraphRow[] = []
  let maxLanes = 1

  for (const c of commits) {
    let col = lanes.indexOf(c.hash)
    const hasChild = col >= 0
    if (col < 0) {
      col = lanes.indexOf(null)
      if (col < 0) {
        col = lanes.length
        lanes.push(null)
      }
    }
    const before = lanes.slice()

    const converging: number[] = []
    lanes.forEach((h, j) => {
      if (h === c.hash && j !== col) {
        converging.push(j)
        lanes[j] = null
      }
    })

    const parentCols: number[] = []
    if (c.parents.length === 0) {
      lanes[col] = null
    } else {
      lanes[col] = c.parents[0]
      parentCols.push(col)
      for (const p of c.parents.slice(1)) {
        let j = lanes.indexOf(p)
        if (j < 0) {
          j = lanes.indexOf(null)
          if (j < 0) {
            j = lanes.length
            lanes.push(p)
          } else lanes[j] = p
        }
        parentCols.push(j)
      }
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()

    maxLanes = Math.max(maxLanes, before.length, lanes.length, col + 1)
    rows.push({ col, before, converging, parentCols, hasChild })
  }
  return { rows, maxLanes }
}

export const LANE_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#ef4444', '#84cc16']
export const laneColor = (j: number): string => LANE_COLORS[j % LANE_COLORS.length]
