const express = require('express');
const puppeteer = require('puppeteer');
const pLimit = require('p-limit');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  KeyStore,
  KeyStoreError,
  isBearerAuthorized,
  readJson
} = require('./key-store');

const MAX_CONCURRENT_REQUESTS =
  parseInt(process.env.MAX_CONCURRENT_REQUESTS, 10) || 20;
const MAX_QUEUE_SIZE =
  parseInt(process.env.MAX_QUEUE_SIZE, 10) || 200;
const NAVIGATION_TIMEOUT_MS =
  parseInt(process.env.NAVIGATION_TIMEOUT_MS, 10) || 30000;
const PAGE_TIMEOUT_MS =
  parseInt(process.env.PAGE_TIMEOUT_MS, 10) || 15000;
const FONT_TIMEOUT_MS =
  parseInt(process.env.FONT_TIMEOUT_MS, 10) || 5000;
const RENDER_DELAY_MS =
  parseInt(process.env.RENDER_DELAY_MS, 10) || 250;
const SHUTDOWN_TIMEOUT_MS =
  parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 15000;

const API_KEYS_FILE =
  process.env.API_KEYS_FILE || path.join(__dirname, 'apikeys.json');
const MASTER_KEY_FILE =
  process.env.MASTER_KEY_FILE || path.join(__dirname, 'master-key.json');
const API_KEY_METADATA_FILE =
  process.env.API_KEY_METADATA_FILE || path.join(__dirname, 'api-key-metadata.json');
const PORT = parseInt(process.env.PORT, 10) || 8214;
const LOG_DIR =
  process.env.LOG_DIR || path.join(__dirname, 'logs');
const CHROME_PATH =
  process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

let masterKey;
let keyStore;

try {
  keyStore = new KeyStore(API_KEYS_FILE, API_KEY_METADATA_FILE);
  const masterKeyDocument = readJson(MASTER_KEY_FILE);

  if (
    !masterKeyDocument ||
    typeof masterKeyDocument.key !== 'string' ||
    masterKeyDocument.key.length === 0
  ) {
    throw new Error('Master key file must contain a non-empty `key` string');
  }

  masterKey = masterKeyDocument.key;
} catch (err) {
  console.error('Failed to load API key configuration:', err.message);
  process.exit(1);
}

const limit = pLimit(MAX_CONCURRENT_REQUESTS);

let browser = null;
let browserLaunchPromise = null;
let server = null;
let shuttingDown = false;

let currentDate = new Date().toISOString().slice(0, 10);
let logStream = fs.createWriteStream(
  path.join(LOG_DIR, `${currentDate}.log`),
  { flags: 'a' }
);

function sanitizeRequestUrl(originalUrl) {
  try {
    const parsed = new URL(originalUrl, 'http://localhost');

    if (parsed.searchParams.has('apikey')) {
      parsed.searchParams.set('apikey', '[REDACTED]');
    }

    const pathname = parsed.pathname.replace(
      /^(\/admin\/(?:disable|enable|delete)-key\/)[^/]+$/,
      '$1[REDACTED]'
    );

    return `${pathname}${parsed.search}`;
  } catch (_err) {
    return originalUrl.replace(
      /([?&]apikey=)[^&]*/gi,
      '$1[REDACTED]'
    );
  }
}

function logRequest(req, requestId) {
  const now = new Date();
  const timestamp = now.toISOString();
  const today = timestamp.slice(0, 10);

  const ip =
    req.ip ||
    req.socket?.remoteAddress ||
    'unknown';

  const link = sanitizeRequestUrl(req.originalUrl);

  if (today !== currentDate) {
    logStream.end();

    currentDate = today;

    logStream = fs.createWriteStream(
      path.join(LOG_DIR, `${currentDate}.log`),
      { flags: 'a' }
    );
  }

  logStream.write(
    `[${timestamp}] requestId=${requestId} ip=${ip} ${link}\n`
  );
}

async function launchBrowser() {
  console.log(`[BROWSER] Launching Chrome from ${CHROME_PATH}`);

  const launchedBrowser = await puppeteer.launch({
    executablePath: CHROME_PATH,

    // Ignoră certificatele expirate, self-signed sau emise
    // pentru un alt hostname.
    ignoreHTTPSErrors: true,
    acceptInsecureCerts: true,

    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--ignore-certificate-errors'
    ]
  });

  launchedBrowser.on('disconnected', () => {
    console.error('[BROWSER] Chrome disconnected');

    if (browser === launchedBrowser) {
      browser = null;
    }
  });

  browser = launchedBrowser;

  console.log('[BROWSER] Chrome ready');

  return launchedBrowser;
}

