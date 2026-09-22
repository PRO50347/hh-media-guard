import type Database from 'better-sqlite3';

/** Acquire the write lock before inspecting versions: concurrent starters must
 * never execute a migration based on a pre-lock snapshot. */
export function migrate(db: Database.Database, statements: readonly string[]) {
  db.pragma('busy_timeout = 10000');
  db.transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const [index, sql] of statements.entries()) {
      const version = index + 1;
      if (db.prepare('SELECT 1 FROM migrations WHERE version = ?').get(version)) continue;
      db.exec(sql);
      db.prepare('INSERT INTO migrations VALUES (?, ?)').run(version, new Date().toISOString());
    }
    // v0.1 events predate the actor column; CREATE IF NOT EXISTS cannot add it.
    const columns = db.prepare('PRAGMA table_info(events)').all() as { name: string }[];
    if (columns.length && !columns.some(column => column.name === 'actor')) {
      db.exec("ALTER TABLE events ADD COLUMN actor TEXT NOT NULL DEFAULT 'system'");
    }
  }).immediate();
}
