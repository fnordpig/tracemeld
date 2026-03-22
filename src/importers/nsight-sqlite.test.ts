// src/importers/nsight-sqlite.test.ts
import { describe, it, expect } from 'vitest';
import initSqlJs from 'sql.js';

describe('sql.js WASM loading', () => {
  it('initializes sql.js and creates an in-memory database', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run('CREATE TABLE test (id INTEGER, name TEXT)');
    db.run("INSERT INTO test VALUES (1, 'hello')");
    const result = db.exec('SELECT * FROM test');
    expect(result).toHaveLength(1);
    expect(result[0].values).toEqual([[1, 'hello']]);
    db.close();
  });
});
