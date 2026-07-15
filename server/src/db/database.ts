import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { migrations } from "./schema.js";

export type IrisDatabase = Database.Database;

export function createDatabase(path: string): IrisDatabase {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  migrate(database);
  return database;
}

export function migrate(database: IrisDatabase) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = database.prepare("SELECT id FROM schema_migrations WHERE id = ?");
  const record = database.prepare(
    "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
  );

  const applyMigrations = database.transaction(() => {
    for (const migration of migrations) {
      if (applied.get(migration.id)) continue;

      database.exec(migration.sql);
      record.run(migration.id, new Date().toISOString());
    }
  });

  applyMigrations();
}

export function closeDatabase(database: IrisDatabase) {
  database.close();
}
