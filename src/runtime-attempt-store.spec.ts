import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, stat, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { FileRuntimeAttemptStore } from './runtime-attempt-store.js';
const attempt = { approvalId: '20000000-0000-4000-8000-000000000001',
  actionId: '30000000-0000-4000-8000-000000000001', requestCommitment: 'a'.repeat(64) };
const directories: string[] = [];
const directory = async () => { const path = await mkdtemp(join(tmpdir(), 'praesidia-attempt-')); directories.push(path); return path; };
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
describe('durable attempt claims', () => {
  it('persists a minimal private claim that fresh store instances cannot repeat', async () => {
    const path = await directory();
    expect(await new FileRuntimeAttemptStore(path).claim(attempt)).toBe(true);
    expect(await new FileRuntimeAttemptStore(path).claim(attempt)).toBe(false);
    const file = join(path, `${attempt.approvalId}.json`);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(attempt);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
  it('admits at most one concurrent independent claimant', async () => {
    const path = join(await directory(), 'new-plugin', 'new-attempts');
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => new FileRuntimeAttemptStore(path).claim(attempt)));
    expect(results.filter(result => result.status === 'fulfilled' && result.value)).toHaveLength(1);
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
