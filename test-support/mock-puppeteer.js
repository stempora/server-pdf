const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request !== 'puppeteer') return originalLoad.call(this, request, parent, isMain);

  return {
    launch: async () => {
      let connected = true;
      return {
        on() {},
        isConnected: () => connected,
        version: async () => 'MockChrome/1.0',
        close: async () => { connected = false; },
        newPage: async () => {
          let closed = false;
          return {
            setDefaultNavigationTimeout() {},
            setDefaultTimeout() {},
            goto: async () => {},
            evaluate: async () => {},
            pdf: async () => Buffer.from('%PDF-1.4\nmock\n'),
            isClosed: () => closed,
            close: async () => { closed = true; }
          };
        }
      };
    }
  };
};
