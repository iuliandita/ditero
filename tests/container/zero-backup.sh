#!/bin/sh
set -eu

image=${1:-ditero-zero-smoke}
docker run --rm --init --network none --entrypoint node -i "$image" <<'NODE'
const assert = require('node:assert/strict');
const {spawn, execFileSync} = require('node:child_process');
const {mkdtempSync, realpathSync, writeFileSync, rmSync} = require('node:fs');
const {createRequire} = require('node:module');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');

const zeroRequire = createRequire(realpathSync('/opt/app/node_modules/@rocicorp/zero/package.json'));
const Database = zeroRequire('@rocicorp/zero-sqlite3');
const root = mkdtempSync(join(tmpdir(), 'zero-backup-'));
const watchdog = setTimeout(() => {
  console.error('Zero backup smoke exceeded 180 seconds');
  process.exit(1);
}, 180_000);

function verify(path, expected) {
  const db = new Database(path, {readonly: true, fileMustExist: true});
  try {
    assert.equal(db.pragma('integrity_check', {simple: true}), 'ok');
    assert.deepEqual(db.prepare('SELECT id, value FROM smoke ORDER BY id').all(), expected);
    assert.equal(db.prepare('SELECT watermark FROM backup_watermark').get().watermark,
      expected.length === 1 ? '0001' : '0002');
  } finally {
    db.close();
  }
}

async function restoreUntil(binary, replica, expected, label, child) {
  const deadline = Date.now() + 30_000;
  let lastError;
  do {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${label}: replication exited unexpectedly`);
    }
    const output = join(root, `${label}.db`);
    try {
      execFileSync(binary, ['restore', '-o', output, `file://${replica}`],
        {timeout: 5_000, killSignal: 'SIGKILL', encoding: 'utf8', stdio: 'pipe'});
      verify(output, expected);
      return;
    } catch (error) {
      lastError = error;
    } finally {
      for (const suffix of ['', '-wal', '-shm', '.tmp']) {
        rmSync(output + suffix, {force: true});
      }
    }
    await delay(500);
  } while (Date.now() < deadline);
  throw new Error(`${label}: backup did not restore the expected rows`, {cause: lastError});
}

async function check(writer, readers, name) {
  const path = join(root, `${name}.db`);
  const replica = join(root, `${name}-replica`);
  const config = join(root, `${name}.yml`);
  const db = new Database(path);
  let child;
  let log = '';
  try {
    assert.equal(db.pragma('journal_mode = WAL', {simple: true}), 'wal');
    db.pragma('wal_autocheckpoint = 0');
    db.exec("CREATE TABLE smoke (id INTEGER PRIMARY KEY, value TEXT NOT NULL);" +
      "CREATE TABLE backup_watermark (watermark TEXT NOT NULL);" +
      "INSERT INTO smoke VALUES (1, 'snapshot');" +
      "INSERT INTO backup_watermark VALUES ('0001');");
    // Exercise the legacy fork's watermark extension as well as its backup format.
    const watermark = name === 'legacy'
      ? '    watermark-table: backup_watermark\n    watermark-column: watermark\n' : '';
    writeFileSync(config, `dbs:\n  - path: ${path}\n${watermark}` +
      `    replicas:\n      - url: file://${replica}\n        sync-interval: 100ms\n`);
    child = spawn(writer, ['replicate', '-config', config], {stdio: ['ignore', 'pipe', 'pipe']});
    child.on('error', error => { log += String(error); });
    child.stdout.on('data', data => { log = (log + data).slice(-32_768); });
    child.stderr.on('data', data => { log = (log + data).slice(-32_768); });
    const first = [{id: 1, value: 'snapshot'}];
    await restoreUntil(writer, replica, first, `${name}-snapshot`, child);
    // Change data after the first backup, so a snapshot-only restore cannot pass.
    db.exec("BEGIN; UPDATE smoke SET value = 'updated' WHERE id = 1;" +
      "INSERT INTO smoke VALUES (2, 'wal');" +
      "UPDATE backup_watermark SET watermark = '0002'; COMMIT;");
    for (const reader of readers) {
      const label = `${name}-to-${reader}`;
      await restoreUntil(reader, replica,
        [{id: 1, value: 'updated'}, {id: 2, value: 'wal'}], label, child);
      console.log(`${label}: rows, watermark, and SQLite integrity verified`);
    }
  } catch (error) {
    console.error(log);
    throw error;
  } finally {
    db.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const deadline = Date.now() + 10_000;
      while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
        await delay(100);
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        console.error(log);
        throw new Error(`${name}: replication did not stop within 10 seconds`);
      }
      if (child.exitCode !== 0) {
        console.error(log);
        throw new Error(`${name}: replication shutdown failed: ${child.exitCode}/${child.signalCode}`);
      }
    }
  }
}

(async () => {
  try {
    await check('litestream', ['litestream', 'litestream-v5'], 'legacy');
    await check('litestream-v5', ['litestream-v5'], 'v5');
  } finally {
    clearTimeout(watchdog);
    rmSync(root, {recursive: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
NODE
