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
const { MetricsStore, fingerprintApiKey, emptyMetric } = require('./metrics-store');

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

function parseBoundedInteger(name, defaultValue, minimum, maximum) {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue === '') {
    return defaultValue;
  }
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`
    );
  }
  return value;
}

const PDF_REQUEST_TIMEOUT_MS = parseBoundedInteger(
  'PDF_REQUEST_TIMEOUT_MS', 60000, 1000, 300000
);
const BROWSER_MAX_REQUESTS = parseBoundedInteger(
  'BROWSER_MAX_REQUESTS', 5000, 0, 1000000
);
const BROWSER_MAX_UPTIME_SECONDS = parseBoundedInteger(
  'BROWSER_MAX_UPTIME_SECONDS', 21600, 0, 604800
);
const PDF_TIMEOUT_CLEANUP_MS = parseBoundedInteger(
  'PDF_TIMEOUT_CLEANUP_MS', 3000, 100, 30000
);

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
const METRICS_DB_FILE =
  process.env.METRICS_DB_FILE || path.join(__dirname, 'data', 'metrics.sqlite');
const METRICS_ENABLED = !/^(?:0|false|no)$/i.test(process.env.METRICS_ENABLED || 'true');
const METRICS_FLUSH_INTERVAL_MS = parseBoundedInteger(
  'METRICS_FLUSH_INTERVAL_MS', 2000, 100, 60000
);
const METRICS_FLUSH_MAX_EVENTS = parseBoundedInteger(
  'METRICS_FLUSH_MAX_EVENTS', 100, 1, 10000
);
const METRICS_MAX_PENDING_EVENTS = parseBoundedInteger(
  'METRICS_MAX_PENDING_EVENTS', 10000, 100, 1000000
);

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

let masterKey;
let keyStore;
const metricsStore = new MetricsStore({
  file: METRICS_DB_FILE,
  enabled: METRICS_ENABLED,
  flushIntervalMs: METRICS_FLUSH_INTERVAL_MS,
  flushMaxEvents: METRICS_FLUSH_MAX_EVENTS,
  maxPendingEvents: METRICS_MAX_PENDING_EVENTS
});

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
let browserTransitionPromise = null;
let server = null;
let shuttingDown = false;
let browserLaunchedAt = 0;
let browserProcessedRequests = 0;
let recyclePending = false;
let activePages = 0;
let activePdfOperations = 0;
const queuedPdfRequests = new Set();
const activityWaiters = new Set();

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
  browserLaunchedAt = Date.now();
  browserProcessedRequests = 0;
  recyclePending = false;

  console.log('[BROWSER] Chrome ready');

  return launchedBrowser;
}

function notifyActivityChange() {
  for (const waiter of activityWaiters) {
    waiter();
  }
}

function waitForCondition(predicate) {
  if (predicate()) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const check = () => {
      if (!predicate()) return;
      activityWaiters.delete(check);
      resolve();
    };
    activityWaiters.add(check);
  });
}

function settleWithin(promise, timeoutMs) {
  if (timeoutMs <= 0) {
    promise.catch(() => {});
    return Promise.resolve({ settled: false });
  }
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ settled: false }), timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve({ settled: true, value });
      },
      error => {
        clearTimeout(timer);
        resolve({ settled: true, error });
      }
    );
  });
}

function remainingUntil(deadline) {
  return Math.max(0, deadline - Date.now());
}

async function closeBrowserInstance(instance) {
  if (!instance) return;
  try {
    if (instance.isConnected()) {
      await instance.close();
    }
  } catch (err) {
    console.error(`[BROWSER] Close error: ${err.message}`);
  } finally {
    if (browser === instance) {
      browser = null;
    }
  }
}

async function getOrLaunchBrowser() {
  if (browserTransitionPromise) {
    await browserTransitionPromise;
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

function browserUptimeLimitReached() {
  return BROWSER_MAX_UPTIME_SECONDS > 0 &&
    browserLaunchedAt > 0 &&
    Date.now() - browserLaunchedAt >= BROWSER_MAX_UPTIME_SECONDS * 1000;
}

function scheduleBrowserRecycle() {
  if (recyclePending || shuttingDown) return;
  recyclePending = true;
  console.log(
    `[BROWSER RECYCLE] Scheduled after ${browserProcessedRequests} requests`
  );
}

function recycleBrowser() {
  if (!recyclePending || shuttingDown) {
    return Promise.resolve(browser);
  }
  if (browserTransitionPromise) {
    return browserTransitionPromise;
  }
  browserTransitionPromise = (async () => {
    await waitForCondition(() => activePages === 0 || shuttingDown);
    if (shuttingDown) return browser;
    const oldBrowser = browser;
    console.log('[BROWSER RECYCLE] Closing old browser');
    await closeBrowserInstance(oldBrowser);
    await launchBrowser();
    console.log('[BROWSER RECYCLE] New browser ready');
    return browser;
  })().finally(() => {
    browserTransitionPromise = null;
  });
  return browserTransitionPromise;
}

async function recoverBrowser(failedBrowser) {
  if (
    browser &&
    browser !== failedBrowser &&
    browser.isConnected()
  ) {
    return browser;
  }
  if (browserTransitionPromise) {
    return browserTransitionPromise;
  }
  browserTransitionPromise = (async () => {
    console.log('[BROWSER RECOVERY] Relaunching Chrome');
    if (browser === failedBrowser) browser = null;
    await closeBrowserInstance(failedBrowser);
    if (shuttingDown) {
      throw new Error('Service is shutting down');
    }
    await launchBrowser();
    return browser;
  })().finally(() => {
    browserTransitionPromise = null;
  });
  return browserTransitionPromise;
}

async function recycleTimedOutBrowser(affectedBrowser, cleanupDeadline) {
  if (browserTransitionPromise) {
    await settleWithin(
      browserTransitionPromise,
      Math.min(remainingUntil(cleanupDeadline), 250)
    );
  }
  if (affectedBrowser && !affectedBrowser.isConnected()) {
    const launchResult = await settleWithin(
      getOrLaunchBrowser(),
      remainingUntil(cleanupDeadline)
    );
    return { processStopped: true, browserReady: launchResult.settled && !launchResult.error };
  }
  const chromeProcess = typeof affectedBrowser?.process === 'function'
    ? affectedBrowser.process()
    : null;
  let processStopped = false;
  let killSent = false;

  browserTransitionPromise = (async () => {
    console.log('[PDF TIMEOUT] Invalidating affected browser');
    const closeBudget = Math.min(
      remainingUntil(cleanupDeadline),
      Math.max(50, Math.floor(PDF_TIMEOUT_CLEANUP_MS / 3))
    );
    const closeResult = await settleWithin(
      Promise.resolve().then(() => affectedBrowser?.close()),
      closeBudget
    );
    if (closeResult.settled && !closeResult.error) {
      processStopped = true;
    } else if (chromeProcess && typeof chromeProcess.kill === 'function') {
      console.error('[PDF TIMEOUT] browser.close() timed out; sending SIGKILL');
      try {
        killSent = chromeProcess.kill('SIGKILL') !== false;
        processStopped = killSent;
      } catch (killError) {
        console.error(`[PDF TIMEOUT] SIGKILL failed: ${killError.message}`);
      }
    }
    if (shuttingDown) return browser;
    if (browser === affectedBrowser) browser = null;
    if (browser && browser.isConnected()) return browser;
    return launchBrowser();
  })().finally(() => {
    browserTransitionPromise = null;
  });
  const transitionResult = await settleWithin(
    browserTransitionPromise,
    remainingUntil(cleanupDeadline)
  );
  browserTransitionPromise.catch(() => {});
  return {
    processStopped,
    killSent,
    browserReady: transitionResult.settled && !transitionResult.error
  };
}

async function getBrowser() {
  if (shuttingDown) {
    throw new Error('Service is shutting down');
  }
  if (browserUptimeLimitReached()) {
    scheduleBrowserRecycle();
  }
  if (recyclePending) {
    await recycleBrowser();
  }
  return getOrLaunchBrowser();
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

class PdfRequestTimeoutError extends Error {
  constructor() {
    super(`PDF request exceeded ${PDF_REQUEST_TIMEOUT_MS} ms`);
    this.name = 'TimeoutError';
  }
}

function keyNameFor(apiKey) {
  return keyStore.list().keys.find(item => item.key === apiKey)?.name ?? null;
}

function listKeyMetrics(metric) {
  const value = { ...emptyMetric(), ...(metric || {}) };
  return Object.fromEntries([
    'request_count', 'started_count', 'success_count', 'error_count',
    'timeout_count', 'queue_rejected_count', 'client_aborted_count',
    'validation_error_count', 'average_duration_ms', 'min_duration_ms',
    'max_duration_ms', 'last_used_at', 'last_success_at', 'last_error_at'
  ].map(name => [name, value[name]]));
}

function parseDate(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) {
    const error = new Error(`${name} must use YYYY-MM-DD`);
    error.status = 400;
    throw error;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    const error = new Error(`${name} is not a valid date`);
    error.status = 400;
    throw error;
  }
  return date;
}

function metricsDateRange(query) {
  const today = new Date();
  const defaultFrom = new Date(today.getTime() - 30 * 86400000);
  const fromText = query.from || defaultFrom.toISOString().slice(0, 10);
  const toText = query.to || today.toISOString().slice(0, 10);
  const from = parseDate(fromText, 'from');
  const to = parseDate(toText, 'to');
  const days = Math.floor((to - from) / 86400000) + 1;
  if (days < 1 || days > 366) {
    const error = new Error('Date range must contain between 1 and 366 days');
    error.status = 400;
    throw error;
  }
  const fingerprint = query.fingerprint || null;
  if (fingerprint && !/^[a-f0-9]{64}$/.test(fingerprint)) {
    const error = new Error('fingerprint must be a SHA-256 hexadecimal value');
    error.status = 400;
    throw error;
  }
  return { from: fromText, to: toText, fingerprint };
}

function isRecoverableBrowserError(error) {
  if (!error || error.name === 'TimeoutError') return false;
  const text = `${error.name || ''} ${error.message || ''}`;
  return /TargetClosedError|ProtocolError|Browser disconnected|Session closed|Connection closed/i.test(text);
}

function closeContextPage(context, requestId, url) {
  if (!context.page) return Promise.resolve(true);
  if (context.closePromise) return context.closePromise;

  const page = context.page;
  context.closePromise = (async () => {
    if (!page.isClosed()) {
      await page.close();
    }
    return true;
  })().catch(closeError => {
    console.error(
      `[PAGE CLOSE ERROR] requestId=${requestId} ` +
      `url=${url} message=${closeError.message}`
    );
    return false;
  });

  return context.closePromise;
}

function releaseContextPage(context, page) {
  if (!context.pageActive || context.page !== page) return;
  context.pageActive = false;
  activePages -= 1;
  notifyActivityChange();
}

async function generatePdfAttempt(url, requestId, context) {
  let page = null;
  let attemptBrowser = null;

  try {
    if (Date.now() >= context.deadline) {
      throw new PdfRequestTimeoutError();
    }
    attemptBrowser = await getBrowser();
    context.attemptBrowser = attemptBrowser;

    page = await attemptBrowser.newPage();
    context.page = page;
    context.closePromise = null;
    context.pageActive = true;
    activePages += 1;
    notifyActivityChange();
    if (context.timedOut || Date.now() >= context.deadline) {
      throw new PdfRequestTimeoutError();
    }

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

    return { pdfBuffer: Buffer.from(pdfBuffer), attemptBrowser };
  } catch (error) {
    error.attemptBrowser = attemptBrowser;
    throw error;
  } finally {
    if (page) {
      await closeContextPage(context, requestId, url);
      releaseContextPage(context, page);
      if (context.page === page) {
        context.page = null;
        context.closePromise = null;
      }
      if (recyclePending) void recycleBrowser().catch(err => {
        console.error(`[BROWSER RECYCLE] Failed: ${err.message}`);
      });
    }
  }
}

async function generatePdfWithRetry(url, requestId, context) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await generatePdfAttempt(url, requestId, context);
      if (browser === result.attemptBrowser) {
        browserProcessedRequests += 1;
      }
      if (
        browser === result.attemptBrowser &&
        BROWSER_MAX_REQUESTS > 0 &&
        browserProcessedRequests >= BROWSER_MAX_REQUESTS
      ) {
        scheduleBrowserRecycle();
        void recycleBrowser().catch(err => {
          console.error(`[BROWSER RECYCLE] Failed: ${err.message}`);
        });
      }
      return result.pdfBuffer;
    } catch (error) {
      if (context.timedOut || Date.now() >= context.deadline) {
        throw new PdfRequestTimeoutError();
      }
      if (attempt > 0 || !isRecoverableBrowserError(error)) {
        throw error;
      }
      console.error('[BROWSER RECOVERY] Recoverable error detected');
      await recoverBrowser(error.attemptBrowser);
      if (Date.now() >= context.deadline) {
        throw new PdfRequestTimeoutError();
      }
      console.log('[BROWSER RECOVERY] Chrome ready; retrying request');
    }
  }
  throw new Error('PDF generation failed after browser recovery');
}

async function generatePdf(url, requestId) {
  const context = {
    deadline: Date.now() + PDF_REQUEST_TIMEOUT_MS,
    page: null,
    closePromise: null,
    attemptBrowser: null,
    pageActive: false,
    timedOut: false
  };
  let timeoutId;
  const operationPromise = generatePdfWithRetry(url, requestId, context);
  const timeoutPromise = new Promise(resolve => {
    timeoutId = setTimeout(() => {
      context.timedOut = true;
      resolve({ timedOut: true });
    }, PDF_REQUEST_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([
      operationPromise.then(value => ({ value })),
      timeoutPromise
    ]);
    if (!result.timedOut) return result.value;

    console.error(`[PDF TIMEOUT] requestId=${requestId} url=${url}`);
    const cleanupDeadline = Date.now() + PDF_TIMEOUT_CLEANUP_MS;
    const pageCloseResult = await settleWithin(
      closeContextPage(context, requestId, url),
      Math.min(
        remainingUntil(cleanupDeadline),
        Math.max(50, Math.floor(PDF_TIMEOUT_CLEANUP_MS / 3))
      )
    );
    let operationResult = await settleWithin(
      operationPromise,
      Math.min(
        remainingUntil(cleanupDeadline),
        pageCloseResult.settled && pageCloseResult.value === true
          ? Math.max(50, Math.floor(PDF_TIMEOUT_CLEANUP_MS / 3))
          : 0
      )
    );

    if (!operationResult.settled) {
      console.error(
        `[PDF TIMEOUT] Cleanup incomplete; recycling affected browser ` +
        `requestId=${requestId}`
      );
      try {
        const recycleResult = await recycleTimedOutBrowser(
          context.attemptBrowser,
          cleanupDeadline
        );
        if (!recycleResult.processStopped) {
          console.error(
            `[PDF TIMEOUT] Affected Chrome process could not be confirmed stopped ` +
            `requestId=${requestId}`
          );
        }
      } catch (recoveryError) {
        console.error(
          `[PDF TIMEOUT] Browser recycle failed requestId=${requestId} ` +
          `message=${recoveryError.message}`
        );
      }
      operationResult = await settleWithin(
        operationPromise,
        remainingUntil(cleanupDeadline)
      );
      if (!operationResult.settled) {
        operationPromise.catch(() => {});
        releaseContextPage(context, context.page);
      }
    }

    throw new PdfRequestTimeoutError();
  } finally {
    clearTimeout(timeoutId);
    operationPromise.catch(() => {});
  }
}

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(`[SHUTDOWN] Received ${signal}`);

  const queuedResponseFlushes = [];
  for (const queued of queuedPdfRequests) {
    if (!queued.res.headersSent && !queued.res.writableEnded) {
      queuedResponseFlushes.push(new Promise(resolve => {
        queued.res.once('finish', resolve);
        queued.res.once('close', resolve);
      }));
      queued.res.status(503).send('Service is shutting down');
    }
  }
  queuedPdfRequests.clear();
  await Promise.all(queuedResponseFlushes);

  const serverClosePromise = server
    ? new Promise(resolve => server.close(resolve))
    : Promise.resolve();

  const forceExitTimer = setTimeout(() => {
    console.error(
      '[SHUTDOWN] Timed out; forcing exit'
    );

    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  forceExitTimer.unref();

  try {
    console.log(
      `[SHUTDOWN] Waiting for ${activePdfOperations} active PDF request(s)`
    );
    await waitForCondition(() => activePdfOperations === 0);
    await metricsStore.shutdown(2000);
    if (server && typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
    await serverClosePromise;
    if (browserTransitionPromise) {
      try {
        await browserTransitionPromise;
      } catch (err) {
        console.error(`[SHUTDOWN] Browser transition error: ${err.message}`);
      }
    }
    await closeBrowserInstance(browser);
    console.log('[SHUTDOWN] Browser closed');
  } catch (err) {
    console.error(
      `[SHUTDOWN] Browser close error: ${err.message}`
    );
  }

  clearTimeout(forceExitTimer);
  console.log('[SHUTDOWN] Complete');
  logStream.end(() => process.exit(0));
}

async function main() {
  await metricsStore.initialize();
  for (const item of keyStore.list().keys) {
    metricsStore.record(item.key, item.name, 'registered');
  }
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

    req.apiKey = key;
    req.apiKeyName = keyNameFor(key);
    metricsStore.record(key, req.apiKeyName, 'request');
    let abortRecorded = false;
    const recordAbort = () => {
      if (abortRecorded || res.writableEnded) return;
      abortRecorded = true;
      metricsStore.record(key, req.apiKeyName, 'client_aborted');
    };
    req.once('aborted', recordAbort);
    res.once('close', recordAbort);
    next();
  });

  app.use('/admin', (req, res, next) => {
    if (!isBearerAuthorized(req.headers.authorization, masterKey)) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    next();
  });

  app.use((req, res, next) => {
    if (shuttingDown) {
      return res.status(503).send('Service is shutting down');
    }
    next();
  });

  app.post('/admin/create-key', (req, res, next) => {
    try {
      const created = keyStore.create(req.body?.name);
      metricsStore.record(created.key, created.name, 'registered');
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  app.get('/admin/list-keys', async (_req, res, next) => {
    try {
      const listed = keyStore.list();
      const fingerprints = listed.keys.map(item => fingerprintApiKey(item.key));
      const metrics = await metricsStore.metricsForFingerprints(fingerprints);
      res.json({
        success: true,
        keys: listed.keys.map(item => ({
          ...item,
          ...listKeyMetrics(metrics.get(fingerprintApiKey(item.key)))
        }))
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/admin/metrics', async (req, res, next) => {
    try {
      const limitValue = Number(req.query.limit || 100);
      const offset = Number(req.query.offset || 0);
      if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 500 ||
          !Number.isInteger(offset) || offset < 0) {
        const error = new Error('limit must be 1-500 and offset must be non-negative');
        error.status = 400;
        throw error;
      }
      const activeByFingerprint = new Map(
        keyStore.list().keys.map(item => [fingerprintApiKey(item.key), item])
      );
      const rows = await metricsStore.summary(limitValue, offset);
      res.json({
        success: true,
        limit: limitValue,
        offset,
        metrics: rows.map(row => {
          const active = activeByFingerprint.get(row.key_fingerprint);
          return {
            ...row,
            key: active ? active.key : null,
            key_name: row.key_name ?? active?.name ?? null
          };
        })
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/admin/metrics/daily', async (req, res, next) => {
    try {
      const filters = metricsDateRange(req.query);
      res.json({
        success: true,
        ...filters,
        metrics: await metricsStore.daily(filters.from, filters.to, filters.fingerprint)
      });
    } catch (err) {
      next(err);
    }
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
      const name = keyNameFor(req.params.key);
      const result = keyStore.delete(req.params.key);
      metricsStore.markDeleted(req.params.key, name);
      res.json(result);
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
        metricsStore.record(req.apiKey, req.apiKeyName, 'validation_error');
        return res
          .status(400)
          .send('Missing `url` query parameter');
      }

      url = validateTargetUrl(req.query.url);
    } catch (err) {
      metricsStore.record(req.apiKey, req.apiKeyName, 'validation_error');
      return res
        .status(400)
        .send(`Invalid URL: ${err.message}`);
    }

    if (limit.pendingCount >= MAX_QUEUE_SIZE) {
      metricsStore.record(req.apiKey, req.apiKeyName, 'queue_rejected');
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

    const queuedRequest = { req, res };
    queuedPdfRequests.add(queuedRequest);

    limit(async () => {
      queuedPdfRequests.delete(queuedRequest);
      if (
        res.writableEnded ||
        req.destroyed
      ) {
        return;
      }

      if (shuttingDown) {
        if (!res.headersSent && !res.writableEnded) {
          res.status(503).send('Service is shutting down');
        }
        return;
      }

      activePdfOperations += 1;
      notifyActivityChange();
      const metricsStartedAt = Date.now();
      metricsStore.record(req.apiKey, req.apiKeyName, 'started');
      try {
        const pdfBuffer = await generatePdf(
          url,
          req.requestId
        );
        metricsStore.record(
          req.apiKey, req.apiKeyName, 'success', Date.now() - metricsStartedAt
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

          metricsStore.record(
            req.apiKey,
            req.apiKeyName,
            status === 504 ? 'timeout' : 'error',
            Date.now() - metricsStartedAt
          );

          res
            .status(status)
            .send('Error generating PDF');
        }
      } finally {
        activePdfOperations -= 1;
        notifyActivityChange();
      }
    }).catch(err => {
      queuedPdfRequests.delete(queuedRequest);
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
          operations: {
            activePages,
            activePdfOperations
          },
          metrics: metricsStore.health(),
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