async function getBrowser() {
  if (shuttingDown) {
    throw new Error('Service is shutting down');
  }

  if (browser && browser.isConnected()) {
    return browser;
  }

  if (!browserLaunchPromise) {
    browserLaunchPromise = launchBrowser().finally(() => {
      browserLaunchPromise = null;
    });
  }

  return browserLaunchPromise;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function validateTargetUrl(value) {
  const parsed = new URL(value);

  if (
    parsed.protocol !== 'http:' &&
    parsed.protocol !== 'https:'
  ) {
    throw new Error(
      'Only http:// and https:// URLs are supported'
    );
  }

  return parsed.toString();
}

async function generatePdf(url, requestId) {
  let page = null;

  try {
    const activeBrowser = await getBrowser();

    page = await activeBrowser.newPage();

    page.setDefaultNavigationTimeout(
      NAVIGATION_TIMEOUT_MS
    );

    page.setDefaultTimeout(
      PAGE_TIMEOUT_MS
    );

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT_MS
    });

    await page.evaluate(async fontTimeout => {
      if (!document.fonts || !document.fonts.ready) {
        return;
      }

      await Promise.race([
        document.fonts.ready,
        new Promise(resolve =>
          setTimeout(resolve, fontTimeout)
        )
      ]);
    }, FONT_TIMEOUT_MS);

    if (RENDER_DELAY_MS > 0) {
      await sleep(RENDER_DELAY_MS);
    }

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20mm',
        bottom: '20mm',
        left: '15mm',
        right: '15mm'
      }
    });

    console.log(
      `[PDF OK] requestId=${requestId} url=${url}`
    );

    return Buffer.from(pdfBuffer);
  } finally {
    if (page && !page.isClosed()) {
      try {
        await page.close();
      } catch (closeError) {
        console.error(
          `[PAGE CLOSE ERROR] ` +
          `requestId=${requestId} ` +
          `url=${url} ` +
          `message=${closeError.message}`
        );
      }
    }
  }
}

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(`[SHUTDOWN] Received ${signal}`);

  if (server) {
    server.close();

    if (
      typeof server.closeIdleConnections === 'function'
    ) {
      server.closeIdleConnections();
    }
  }

  const forceExitTimer = setTimeout(() => {
    console.error(
      '[SHUTDOWN] Timed out; forcing exit'
    );

    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  forceExitTimer.unref();

  try {
    if (browser && browser.isConnected()) {
      await browser.close();
    }
  } catch (err) {
    console.error(
      `[SHUTDOWN] Browser close error: ${err.message}`
    );
  }

  logStream.end(() => process.exit(0));
}

async function main() {
  await getBrowser();

  const app = express();

  app.set('trust proxy', true);
  app.use(express.json({ limit: '16kb' }));

  app.use((req, res, next) => {
    req.requestId =
      crypto.randomBytes(8).toString('hex');

    res.setHeader(
      'X-Request-ID',
      req.requestId
    );

    logRequest(req, req.requestId);

    next();
  });

  app.use('/pdf', (req, res, next) => {
    const key =
      req.query.apikey ||
      req.headers['x-api-key'];

    if (!keyStore.isValid(key)) {
      return res
        .status(401)
        .send(
          'Unauthorized: invalid or missing API key'
        );
    }

    next();
  });

  app.use('/admin', (req, res, next) => {
    if (!isBearerAuthorized(req.headers.authorization, masterKey)) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    next();
  });

  app.post('/admin/create-key', (req, res, next) => {
    try {
      res.status(201).json(keyStore.create(req.body?.name));
    } catch (err) {
      next(err);
    }
  });

  app.get('/admin/list-keys', (_req, res) => {
    res.json(keyStore.list());
  });

  app.post('/admin/disable-key/:key', (req, res, next) => {
    try {
      res.json(keyStore.setEnabled(req.params.key, false));
    } catch (err) {
      next(err);
    }
  });

  app.post('/admin/enable-key/:key', (req, res, next) => {
    try {
      res.json(keyStore.setEnabled(req.params.key, true));
    } catch (err) {
      next(err);
    }
  });

  app.delete('/admin/delete-key/:key', (req, res, next) => {
    try {
      res.json(keyStore.delete(req.params.key));
    } catch (err) {
      next(err);
    }
  });

  app.get('/pdf', (req, res) => {
    if (shuttingDown) {
      return res
        .status(503)
        .send('Service is shutting down');
    }

    let url;

    try {
      if (!req.query.url) {
        return res
          .status(400)
          .send('Missing `url` query parameter');
      }

      url = validateTargetUrl(req.query.url);
    } catch (err) {
      return res
        .status(400)
        .send(`Invalid URL: ${err.message}`);
    }

    if (limit.pendingCount >= MAX_QUEUE_SIZE) {
      console.error(
        `[QUEUE FULL] ` +
        `requestId=${req.requestId} ` +
        `active=${limit.activeCount} ` +
        `pending=${limit.pendingCount} ` +
        `url=${url}`
      );

      res.setHeader('Retry-After', '10');

      return res
        .status(503)
        .send(
          'PDF queue is full, please try again later'
        );
    }

    limit(async () => {
      if (
        res.writableEnded ||
        req.destroyed ||
        shuttingDown
      ) {
        return;
      }

      try {
        const pdfBuffer = await generatePdf(
          url,
          req.requestId
        );

        if (
          !res.headersSent &&
          !res.writableEnded
        ) {
          res
            .type('application/pdf')
            .send(pdfBuffer);
        }
      } catch (err) {
        console.error(
          `[PDF ERROR] ` +
          `requestId=${req.requestId} ` +
          `url=${url} ` +
          `type=${err.name} ` +
          `message=${err.message}`
        );

        if (
          !res.headersSent &&
          !res.writableEnded
        ) {
          const status =
            err.name === 'TimeoutError'
              ? 504
              : 500;

          res
            .status(status)
            .send('Error generating PDF');
        }
      }
    }).catch(err => {
      console.error(
        `[QUEUE ERROR] ` +
        `requestId=${req.requestId} ` +
        `url=${url} ` +
        `type=${err.name} ` +
        `message=${err.message}`
      );

      if (
        !res.headersSent &&
        !res.writableEnded
      ) {
        res
          .status(503)
          .send(
            'PDF service unavailable, please try again later'
          );
      }
    });
  });

  app.get('/health', async (_req, res) => {
    try {
      const connected = Boolean(
        browser && browser.isConnected()
      );

      const status =
        connected && !shuttingDown
          ? 'ok'
          : 'error';

      let version = null;

      if (connected) {
        version = await browser.version();
      }

      res
        .status(status === 'ok' ? 200 : 503)
        .json({
          status,
          browser: connected
            ? 'connected'
            : 'disconnected',
          version,
          shuttingDown,
          queue: {
            active: limit.activeCount,
            pending: limit.pendingCount,
            maxConcurrent:
              MAX_CONCURRENT_REQUESTS,
            maxPending:
              MAX_QUEUE_SIZE
          },
          memory: process.memoryUsage(),
          uptimeSeconds:
            Math.round(process.uptime())
        });
    } catch (err) {
      res.status(503).json({
        status: 'error',
        browser: 'unavailable',
        error: err.message
      });
    }
  });

  app.use((err, req, res, _next) => {
    const status = err instanceof KeyStoreError
      ? err.statusCode
      : err?.status === 400
        ? 400
        : 500;

    console.error(
      `[ADMIN ERROR] requestId=${req.requestId} ` +
      `type=${err.name || 'Error'} message=${err.message}`
    );

    res.status(status).json({
      success: false,
      error: status === 500
        ? 'Internal server error'
        : status === 400 && !(err instanceof KeyStoreError)
          ? 'Invalid JSON payload'
          : err.message
    });
  });

  server = app.listen(PORT, () => {
    console.log(
      `PDF service listening on port ${PORT}; ` +
      `concurrency=${MAX_CONCURRENT_REQUESTS}; ` +
      `maxQueue=${MAX_QUEUE_SIZE}`
    );
  });
}

process.on(
  'SIGTERM',
  () => shutdown('SIGTERM')
);

process.on(
  'SIGINT',
  () => shutdown('SIGINT')
);

process.on('unhandledRejection', reason => {
  console.error(
    '[UNHANDLED REJECTION]',
    reason
  );
});

process.on('uncaughtException', err => {
  console.error(
    '[UNCAUGHT EXCEPTION]',
    err
  );

  shutdown('uncaughtException');
});

main().catch(err => {
  console.error('[STARTUP ERROR]', err);
  process.exit(1);
});
