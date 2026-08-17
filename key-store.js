'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class KeyStoreError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = 'KeyStoreError';
    this.statusCode = statusCode;
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file, value) {
  const directory = path.dirname(file);
  const temporaryFile = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  let descriptor;

  try {
    descriptor = fs.openSync(temporaryFile, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryFile, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch (_closeError) {}
    }
    try { fs.unlinkSync(temporaryFile); } catch (_unlinkError) {}
    throw error;
  }
}

function normalizeName(value) {
  if (typeof value !== 'string') {
    throw new KeyStoreError('`name` must be a string', 400);
  }

  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length === 0 || name.length > 100) {
    throw new KeyStoreError('`name` must contain between 1 and 100 characters', 400);
  }
  return name;
}

function isBearerAuthorized(authorization, expectedKey) {
  const suppliedKey = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice(7)
    : '';
  const suppliedBuffer = Buffer.from(suppliedKey);
  const expectedBuffer = Buffer.from(expectedKey);

  return suppliedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
}

class KeyStore {
  constructor(apiKeysFile, metadataFile) {
    this.apiKeysFile = apiKeysFile;
    this.metadataFile = metadataFile;
    this.keys = readJson(apiKeysFile);

    if (!Array.isArray(this.keys) || this.keys.some(key => typeof key !== 'string')) {
      throw new Error('API key file must contain an array of strings');
    }

    this.metadata = fs.existsSync(metadataFile) ? readJson(metadataFile) : {};
    if (!this.metadata || Array.isArray(this.metadata) || typeof this.metadata !== 'object') {
      throw new Error('API key metadata file must contain a JSON object');
    }
  }

  isValid(key) {
    return typeof key === 'string' &&
      this.keys.includes(key) &&
      this.metadata[key]?.enabled !== false;
  }

  create(nameValue) {
    const name = normalizeName(nameValue);
    let key;
    do {
      key = crypto.randomBytes(32).toString('hex');
    } while (this.keys.includes(key));

    const now = new Date().toISOString();
    const nextKeys = [...this.keys, key];
    const nextMetadata = {
      ...this.metadata,
      [key]: {
        name,
        enabled: true,
        created_at: now,
        updated_at: now
      }
    };

    // Orphan metadata is harmless if the second atomic rename fails.
    writeJsonAtomic(this.metadataFile, nextMetadata);
    writeJsonAtomic(this.apiKeysFile, nextKeys);
    this.metadata = nextMetadata;
    this.keys = nextKeys;

    return { success: true, key, name, enabled: true, created_at: now };
  }

  list() {
    return {
      success: true,
      keys: this.keys.map(key => ({
        key,
        name: this.metadata[key]?.name ?? null,
        enabled: this.metadata[key]?.enabled !== false,
        created_at: this.metadata[key]?.created_at ?? null
      }))
    };
  }

  setEnabled(key, enabled) {
    this.assertExistingKey(key);
    const now = new Date().toISOString();
    const previous = this.metadata[key] || {};
    const nextMetadata = {
      ...this.metadata,
      [key]: {
        ...previous,
        name: previous.name ?? null,
        enabled,
        created_at: previous.created_at ?? null,
        updated_at: now
      }
    };

    writeJsonAtomic(this.metadataFile, nextMetadata);
    this.metadata = nextMetadata;
    return { success: true, key, enabled, updated_at: now };
  }

  delete(key) {
    this.assertExistingKey(key);
    const nextKeys = this.keys.filter(existingKey => existingKey !== key);
    const nextMetadata = { ...this.metadata };
    delete nextMetadata[key];

    // Removing the key first guarantees it cannot remain authorized after a partial failure.
    writeJsonAtomic(this.apiKeysFile, nextKeys);
    this.keys = nextKeys;
    writeJsonAtomic(this.metadataFile, nextMetadata);
    this.metadata = nextMetadata;
    return { success: true, key };
  }

  assertExistingKey(key) {
    if (typeof key !== 'string' || key.length === 0 || !this.keys.includes(key)) {
      throw new KeyStoreError('API key not found', 404);
    }
  }
}

module.exports = {
  KeyStore,
  KeyStoreError,
  isBearerAuthorized,
  normalizeName,
  readJson,
  writeJsonAtomic
};
