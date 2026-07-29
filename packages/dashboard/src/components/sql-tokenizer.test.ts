import assert from 'node:assert/strict'
import test from 'node:test'

import { tokenizeSql } from './sql-tokenizer.ts'

test('classifies SQL keywords, strings, numbers, and comments without changing the query', () => {
  const sql = `select "users"."id", 42.5, 'O''Reilly' FROM users -- active users\nWHERE id = 0x2a /* pinned */`
  const tokens = tokenizeSql(sql)

  assert.equal(tokens.map((token) => token.value).join(''), sql)
  assert.deepEqual(
    tokens.filter((token) => token.kind === 'keyword').map((token) => token.value),
    ['select', 'FROM', 'WHERE']
  )
  assert.deepEqual(
    tokens.filter((token) => token.kind === 'string').map((token) => token.value),
    ['"users"', '"id"', "'O''Reilly'"]
  )
  assert.deepEqual(
    tokens.filter((token) => token.kind === 'number').map((token) => token.value),
    ['42.5', '0x2a']
  )
  assert.deepEqual(
    tokens.filter((token) => token.kind === 'comment').map((token) => token.value),
    ['-- active users', '/* pinned */']
  )
})

test('preserves unterminated strings and comments as colored tokens', () => {
  assert.deepEqual(tokenizeSql("SELECT 'unfinished"), [
    { kind: 'keyword', value: 'SELECT' },
    { kind: 'plain', value: ' ' },
    { kind: 'string', value: "'unfinished" },
  ])
  assert.deepEqual(tokenizeSql('SELECT /* unfinished'), [
    { kind: 'keyword', value: 'SELECT' },
    { kind: 'plain', value: ' ' },
    { kind: 'comment', value: '/* unfinished' },
  ])
})
