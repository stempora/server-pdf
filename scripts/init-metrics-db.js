#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  SCHEMA_VERSION,
  initializeMetricsDatabase,
  validateSchema
} = require('../metrics-store');

const defaultFile = path.join(__dirname, '..', 'data', 'metrics.sqlite');

function parseArguments(args) {
  const result = { mode: 'migrate', backupFile: null };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--check' || argument === '--status') {
      if (result.mode !== 'migrate') throw new Error('Choose only one of --check or --status');
      result.mode = argument.slice(2);
    } else if (argument === '--backup') {
      result.backupFile = args[++index];
      if (!result.backupFile) throw new Error('--backup requires a file path');
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (result.mode !== 'migrate' && result.backupFile) {
    throw new Error('--backup is available only during migration');
  }
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const file = path.resolve(process.env.METRICS_DB_FILE || defaultFile);
  const checkOnly = options.mode === 'check' || options.mode === 'status';
  const initialized = await initializeMetricsDatabase(file, {
    checkOnly,
    backupFile: options.backupFile ? path.resolve(options.backupFile) : null
  });
  try {
    const schemaVersion = validateSchema(initialized.db);
    if (options.mode === 'status') {
      const journalMode = initialized.db.prepare('PRAGMA journal_mode').get().journal_mode;
      const tables = initialized.db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('api_key_metrics', 'api_key_daily_metrics')
        ORDER BY name
      `).all().map(row => row.name);
      console.log(JSON.stringify({
        path: file,
        schemaVersion,
        supportedSchemaVersion: SCHEMA_VERSION,
        journalMode,
        tables
      }, null, 2));
    } else {
      console.log(`Metrics schema version ${schemaVersion} is valid.`);
    }
  } finally {
    initialized.db.close();
  }
  if (!checkOnly && fs.existsSync(file)) fs.chmodSync(file, 0o600);
}

main().catch(error => {
  console.error(`[metrics-db] ${error.message}`);
  process.exitCode = 1;
});
