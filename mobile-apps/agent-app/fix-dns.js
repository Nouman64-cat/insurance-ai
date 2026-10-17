const dns = require('dns');
const origLookup = dns.lookup;
dns.lookup = function(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = { family: 4 };
  } else if (typeof options === 'object') {
    options.family = 4;
  } else if (typeof options === 'number') {
    options = { family: 4 };
  }
  return origLookup(hostname, options, callback);
};

// Patch undici (Node 18+ native fetch engine)
try {
  const { setGlobalDispatcher, Agent } = require('undici');
  setGlobalDispatcher(new Agent({ connect: { lookup: dns.lookup } }));
} catch (e) {}
