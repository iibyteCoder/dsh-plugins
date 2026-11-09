import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { formatTable, formatTime, truncateText } from '../src/format/text.js'

describe('format', () => {
  test('truncateText keeps short text and truncates by code point', () => {
    assert.equal(truncateText('hello', 10), 'hello')
    assert.equal(truncateText('hello', 5), 'hello')
    assert.equal(truncateText('hello', 3), 'hel…')
    assert.equal(truncateText('😀😀😀', 2), '😀😀…')
    assert.equal(truncateText('hello', 0), '')
    assert.equal(truncateText(undefined, 5), '')
  })

  test('formatTime renders local YYYY-MM-DD HH:mm and tolerates bad input', () => {
    const rendered = formatTime(Date.UTC(2026, 0, 2, 3, 4))
    assert.match(rendered, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    assert.equal(formatTime(undefined), '-')
    assert.equal(formatTime(null), '-')
    assert.equal(formatTime('not-a-date'), '-')
  })

  test('formatTable aligns columns around a header separator', () => {
    const table = formatTable([
      ['ID', 'TITLE'],
      ['s1', 'Fix login'],
      ['s22', 'Docs'],
    ])

    assert.equal(table, ['ID   TITLE', '---  ---------', 's1   Fix login', 's22  Docs'].join('\n'))
  })

  test('formatTable accounts for wide CJK characters', () => {
    const table = formatTable([
      ['TITLE', 'STATUS'],
      ['修复登录', 'running'],
    ])

    assert.equal(table, ['TITLE     STATUS', '--------  -------', '修复登录  running'].join('\n'))
  })

  test('formatTable returns an empty string for no rows', () => {
    assert.equal(formatTable([]), '')
    assert.equal(formatTable(undefined), '')
  })
})
