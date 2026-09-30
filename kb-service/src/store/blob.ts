import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface BlobStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** A local file path for the blob (downloaded to a cache for remote stores). */
  localPath(key: string): Promise<string>;
  remove(key: string): Promise<void>;
}

const slug = (s: string) => s.toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9.!_-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';

/** Blob keys use only safe characters, whatever the SharePoint names contain. */
export const safeKey = (...parts: string[]) => parts.map(slug).join('/');

export class LocalBlobStore implements BlobStore {
  constructor(private root: string) {}
  private file(key: string) { return resolve(join(this.root, ...key.split('/'))); }
  async put(key: string, data: Buffer) { const f = this.file(key); await mkdir(dirname(f), { recursive: true }); await writeFile(f, data); }
  async get(key: string) { return readFile(this.file(key)); }
  async localPath(key: string) { return this.file(key); }
  async remove(key: string) { await rm(this.file(key), { force: true }); }
}
