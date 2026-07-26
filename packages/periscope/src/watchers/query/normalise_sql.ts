/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Common SQL words whose casing carries no meaning. This is intentionally a compact vocabulary,
 * not a dialect grammar: the normalised value groups query shapes for N+1 detection and is never
 * sent back to a database. Unknown words are left untouched so quoted or dialect-specific
 * identifiers are not casually rewritten.
 */
const KEYWORDS: Record<string, true> = {
  alter: true,
  and: true,
  as: true,
  asc: true,
  between: true,
  by: true,
  case: true,
  create: true,
  delete: true,
  desc: true,
  distinct: true,
  drop: true,
  else: true,
  end: true,
  exists: true,
  from: true,
  full: true,
  group: true,
  having: true,
  in: true,
  inner: true,
  insert: true,
  into: true,
  is: true,
  join: true,
  left: true,
  like: true,
  limit: true,
  not: true,
  null: true,
  offset: true,
  on: true,
  or: true,
  order: true,
  outer: true,
  returning: true,
  right: true,
  select: true,
  set: true,
  then: true,
  union: true,
  update: true,
  using: true,
  values: true,
  when: true,
  where: true,
  with: true,
}

const IDENTIFIER_CHARACTER = /[A-Za-z0-9_$]/
const WORD_START = /[A-Za-z_]/
const WORD_CHARACTER = /[A-Za-z0-9_$]/

/**
 * Return the index immediately after a single-quoted SQL string.
 *
 * SQL escapes a quote by doubling it. Backslash escaping is not standard but is accepted by
 * several popular dialects, so recognising it here avoids ending a literal early without making
 * the pass dialect-aware.
 */
function skipStringLiteral(sql: string, start: number): number {
  let index = start + 1

  while (index < sql.length) {
    if (sql[index] === '\\') {
      index += 2
      continue
    }

    if (sql[index] !== "'") {
      index++
      continue
    }

    if (sql[index + 1] === "'") {
      index += 2
      continue
    }

    return index + 1
  }

  return sql.length
}

/**
 * Return the index immediately after a quoted identifier.
 *
 * Quoted identifiers are structural names, not values, so their spelling must survive the shape
 * pass unchanged. Scanning to the matching quote also keeps apostrophes, comment markers and SQL
 * keywords inside an identifier from being interpreted as SQL.
 */
function skipQuotedIdentifier(sql: string, start: number): number {
  const quote = sql[start]
  let index = start + 1

  while (index < sql.length) {
    if (sql[index] === '\\') {
      index += 2
      continue
    }

    if (sql[index] !== quote) {
      index++
      continue
    }

    if (sql[index + 1] === quote) {
      index += 2
      continue
    }

    return index + 1
  }

  return sql.length
}

/**
 * Return the index immediately after a PostgreSQL dollar-quoted string, or `start` when this is
 * not a dollar-quote delimiter.
 *
 * PostgreSQL placeholders such as `$1` deliberately fail the delimiter check and remain part of
 * the query shape. Dollar-quoted values, including unterminated ones, are literals and therefore
 * collapse to the same marker as single-quoted values.
 */
function skipDollarQuotedString(sql: string, start: number): number {
  const previous = sql[start - 1]
  if (previous !== undefined && IDENTIFIER_CHARACTER.test(previous)) {
    return start
  }

  let delimiterEnd = start + 1
  if (sql[delimiterEnd] === '$') {
    delimiterEnd++
  } else {
    if (!WORD_START.test(sql[delimiterEnd] ?? '')) {
      return start
    }

    delimiterEnd++
    while (/[A-Za-z0-9_]/.test(sql[delimiterEnd] ?? '')) {
      delimiterEnd++
    }

    if (sql[delimiterEnd] !== '$') {
      return start
    }
    delimiterEnd++
  }

  const delimiter = sql.slice(start, delimiterEnd)
  const closingStart = sql.indexOf(delimiter, delimiterEnd)
  return closingStart === -1 ? sql.length : closingStart + delimiter.length
}

/**
 * Comments contribute no query structure and can contain arbitrary SQL-looking text. Returning
 * their full extent lets the caller replace each comment with whitespace, which keeps tokens on
 * either side separate without allowing request ids or trace annotations to fragment families.
 */
function skipComment(sql: string, start: number): number {
  if (sql[start] === '-') {
    const lineEnd = sql.indexOf('\n', start + 2)
    return lineEnd === -1 ? sql.length : lineEnd
  }

  const commentEnd = sql.indexOf('*/', start + 2)
  return commentEnd === -1 ? sql.length : commentEnd + 2
}

/**
 * Return the end of a numeric literal, or `start` when the character does not begin one.
 *
 * Hexadecimal and binary forms are included because schema and bit-mask queries use them often;
 * decimal exponents cover both integer and floating-point scientific notation. A preceding
 * identifier character prevents the digits in names such as `address1` and PostgreSQL's `$1`
 * placeholders from being mistaken for values.
 */
function skipNumberLiteral(sql: string, start: number): number {
  const previous = sql[start - 1]
  if (previous !== undefined && IDENTIFIER_CHARACTER.test(previous)) {
    return start
  }

  const rest = sql.slice(start)
  const match = /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(
    rest
  )

  if (match === null) {
    return start
  }

  const next = sql[start + match[0].length]
  return next !== undefined && IDENTIFIER_CHARACTER.test(next) ? start : start + match[0].length
}

/**
 * Reduce SQL to a stable query shape for family grouping.
 *
 * This is a deliberately small lexical pass rather than a SQL parser. It replaces string and
 * numeric literals with `?`, preserves quoted identifiers, lower-cases common keywords, strips
 * comments, and collapses whitespace. Comments are omitted because annotations such as request
 * ids carry no query structure and would otherwise make every execution a separate family.
 * These rules group the same statement issued with different values while preserving identifiers,
 * operators and clause structure that distinguish genuinely different queries. The result is only
 * ever hashed; it must never be used as executable SQL.
 */
export function normaliseSql(sql: string): string {
  const output: string[] = []
  let index = 0

  while (index < sql.length) {
    const character = sql[index]

    if (character === "'") {
      output.push('?')
      index = skipStringLiteral(sql, index)
      continue
    }

    if (character === '"' || character === '`') {
      const identifierEnd = skipQuotedIdentifier(sql, index)
      output.push(sql.slice(index, identifierEnd))
      index = identifierEnd
      continue
    }

    if (
      (character === '-' && sql[index + 1] === '-') ||
      (character === '/' && sql[index + 1] === '*')
    ) {
      output.push(' ')
      index = skipComment(sql, index)
      continue
    }

    if (character === '$') {
      const stringEnd = skipDollarQuotedString(sql, index)
      if (stringEnd !== index) {
        output.push('?')
        index = stringEnd
        continue
      }
    }

    if (/[0-9]/.test(character) || (character === '.' && /[0-9]/.test(sql[index + 1] ?? ''))) {
      const numberEnd = skipNumberLiteral(sql, index)
      if (numberEnd !== index) {
        output.push('?')
        index = numberEnd
        continue
      }
    }

    if (WORD_START.test(character)) {
      let end = index + 1
      while (end < sql.length && WORD_CHARACTER.test(sql[end])) {
        end++
      }

      const word = sql.slice(index, end)
      output.push(Object.hasOwn(KEYWORDS, word.toLowerCase()) ? word.toLowerCase() : word)
      index = end
      continue
    }

    output.push(character)
    index++
  }

  return output.join('').replace(/\s+/g, ' ').trim()
}
