#!/usr/bin/env bun
import { installLifecycle } from './process-diagnostics.mjs';

const lifecycle = installLifecycle(process.argv[2] || 'cli', { signals: process.argv[2] === 'gui' });
// Install diagnostics before loading the application graph, including import failures.
try { await import('./cli-commands.mjs'); }
catch (error) {
  lifecycle.fail(error, 'command_failure');
  console.error(`Command failed; see data/lifecycle or data/supervisor.`);
  process.exit(1);
}
