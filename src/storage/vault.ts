import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { StoragePaths } from '../config/paths.js';
import { ApigoError } from '../core/errors.js';

export function privateFile(path: string): void {
  if (!existsSync(path)) return;
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new ApigoError('UNSAFE_STORAGE', 'Storage files must be regular files, not symbolic links.');
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new ApigoError('UNSAFE_STORAGE', 'Storage files must be accessible only to their owner.', 2, 'Set the apigo database and key file permissions to 600.');
}

export class Vault {
  private readonly key: Buffer;

  constructor(paths: StoragePaths) {
    mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(paths.directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new ApigoError('UNSAFE_STORAGE', 'Choose a dedicated directory for apigo storage.');
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new ApigoError('UNSAFE_STORAGE', 'The apigo storage directory must be private.', 2, 'Choose a new dedicated directory or set its permissions to 700.');
    const supplied = process.env.APIGO_SECRET_KEY;
    if (supplied !== undefined) {
      this.key = Buffer.from(supplied, 'base64');
      if (this.key.length !== 32 || this.key.toString('base64').replace(/=+$/, '') !== supplied.replace(/=+$/, '')) throw new ApigoError('INVALID_KEY', 'APIGO_SECRET_KEY must be a base64-encoded 32-byte key.');
      return;
    }
    if (!existsSync(paths.key)) {
      if (existsSync(paths.database) && lstatSync(paths.database).size > 0) throw new ApigoError('MISSING_KEY', 'The encryption key for this database is missing.', 2, 'Restore secret.key from your backup; a new key cannot decrypt existing data.');
      try { writeFileSync(paths.key, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (!existsSync(paths.key)) throw error; }
    }
    privateFile(paths.key);
    this.key = readFileSync(paths.key);
    if (this.key.length !== 32) throw new ApigoError('INVALID_KEY', 'The local encryption key is invalid.');
  }

  seal(value: unknown, purpose: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(purpose));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
  }

  open<T>(value: string, purpose: string): T {
    try {
      const [version, iv, tag, ciphertext] = value.split('.');
      if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Invalid encrypted payload');
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
      decipher.setAAD(Buffer.from(purpose));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8')) as T;
    } catch { throw new ApigoError('DECRYPTION_FAILED', 'Could not decrypt local data.', 2, 'Check that this database and its encryption key belong together.'); }
  }
}
