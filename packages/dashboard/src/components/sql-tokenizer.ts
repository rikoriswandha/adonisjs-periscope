export type SqlTokenKind = 'plain' | 'keyword' | 'string' | 'number' | 'comment'

export type SqlToken = {
  kind: SqlTokenKind
  value: string
}

const KEYWORDS: Record<string, true> = {
  ADD: true,
  ALL: true,
  ALTER: true,
  AND: true,
  AS: true,
  ASC: true,
  BETWEEN: true,
  BY: true,
  CASE: true,
  CHECK: true,
  COLUMN: true,
  CONSTRAINT: true,
  CREATE: true,
  CROSS: true,
  CURRENT_DATE: true,
  CURRENT_TIME: true,
  CURRENT_TIMESTAMP: true,
  DATABASE: true,
  DEFAULT: true,
  DELETE: true,
  DESC: true,
  DISTINCT: true,
  DROP: true,
  ELSE: true,
  END: true,
  EXISTS: true,
  FALSE: true,
  FETCH: true,
  FOREIGN: true,
  FROM: true,
  FULL: true,
  GROUP: true,
  HAVING: true,
  ILIKE: true,
  IN: true,
  INDEX: true,
  INNER: true,
  INSERT: true,
  INTERSECT: true,
  INTO: true,
  IS: true,
  JOIN: true,
  KEY: true,
  LEFT: true,
  LIKE: true,
  LIMIT: true,
  NATURAL: true,
  NOT: true,
  NULL: true,
  NULLS: true,
  OFFSET: true,
  ON: true,
  OR: true,
  ORDER: true,
  OUTER: true,
  PRIMARY: true,
  REFERENCES: true,
  RETURNING: true,
  RIGHT: true,
  SELECT: true,
  SET: true,
  TABLE: true,
  THEN: true,
  TRUE: true,
  UNION: true,
  UNIQUE: true,
  UPDATE: true,
  USING: true,
  VALUES: true,
  WHEN: true,
  WHERE: true,
  WITH: true,
}

function appendToken(tokens: SqlToken[], kind: SqlTokenKind, value: string) {
  const previous = tokens.at(-1)
  if (previous?.kind === kind) {
    previous.value += value
    return
  }

  tokens.push({ kind, value })
}

/** Tokenizes presentation-only SQL without interpreting or rewriting the query. */
export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = []
  let cursor = 0

  while (cursor < sql.length) {
    const start = cursor
    const character = sql[cursor]
    const next = sql[cursor + 1]

    if (character === '-' && next === '-') {
      cursor += 2
      while (cursor < sql.length && sql[cursor] !== '\n') cursor += 1
      appendToken(tokens, 'comment', sql.slice(start, cursor))
      continue
    }

    if (character === '/' && next === '*') {
      cursor += 2
      while (cursor < sql.length && !(sql[cursor] === '*' && sql[cursor + 1] === '/')) {
        cursor += 1
      }
      cursor = Math.min(cursor + 2, sql.length)
      appendToken(tokens, 'comment', sql.slice(start, cursor))
      continue
    }

    if (character === "'" || character === '"' || character === '`') {
      const quote = character
      cursor += 1
      while (cursor < sql.length) {
        if (sql[cursor] === '\\') {
          cursor = Math.min(cursor + 2, sql.length)
          continue
        }
        if (sql[cursor] === quote) {
          if (sql[cursor + 1] === quote) {
            cursor += 2
            continue
          }
          cursor += 1
          break
        }
        cursor += 1
      }
      appendToken(tokens, 'string', sql.slice(start, cursor))
      continue
    }

    const isNumberStart =
      /[0-9]/.test(character) || (character === '.' && next !== undefined && /[0-9]/.test(next))
    const previous = sql[cursor - 1]
    if (isNumberStart && (previous === undefined || !/[\w$]/.test(previous))) {
      const number = sql
        .slice(cursor)
        .match(/^(?:0x[\da-f]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/i)
      if (number) {
        cursor += number[0].length
        appendToken(tokens, 'number', number[0])
        continue
      }
    }

    if (/[A-Za-z_]/.test(character)) {
      cursor += 1
      while (cursor < sql.length && /[\w$]/.test(sql[cursor])) cursor += 1
      const word = sql.slice(start, cursor)
      appendToken(tokens, KEYWORDS[word.toUpperCase()] ? 'keyword' : 'plain', word)
      continue
    }

    cursor += 1
    appendToken(tokens, 'plain', character)
  }

  return tokens
}
