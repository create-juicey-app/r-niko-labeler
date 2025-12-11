#!/usr/bin/env node
const Database = require('better-sqlite3');
const db = new Database('labels.db', { readonly: true });

console.log('Tables:');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log(tables.map(r => r.name).join(', '));

try {
  const rows = db.prepare('SELECT * FROM labels ORDER BY id DESC LIMIT 20').all();
  console.log('\nLast 20 labels:');
  console.dir(rows, { depth: 2 });
} catch (e) {
  console.error('Could not read labels table:', e.message);
}

try {
  const defs = db.prepare('SELECT * FROM label_values').all();
  console.log('\nLabel definitions:');
  console.dir(defs, { depth: 2 });
} catch (e) {
  console.error('Could not read label_values table:', e.message);
}

db.close();
