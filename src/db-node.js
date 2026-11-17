import { DatabaseSync } from 'node:sqlite'

// node:sqlite is synchronous. The methods are async anyway so the same code works with D1.
export function openDb(path) {
  const sqlite = new DatabaseSync(path)

  return {
    async all(sql, params = []) {
      return sqlite.prepare(sql).all(...params)
    },

    async run(sql, params = []) {
      return sqlite.prepare(sql).run(...params)
    },

    async batch(statements) {
      // no await between BEGIN and COMMIT, so nothing else can sneak in
      sqlite.exec('BEGIN')
      try {
        for (const [sql, params] of statements) {
          sqlite.prepare(sql).run(...params)
        }
        sqlite.exec('COMMIT')
      } catch (e) {
        sqlite.exec('ROLLBACK')
        throw e
      }
    },
  }
}
