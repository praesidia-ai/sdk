import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { jcsCanonicalize } from '@praesidia/sdk';

/** Private, local POSIX state. An incomplete record blocks recovery; never overwrite it. */
export class State {
  constructor(directory) {
    if (!isAbsolute(directory) || process.platform === 'win32') throw new Error('Private absolute POSIX state directory required');
    this.directory = directory;
  }
  async directoryReady() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.uid !== process.getuid()) {
      throw new Error('State directory must be private and owned by this user');
    }
  }
  path(name) {
    if (!/^[a-z0-9-]{1,100}$/.test(name)) throw new Error('Invalid state name');
    return join(this.directory, name + '.json');
  }
  async read(name) {
    await this.directoryReady();
    const file = await open(this.path(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 262144 || stat.mode & 0o077 || stat.uid !== process.getuid()) throw new Error('Unsafe state record');
      return JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
  }
  async writeOnce(name, value) {
    await this.directoryReady();
    const bytes = jcsCanonicalize(value);
    if (bytes.length > 262144) throw new Error('State record exceeds limit');
    let file;
    try {
      file = await open(this.path(name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!jcsCanonicalize(await this.read(name)).equals(bytes)) throw new Error('Stored request conflicts; never replace a pending action');
      return;
    }
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    let path = await realpath(this.directory);
    for (;;) {
      const parent = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await parent.sync(); } finally { await parent.close(); }
      const next = dirname(path);
      if (next === path) break;
      path = next;
    }
  }
}
