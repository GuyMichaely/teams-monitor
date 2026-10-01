import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { LOCAL_HOME } from './local-paths.mjs';

// The helper only opens an existing local event; it must never launch the stack.
export async function signalKeepAwake({ home = LOCAL_HOME, platform = process.platform, launch = spawn, timeoutMs = 3000 } = {}) {
  if (platform !== 'win32') return { notified: false, reason: 'unavailable' };
  return new Promise(resolve => {
    let child, timer, done = false;
    const finish = result => {
      if (done) return;
      done = true; clearTimeout(timer); resolve(result);
    };
    try {
      child = launch(join(home, 'data', 'desktop', 'TM-signal.exe'), [], {
        windowsHide: true, stdio: 'ignore',
      });
      child.once('error', error => finish({ notified: false, reason: error.code === 'ENOENT' ? 'unavailable' : 'signal_failed' }));
      child.once('exit', code => finish(code === 0 ? { notified: true } : {
        notified: false, reason: code === 2 ? 'unavailable' : 'signal_failed',
      }));
      timer = setTimeout(() => {
        // Only this short-lived helper is owned here, never the tray or its stack.
        try { child.kill(); } catch {}
        finish({ notified: false, reason: 'signal_failed' });
      }, timeoutMs);
    } catch { finish({ notified: false, reason: 'signal_failed' }); }
  });
}
