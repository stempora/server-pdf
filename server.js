const express = require('express');
const puppeteer = require('puppeteer');
const pLimit = require('p-limit');
const fs = require('fs');
const path = require('path');

// Configuration
const MAX_CONCURRENT_REQUESTS = parseInt(process.env.MAX_CONCURRENT_REQUESTS, 10) || 10;
const API_KEYS_FILE = process.env.API_KEYS_FILE || path.join(__dirname, 'apikeys.json');
const PORT = parseInt(process.env.PORT, 10) || 3000;
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Load valid API keys
let validKeys;
try {
  const raw = fs.readFileSync(API_KEYS_FILE, 'utf8');
  validKeys = JSON.parse(raw);
  if (!Array.isArray(validKeys)) {
    throw new Error('API key file must contain an array of valid keys');
  }
} catch (err) {
  console.error(`Failed to load API keys from ${API_KEYS_FILE}:`, err);
  process.exit(1);
}

// Concurrency limiter
const limit = pLimit(MAX_CONCURRENT_REQUESTS);

// Logging setup
let currentDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
let logStream = fs.createWriteStream(path.join(LOG_DIR, `${currentDate}.log`), { flags: 'a' });

function logRequest(req) {
  const now = new Date();
  const timestamp = now.toISOString();
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const link = req.originalUrl;
  const today = timestamp.slice(0, 10);

  if (today !== currentDate) {
    logStream.end();
    currentDate = today;
    logStream = fs.createWriteStream(path.join(LOG_DIR, `${currentDate}.log`), { flags: 'a' });
  }

  logStream.write(`[${timestamp}] ${ip} ${link}\n`);
}

(async () => {
  // Launch browser once, using full Chrome
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const app = express();

  // Global request logging
  app.use((req, res, next) => {
    logRequest(req);
    next();
  });

  // API key auth
  app.use('/pdf', (req, res, next) => {
    const key = req.query.apikey || req.headers['x-api-key'];
    if (!key || !validKeys.includes(key)) {
      return res.status(401).send('Unauthorized: invalid or missing API key');
    }
    next();
  });

  // PDF endpoint
  app.get('/pdf', (req, res) => {
    const url = req.query.url;
    if (!url) {
      return res.status(400).send('Missing `url` query parameter');
    }

    limit(async () => {
      let page;
      try {
        page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle0' });
        await page.evaluate(() => document.fonts.ready);

        const pdfBuffer = await page.pdf({
          format: 'A4',
          printBackground: true,
          margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
        });

        res.type('application/pdf').send(pdfBuffer);
      } catch (err) {
        console.error('Error generating PDF:', err);
        if (!res.headersSent) res.status(500).send('Error generating PDF');
      } finally {
        if (page) await page.close();
      }
    }).catch(err => {
      console.error('Queue error:', err);
      if (!res.headersSent) res.status(503).send('Server busy, please try again later');
    });
  });

  // Health check
  app.get('/health', (_req, res) => res.send('OK'));

  // Start server
  app.listen(PORT, () => console.log(`PDF service listening on port ${PORT}`));
})();
