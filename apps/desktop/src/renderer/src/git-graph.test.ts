import { describe, expect, it } from 'vitest'
import type { GitCommit } from '@shared/types'
import { computeGraph } from './git-graph'

const c = (hash: string, parents: string[] = []): GitCommit => ({ hash, parents, author: 'a', date: 0, refs: [], subject: hash })

describe('computeGraph', () => {
  it('keeps a linear history in one lane', () => {
    const { rows, maxLanes } = computeGraph([c('c3', ['c2']), c('c2', ['c1']), c('c1')])
    expect(maxLanes).toBe(1)
    expect(rows.map((r) => r.col)).toEqual([0, 0, 0])
    expect(rows.map((r) => r.hasChild)).toEqual([false, true, true])
    expect(rows[2].parentCols).toEqual([]) // root commit
  })

  it('opens a lane for a merged branch and closes it at the fork point', () => {
    // m merges f into main; f and b are on the branch; a is the common ancestor.
    //   m
    //   |\
    //   b f
    //   |/
    //   a
    const { rows, maxLanes } = computeGraph([c('m', ['b', 'f']), c('f', ['a']), c('b', ['a']), c('a')])
    expect(maxLanes).toBe(2)
    const [m, f, b, a] = rows
    expect(m.col).toBe(0)
    expect(m.parentCols).toEqual([0, 1]) // first parent continues, second parent opens lane 1
    expect(f.col).toBe(1)
    expect(b.col).toBe(0)
    expect(a.col).toBe(0)
    expect(a.converging).toEqual([1]) // the branch lane ends in the common ancestor
  })

  it('places unrelated tips in separate lanes', () => {
    const { rows } = computeGraph([c('x2', ['x1']), c('y1'), c('x1')])
    expect(rows[0].col).toBe(0)
    expect(rows[1].col).toBe(1)
    expect(rows[1].hasChild).toBe(false)
    expect(rows[2].col).toBe(0)
  })
})
