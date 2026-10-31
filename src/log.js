'use strict';
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
function createLogger(level = 'info') {
  const min = LEVELS[level] ?? 20;
  const out = (lvl, args) => {
    if (LEVELS[lvl] < min) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${args.map(a => (a instanceof Error ? a.message : typeof a === 'object' ? JSON.stringify(a) : a)).join(' ')}`;
    (lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  };
  return {
    debug: (...a) => out('debug', a), info: (...a) => out('info', a),
    warn: (...a) => out('warn', a), error: (...a) => out('error', a),
  };
}
module.exports = { createLogger };
