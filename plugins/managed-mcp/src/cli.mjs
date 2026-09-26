#!/usr/bin/env node
import { loadConfig } from './config.mjs';
import { ManagedActions } from './managed.mjs';
import { serveHttp, serveStdio } from './server.mjs';

try {
  const args = process.argv.slice(2);
  if (!['verify', 'serve'].includes(args[0]) || (args[0] === 'serve' && !['--stdio', '--http'].includes(args[1])) || args.length > (args[0] === 'serve' ? 2 : 1)) {
    throw new Error('Usage: praesidia-managed-mcp verify | serve --stdio | serve --http');
  }
  const actions = new ManagedActions(await loadConfig());
  if (args[0] === 'verify') process.stdout.write(JSON.stringify(await actions.verifyInstallation()) + '\n');
  else {
    await actions.connected();
    const server = await (args[1] === '--stdio' ? serveStdio(actions) : serveHttp(actions));
    process.once('SIGTERM', () => { void server.close(); });
    process.once('SIGINT', () => { void server.close(); });
  }
} catch {
  // Config/transport exceptions can contain supplied values: never print them.
  process.stderr.write('Praesidia managed connection failed closed. Check private configuration and the authoritative installation/checkpoint.\n');
  process.exitCode = 1;
}
