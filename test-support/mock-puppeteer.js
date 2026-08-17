const Module = require('node:module');
const fs = require('node:fs');

const originalLoad = Module._load;
let generation = 0;

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
  state.events.push({ type, generation, at: Date.now(), ...details });
  fs.writeFileSync(process.env.MOCK_PUPPETEER_STATE_FILE, JSON.stringify(state));
}

function delay(ms, pageState) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    pageState.rejectDelay = () => {
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
      record('launch');
      return {
        on() {},
        isConnected: () => connected,
        version: async () => `MockChrome/${thisGeneration}`,
        close: async () => {
          connected = false;
          record('browser-close', { activePages, browserGeneration: thisGeneration });
        },
        newPage: async () => {
          let closed = false;
          let targetUrl = '';
          const pageState = { rejectDelay: null };
          activePages += 1;
          record('page-open', { browserGeneration: thisGeneration });
          return {
            setDefaultNavigationTimeout() {},
            setDefaultTimeout() {},
            goto: async url => { targetUrl = url; },
            evaluate: async () => {},
            pdf: async () => {
              const parsed = new URL(targetUrl);
              const delayMs = Number(parsed.searchParams.get('mockDelay') || 0);
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
            },
            isClosed: () => closed,
            close: async () => {
              if (closed) return;
              closed = true;
              activePages -= 1;
              record('page-close', { browserGeneration: thisGeneration });
              if (pageState.rejectDelay) pageState.rejectDelay();
            }
          };
        }
      };
    }
  };
};
