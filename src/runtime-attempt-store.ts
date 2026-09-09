import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { PraesidiaConfigError } from './errors.js';

/** No credentials, exact arguments or result content are stored in this marker. */
export interface RuntimeAttempt {
  approvalId: string;
  actionId: string;
  requestCommitment: string;
}
export interface RuntimeAttemptStore {
  /** Atomically and durably claim an attempt before network IO. True only for the first
   * claim. Existing conflicting or unreadable records must throw, never reset/retry.
   */
  claim(attempt: RuntimeAttempt): Promise<boolean>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Host-owned POSIX local state. Preserve this directory with runtime checkpoints.
 * Multi-host deployments should provide a shared durable CAS implementation instead.
 * An incomplete marker after a crash stays blocked; never delete it to retry a write.
 */
export class FileRuntimeAttemptStore implements RuntimeAttemptStore {
  constructor(readonly directory: string) {
    if (!isAbsolute(directory)) throw new PraesidiaConfigError('Attempt state requires an absolute host-owned directory');
    if (process.platform === 'win32') throw new PraesidiaConfigError('FileRuntimeAttemptStore requires a POSIX filesystem');
  }
  async claim(attempt: RuntimeAttempt): Promise<boolean> {
    if (!attempt || !UUID.test(attempt.approvalId) || !UUID.test(attempt.actionId) ||
      !/^[a-f0-9]{64}$/.test(attempt.requestCommitment)) throw new PraesidiaConfigError('Invalid attempt identity');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 ||
      (process.getuid && directory.uid !== process.getuid())) {
      throw new PraesidiaConfigError('Attempt directory must be private and owned by the runtime user');
    }
    const path = join(this.directory, `${attempt.approvalId.toLowerCase()}.json`);
    let file;
    try {
      file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A corrupt FIFO marker must fail validation without waiting for a writer.
      const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await existing.stat();
        if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0 ||
          (process.getuid && stat.uid !== process.getuid())) throw new Error('Invalid attempt file');
        const value = JSON.parse(await existing.readFile('utf8')) as RuntimeAttempt;
        if (!value || Object.keys(value).length !== 3 || value.approvalId !== attempt.approvalId ||
          value.actionId !== attempt.actionId || value.requestCommitment !== attempt.requestCommitment) {
          throw new Error('Conflicting attempt');
        }
        return false;
      } catch {
        throw new PraesidiaConfigError('Existing attempt is unreadable or conflicts; inspect the authoritative action without retrying dispatch');
      } finally { await existing.close(); }
    }
    try {
      await file.writeFile(JSON.stringify({ approvalId: attempt.approvalId, actionId: attempt.actionId,
        requestCommitment: attempt.requestCommitment }) + '\n');
      await file.sync();
    } finally { await file.close(); }
    // Persist the marker entry AND each ancestor entry. The attempt directory can be
    // new (including a parent made by another concurrent claimant), so syncing just
    // the leaf would not make its own name durable across a host/power failure.
    // realpath resolves host path aliases such as macOS /tmp before no-follow opens.
    let directoryPath = await realpath(this.directory);
    for (;;) {
      const parent = await open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await parent.sync(); } finally { await parent.close(); }
      const ancestor = dirname(directoryPath);
      if (ancestor === directoryPath) break;
      directoryPath = ancestor;
    }
    return true;
  }
}
