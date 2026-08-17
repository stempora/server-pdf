const Module = require('node:module');
const fs = require('node:fs');

const originalLoad = Module._load;
let generation = 0;
let activePdfCalls = 0;
let maxActivePdfCalls = 0;

if (process.env.MOCK_SIGNAL_STDIN === '1') {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', signal => process.emit(signal.trim()));
}

function record(type, details = {}) {
  if (!process.env.MOCK_PUPPETEER_STATE_FILE) return;
  let state = { events: [], launches: 0 };
  try {
    state = JSON.parse(fs.readFileSync(process.env.MOCK_PUPPETEER_STATE_FILE, 'utf8'));
  } catch (_error) {}
  if (type === 'launch') state.launches += 1;
  state.activePdfCalls = activePdfCalls;
  state.maxActivePdfCalls = Math.max(state.maxActivePdfCalls || 0, maxActivePdfCalls);
  state.events.push({ type, generation, at: Date.now(), ...details });
  fs.writeFileSync(process.env.MOCK_PUPPETEER_STATE_FILE, JSON.stringify(state));
}

function delay(ms, pageState) {
  return new Promise((resolve, reject) => {
    const timer = ms === Infinity ? null : setTimeout(resolve, ms);
    pageState.rejectDelay = reason => {
      if (pageState.operationNever && reason !== 'sigkill') return;
      clearTimeout(timer);
      const error = new Error('Target closed while rendering');
      error.name = 'TargetClosedError';
      reject(error);
    };
  });
}

Module._load = function load(request, parent, isMain) {
  if (request !== 'puppeteer') return originalLoad.call(this, request, parent, isMain);

  return {
    launch: async () => {
      generation += 1;
      const thisGeneration = generation;
      let connected = true;
      let activePages = 0;
      const browserPageStates = new Set();
      const mockProcess = {
        kill: signal => {
          record('process-kill', { signal, browserGeneration: thisGeneration });
          connected = false;
          for (const pageState of browserPageStates) {
            if (pageState.finishPdf) pageState.finishPdf('sigkill');
            if (pageState.rejectDelay) pageState.rejectDelay('sigkill');
          }
          return true;
        }
      };
      record('launch');
      return {
        on() {},
        process: () => mockProcess,
        isConnected: () => connected,
        version: async () => `MockChrome/${thisGeneration}`,
        close: async () => {
          if (Array.from(browserPageStates).some(pageState => pageState.browserCloseHangs)) {
            record('browser-close-hang', { activePages, browserGeneration: thisGeneration });
            return new Promise(() => {});
          }
          connected = false;
          record('browser-close', { activePages, browserGeneration: thisGeneration });
          for (const pageState of browserPageStates) {
            if (pageState.finishPdf) pageState.finishPdf('browser-close');
            if (pageState.rejectDelay) pageState.rejectDelay('browser-close');
          }
        },
        newPage: async () => {
          let closed = false;
          let targetUrl = '';
          const pageState = { rejectDelay: null };
          browserPageStates.add(pageState);
          activePages += 1;
          record('page-open', { browserGeneration: thisGeneration });
          return {
            setDefaultNavigationTimeout() {},
            setDefaultTimeout() {},
            goto: async url => {
              targetUrl = url;
              const parsed = new URL(url);
              pageState.browserCloseHangs = parsed.searchParams.get('mockBrowserCloseHangs') === '1';
              pageState.operationNever = parsed.searchParams.get('mockOperationNever') === '1';
            },
            evaluate: async () => {},
            pdf: async () => {
              activePdfCalls += 1;
              maxActivePdfCalls = Math.max(maxActivePdfCalls, activePdfCalls);
              pageState.pdfActive = true;
              pageState.finishPdf = reason => {
                if (!pageState.pdfActive) return;
                pageState.pdfActive = false;
                activePdfCalls -= 1;
                record('pdf-process-stop', { targetUrl, reason, browserGeneration: thisGeneration });
              };
              record('pdf-start', { targetUrl, browserGeneration: thisGeneration });
              try {
                const parsed = new URL(targetUrl);
                const delayMs = pageState.operationNever
                  ? Infinity
                  : Number(parsed.searchParams.get('mockDelay') || 0);
                if (delayMs > 0) await delay(delayMs, pageState);
                if (parsed.searchParams.get('mockError') === 'recoverable' && thisGeneration === 1) {
                  const error = new Error('Browser disconnected');
                  error.name = 'TargetClosedError';
                  throw error;
                }
                if (parsed.searchParams.get('mockError') === 'normal') {
                  throw new Error('Page render failed');
                }
                return Buffer.from('%PDF-1.4\nmock\n');
              } finally {
                pageState.finishPdf('promise-finally');
                browserPageStates.delete(pageState);
                record('pdf-end', { targetUrl, browserGeneration: thisGeneration });
              }
            },
            isClosed: () => closed,
            close: async () => {
              if (closed) return;
              record('page-close-attempt', { targetUrl, browserGeneration: thisGeneration });
              const parsed = targetUrl ? new URL(targetUrl) : null;
              if (parsed?.searchParams.get('mockCloseFails') === '1') {
                throw new Error('Mock page close failed');
              }
              if (parsed?.searchParams.get('mockPageCloseHangs') === '1') {
                return new Promise(() => {});
              }
              closed = true;
              activePages -= 1;
              record('page-close', { browserGeneration: thisGeneration });
              if (
                parsed?.searchParams.get('mockContinueAfterClose') !== '1' &&
                pageState.rejectDelay
              ) {
                pageState.rejectDelay('page-close');
              }
            }
          };
        }
      };
    }
  };
};
