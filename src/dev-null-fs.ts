import { posix } from 'node:path';
import { EMPTY_BYTES } from 'just-bash';
import type { ByteString, CpOptions, FileContent, FsStat, IFileSystem, MkdirOptions, RmOptions } from 'just-bash';

export const DEV_NULL = '/dev/null';

const NULL_STAT: FsStat = {
  isFile: false,
  isDirectory: false,
  isSymbolicLink: false,
  // Character device, rw for everyone — what `stat /dev/null` reports on a real system.
  mode: 0o20666,
  size: 0,
  mtime: new Date(0),
};

type Kind = 'null' | 'under-null' | 'other';

function kind(p: string): Kind {
  const n = posix.normalize(p);
  if (n === DEV_NULL) return 'null';
  return n.startsWith(`${DEV_NULL}/`) ? 'under-null' : 'other';
}

function fsError(code: 'EPERM' | 'ENOTDIR', op: string, p: string): Error {
  const text = code === 'EPERM' ? 'operation not permitted' : 'not a directory';
  return Object.assign(new Error(`${code}: ${text}, ${op} '${p}'`), { code });
}

type FullFileSystem = IFileSystem & Required<Pick<IFileSystem, 'readFileBytes' | 'readdirWithFileTypes'>>;

/**
 * Wraps a filesystem so `/dev/null` behaves like the null device instead of a
 * path under the sandbox root.
 *
 * just-bash has no special case for `/dev/null` in redirections: `cmd 2>/dev/null`
 * calls `fs.writeFile('/dev/null', ...)`. Its InMemoryFs pre-creates a
 * `/dev/null` file to absorb that, but ReadWriteFs maps the path straight onto
 * disk, so every redirect (including the one inside Flue's built-in `glob` tool)
 * creates a real `<bank>/fs/dev/null` file.
 *
 * Here writes and appends to `/dev/null` are discarded and reads return empty,
 * without touching the delegate. Structural operations on it (rm, mv, chmod,
 * mkdir, ...) are refused, and so is any path below it, since it is not a
 * directory — otherwise `mkdir -p /dev/null/x` would create `<root>/dev/null/x`.
 * Every other path goes to the delegate unchanged, so its root containment is
 * exactly what it was.
 */
export class DevNullFs implements IFileSystem {
  constructor(private readonly inner: FullFileSystem) {}

  /** `onNull` handles `/dev/null` itself, paths below it fail with ENOTDIR, the rest go to `passthrough`. */
  private route<T>(op: string, p: string, onNull: () => Promise<T>, passthrough: () => Promise<T>): Promise<T> {
    switch (kind(p)) {
      case 'null':
        return onNull();
      case 'under-null':
        return Promise.reject(fsError('ENOTDIR', op, p));
      default:
        return passthrough();
    }
  }

  private refuse<T>(code: 'EPERM' | 'ENOTDIR', op: string, p: string): () => Promise<T> {
    return () => Promise.reject(fsError(code, op, p));
  }

  readFile(path: string, options?: Parameters<IFileSystem['readFile']>[1]): Promise<string> {
    return this.route('open', path, async () => '', () => this.inner.readFile(path, options));
  }

  readFileBytes(path: string): Promise<ByteString> {
    return this.route('open', path, async () => EMPTY_BYTES, () => this.inner.readFileBytes(path));
  }

  readFileBuffer(path: string): Promise<Uint8Array> {
    return this.route('open', path, async () => new Uint8Array(0), () => this.inner.readFileBuffer(path));
  }

  writeFile(path: string, content: FileContent, options?: Parameters<IFileSystem['writeFile']>[2]): Promise<void> {
    return this.route('open', path, async () => {}, () => this.inner.writeFile(path, content, options));
  }

  appendFile(path: string, content: FileContent, options?: Parameters<IFileSystem['appendFile']>[2]): Promise<void> {
    return this.route('open', path, async () => {}, () => this.inner.appendFile(path, content, options));
  }

  exists(path: string): Promise<boolean> {
    return this.route('access', path, async () => true, () => this.inner.exists(path)).catch(() => false);
  }

  stat(path: string): Promise<FsStat> {
    return this.route('stat', path, async () => ({ ...NULL_STAT }), () => this.inner.stat(path));
  }

  lstat(path: string): Promise<FsStat> {
    return this.route('lstat', path, async () => ({ ...NULL_STAT }), () => this.inner.lstat(path));
  }

  realpath(path: string): Promise<string> {
    return this.route('realpath', path, async () => DEV_NULL, () => this.inner.realpath(path));
  }

  readlink(path: string): Promise<string> {
    return this.route('readlink', path, this.refuse('EPERM', 'readlink', path), () => this.inner.readlink(path));
  }

  readdir(path: string): Promise<string[]> {
    return this.route('scandir', path, this.refuse('ENOTDIR', 'scandir', path), () => this.inner.readdir(path));
  }

  readdirWithFileTypes(path: string): ReturnType<FullFileSystem['readdirWithFileTypes']> {
    return this.route('scandir', path, this.refuse('ENOTDIR', 'scandir', path), () =>
      this.inner.readdirWithFileTypes(path),
    );
  }

  mkdir(path: string, options?: MkdirOptions): Promise<void> {
    return this.route('mkdir', path, this.refuse('EPERM', 'mkdir', path), () => this.inner.mkdir(path, options));
  }

  rm(path: string, options?: RmOptions): Promise<void> {
    return this.route('rm', path, this.refuse('EPERM', 'rm', path), () => this.inner.rm(path, options));
  }

  chmod(path: string, mode: number): Promise<void> {
    return this.route('chmod', path, this.refuse('EPERM', 'chmod', path), () => this.inner.chmod(path, mode));
  }

  utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    return this.route('utimes', path, async () => {}, () => this.inner.utimes(path, atime, mtime));
  }

  symlink(target: string, linkPath: string): Promise<void> {
    return this.route('symlink', linkPath, this.refuse('EPERM', 'symlink', linkPath), () =>
      this.inner.symlink(target, linkPath),
    );
  }

  cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    return this.route('cp', src, this.refuse('EPERM', 'cp', src), () =>
      this.route('cp', dest, async () => {}, () => this.inner.cp(src, dest, options)),
    );
  }

  mv(src: string, dest: string): Promise<void> {
    return this.route('rename', src, this.refuse('EPERM', 'rename', src), () =>
      this.route('rename', dest, this.refuse('EPERM', 'rename', dest), () => this.inner.mv(src, dest)),
    );
  }

  link(existingPath: string, newPath: string): Promise<void> {
    return this.route('link', existingPath, this.refuse('EPERM', 'link', existingPath), () =>
      this.route('link', newPath, this.refuse('EPERM', 'link', newPath), () => this.inner.link(existingPath, newPath)),
    );
  }

  resolvePath(base: string, path: string): string {
    return this.inner.resolvePath(base, path);
  }

  getAllPaths(): string[] {
    return this.inner.getAllPaths();
  }
}
