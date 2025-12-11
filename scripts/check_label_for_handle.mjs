import pkg from '@atproto/api';
const { BskyAgent } = pkg;
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const agent = new BskyAgent({ service: 'https://bsky.social' });

async function resolve(handle) {
  if (handle.startsWith('@')) handle = handle.slice(1);
  try {
    const res = await agent.resolveHandle({ handle });
    return res.data.did;
  } catch (e) {
    console.error('Failed to resolve handle:', e.message || e);
    return null;
  }
}

async function main() {
  const handle = process.argv[2];
  if (!handle) {
    console.error('Usage: node check_label_for_handle.mjs <handle>');
    process.exit(2);
  }

  await agent.login({ identifier: process.env.BSKY_HANDLE, password: process.env.BSKY_PASSWORD }).catch(()=>{});

  const did = await resolve(handle);
  if (!did) {
    console.error('Could not resolve handle to DID');
    process.exit(1);
  }
  console.log('Resolved DID:', did);

  const db = new Database('labels.db', { readonly: true });
  try {
    const rows = db.prepare('SELECT * FROM labels WHERE uri = ? ORDER BY id DESC').all(did);
    if (rows.length === 0) {
      console.log('No labels found for', did);
    } else {
      console.log('Found labels:');
      console.dir(rows, { depth: 2 });
    }
  } catch (e) {
    console.error('DB error:', e.message || e);
  } finally {
    db.close();
  }
}

main();
