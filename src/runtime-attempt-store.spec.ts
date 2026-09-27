import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { FileRuntimeAttemptStore } from './runtime-attempt-store.js';
const attempt = { approvalId: '20000000-0000-4000-8000-000000000001',
  actionId: '30000000-0000-4000-8000-000000000001', requestCommitment: 'a'.repeat(64) };
// fsync latency tracks host IO pressure (8 serial syncs per claim: ~3 ms idle, 30-200 ms each
// under load), which timed these tests out in shared gates. Record each sync by path instead:
// the durability contract (what gets synced, in which order) is asserted, not the disk latency.
const { synced } = vi.hoisted(() => ({ synced: [] as string[] }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  const open: typeof fs.open = async (path, ...rest) => {
    const handle = await fs.open(path, ...rest);
    handle.sync = async () => { synced.push(String(path)); };
    return handle;
  };
  return { ...fs, open };
});
const ancestors = async (path: string) => {
  const chain = [await realpath(path)];
  while (dirname(chain[chain.length - 1]) !== chain[chain.length - 1]) chain.push(dirname(chain[chain.length - 1]));
  return chain;
};
const directories: string[] = [];
const directory = async () => { const path = await mkdtemp(join(tmpdir(), 'praesidia-attempt-')); directories.push(path); return path; };
afterEach(async () => { synced.splice(0); for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
describe('durable attempt claims', () => {
  it('persists a minimal private claim that fresh store instances cannot repeat', async () => {
    const path = await directory();
    expect(await new FileRuntimeAttemptStore(path).claim(attempt)).toBe(true);
    const file = join(path, `${attempt.approvalId}.json`);
    // Marker first, then its directory entry and every ancestor entry up to the root.
    expect(synced).toEqual([file, ...await ancestors(path)]);
    expect(await new FileRuntimeAttemptStore(path).claim(attempt)).toBe(false);
    expect(synced).toHaveLength(1 + (await ancestors(path)).length);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(attempt);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
  it('admits at most one concurrent independent claimant', async () => {
    const path = join(await directory(), 'new-plugin', 'new-attempts');
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => new FileRuntimeAttemptStore(path).claim(attempt)));
    expect(results.filter(result => result.status === 'fulfilled' && result.value)).toHaveLength(1);
    // The winner makes the concurrently created parents durable too, not just the leaf.
    expect(synced.filter(entry => entry.endsWith('.json'))).toHaveLength(1);
    expect(synced).toEqual(expect.arrayContaining(await ancestors(path)));
    expect(await new FileRuntimeAttemptStore(path).claim(attempt)).toBe(false);
  });
  it('never overwrites a conflicting or incomplete marker', async () => {
    const path = await directory();
    await new FileRuntimeAttemptStore(path).claim(attempt);
    await expect(new FileRuntimeAttemptStore(path).claim({ ...attempt, requestCommitment: 'b'.repeat(64) })).rejects.toThrow('conflicts');
    const file = join(path, `${attempt.approvalId}.json`);
    await writeFile(file, '');
    await expect(new FileRuntimeAttemptStore(path).claim(attempt)).rejects.toThrow('unreadable');
    expect(await readFile(file, 'utf8')).toBe('');
  });
  it('rejects a FIFO marker without blocking on a writer', async () => {
    const path = await directory();
    execFileSync('/usr/bin/mkfifo', [join(path, `${attempt.approvalId}.json`)]);
    await expect(new FileRuntimeAttemptStore(path).claim(attempt)).rejects.toThrow('unreadable');
  });
  it('refuses broad permissions, symlinked state and malformed identity', async () => {
    const path = await directory();
    await chmod(path, 0o755);
    await expect(new FileRuntimeAttemptStore(path).claim(attempt)).rejects.toThrow('private');
    await chmod(path, 0o700);
    const link = join(path, 'state'); await symlink(path, link);
    await expect(new FileRuntimeAttemptStore(link).claim(attempt)).rejects.toThrow('private');
    await expect(new FileRuntimeAttemptStore(path).claim({ ...attempt, approvalId: '../outside' })).rejects.toThrow('identity');
    expect(() => new FileRuntimeAttemptStore('relative')).toThrow('absolute');
  });
});
