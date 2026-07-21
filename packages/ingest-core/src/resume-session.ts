import path from 'node:path';

export type RecoveryCopyStatus = 'planned' | 'started' | 'failed' | 'verified';

export interface RecoveryCopy {
  id: string;
  status: RecoveryCopyStatus;
  expectedBytes: number;
  expectedChecksum: string | null;
  sourceRelativePath: string;
  destinationPath: string;
  temporaryPath?: string;
  provisionalPath?: string;
  copiedBytes?: number;
  checksum?: string | null;
}

export interface RecoverySession {
  id: string;
  status: string;
  copies: RecoveryCopy[];
}

export interface RecoveryRoots {
  destinationRoot: string;
  temporaryRoot: string;
  provisionalRoot: string;
}

export interface RecoveryFileFacts {
  exists: true;
  kind: 'file' | 'directory' | 'symlink' | 'other';
  sizeBytes: number;
  fileId?: string;
}

export interface RecoveryDependencies {
  loadSession(sessionId: string): Promise<RecoverySession | undefined>;
  roots(sessionId: string): Promise<RecoveryRoots>;
  sourceAvailable(session: RecoverySession): Promise<boolean>;
  lstat(path: string): Promise<{ exists: false } | RecoveryFileFacts>;
  realpath(path: string): Promise<string>;
  hash(path: string, expectedFileId?: string): Promise<string>;
  remove(path: string, expectedFileId?: string): Promise<void>;
  quarantine(path: string, expectedFileId?: string): Promise<void>;
  resetCopy(copyId: string): Promise<void>;
  markVerified(copyId: string, checksum: string, bytes: number): Promise<void>;
  promoteProvisional?(copy: RecoveryCopy, provisionalPath: string): Promise<void>;
  scheduleCopy(copy: RecoveryCopy, signal: AbortSignal): Promise<void>;
  markSession(sessionId: string, status: 'completed' | 'cancelled' | 'failed'): Promise<void>;
  regenerateManifest(sessionId: string): Promise<void>;
  audit(event: {
    sessionId: string;
    action: 'resume' | 'cleanup';
    outcome: 'completed' | 'paused' | 'cancelled' | 'failed';
    detail?: string;
  }): Promise<void>;
}

export type ResumeResult =
  | { sessionId: string; status: 'completed'; scheduled: number }
  | {
      sessionId: string;
      status: 'paused';
      reason: 'source-unavailable';
      scheduled: number;
    };

export interface ResumeSessionCoordinator {
  resume(sessionId: string, signal?: AbortSignal): Promise<ResumeResult>;
  cleanup(sessionId: string, signal?: AbortSignal): Promise<void>;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function assertRelativeSourcePath(value: string): void {
  if (
    value.trim() === '' ||
    path.isAbsolute(value) ||
    /^(?:[\\/]|[A-Za-z]:[\\/])/.test(value) ||
    value.split(/[\\/]/).some((segment) => segment === '..' || segment === '')
  ) {
    throw new Error('Recovery source path must be a safe relative path.');
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Recovery cancelled', 'AbortError');
}

function assertOwnedTemporaryPath(
  sessionId: string,
  copy: RecoveryCopy,
  roots: RecoveryRoots,
): void {
  if (copy.temporaryPath === undefined) return;
  const sessionDirectory = path.basename(path.resolve(roots.temporaryRoot)) === sessionId;
  const expectedAdjacent = path.join(
    path.dirname(copy.destinationPath),
    `.${path.basename(copy.destinationPath)}.${sessionId}.${copy.id}.tmp`,
  );
  if (!sessionDirectory && path.resolve(copy.temporaryPath) !== path.resolve(expectedAdjacent)) {
    throw new Error('Recovery temporary path is not owned by this session and copy.');
  }
}

function assertOwnedProvisionalPath(
  sessionId: string,
  copy: RecoveryCopy,
  roots: RecoveryRoots,
): void {
  if (copy.provisionalPath === undefined) return;
  const sessionDirectory = path.basename(path.resolve(roots.provisionalRoot)) === sessionId;
  if (
    !sessionDirectory &&
    path.resolve(copy.provisionalPath) !== path.resolve(copy.destinationPath)
  ) {
    throw new Error('Recovery provisional path is not owned by this session and copy.');
  }
}

async function inspectOwnedFile(
  dependencies: RecoveryDependencies,
  root: string,
  candidate: string,
): Promise<(RecoveryFileFacts & { canonicalPath: string }) | undefined> {
  const lexicalRoot = path.resolve(root);
  const lexicalCandidate = path.resolve(candidate);
  if (!isWithin(lexicalRoot, lexicalCandidate) || lexicalCandidate === lexicalRoot) {
    throw new Error('Recovery path is outside the session-owned canonical root.');
  }
  const canonicalRoot = await dependencies.realpath(lexicalRoot);
  const first = await dependencies.lstat(lexicalCandidate);
  if (!first.exists) return undefined;
  if (first.kind === 'symlink') throw new Error('Recovery refuses session-owned symlinks.');
  if (first.kind !== 'file') throw new Error('Recovery-owned artifact must be a regular file.');
  const canonicalCandidate = await dependencies.realpath(lexicalCandidate);
  if (!isWithin(canonicalRoot, canonicalCandidate)) {
    throw new Error('Recovery path escapes the session-owned canonical root.');
  }
  const second = await dependencies.lstat(lexicalCandidate);
  if (
    !second.exists ||
    second.kind !== 'file' ||
    (first.fileId !== undefined && second.fileId !== first.fileId)
  ) {
    throw new Error('Recovery artifact changed during validation.');
  }
  return { ...second, canonicalPath: canonicalCandidate };
}

async function removeOwnedFile(
  dependencies: RecoveryDependencies,
  root: string,
  candidate: string,
): Promise<boolean> {
  const facts = await inspectOwnedFile(dependencies, root, candidate);
  if (facts === undefined) return false;
  await dependencies.remove(facts.canonicalPath, facts.fileId);
  return true;
}

export function createResumeSessionCoordinator(
  dependencies: RecoveryDependencies,
): ResumeSessionCoordinator {
  const queues = new Map<string, Promise<unknown>>();
  const deduplicated = new Map<string, Promise<unknown>>();

  function runExclusive<T>(
    sessionId: string,
    action: 'resume' | 'cleanup',
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${sessionId}\0${action}`;
    const duplicate = deduplicated.get(key);
    if (duplicate !== undefined) return duplicate as Promise<T>;
    const previous = queues.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    deduplicated.set(key, current);
    queues.set(sessionId, current);
    const release = (): void => {
      if (deduplicated.get(key) === current) deduplicated.delete(key);
      if (queues.get(sessionId) === current) queues.delete(sessionId);
    };
    void current.then(release, release);
    return current;
  }

  function resume(sessionId: string, signal = new AbortController().signal): Promise<ResumeResult> {
    return runExclusive(sessionId, 'resume', async () => {
      try {
        throwIfAborted(signal);
        const session = await dependencies.loadSession(sessionId);
        if (session === undefined || session.id !== sessionId) {
          throw new Error(`Recovery session ${sessionId} does not exist.`);
        }
        const roots = await dependencies.roots(sessionId);
        const pending: RecoveryCopy[] = [];

        for (const copy of session.copies) {
          throwIfAborted(signal);
          assertRelativeSourcePath(copy.sourceRelativePath);
          assertOwnedTemporaryPath(sessionId, copy, roots);
          assertOwnedProvisionalPath(sessionId, copy, roots);
          if (!isWithin(path.resolve(roots.destinationRoot), path.resolve(copy.destinationPath))) {
            throw new Error('Recovery destination path is outside the canonical destination root.');
          }
          const finalFacts = await inspectOwnedFile(
            dependencies,
            roots.destinationRoot,
            copy.destinationPath,
          );
          if (copy.status === 'verified' && finalFacts !== undefined) {
            const consistent =
              finalFacts.sizeBytes === copy.expectedBytes &&
              copy.checksum !== null &&
              copy.checksum !== undefined &&
              copy.checksum === copy.expectedChecksum;
            if (consistent) continue;
            const checksum =
              finalFacts.sizeBytes === copy.expectedBytes
                ? await dependencies.hash(finalFacts.canonicalPath, finalFacts.fileId)
                : undefined;
            if (checksum !== undefined && checksum === copy.expectedChecksum) {
              await dependencies.markVerified(copy.id, checksum, copy.expectedBytes);
              continue;
            }
            await dependencies.quarantine(finalFacts.canonicalPath, finalFacts.fileId);
            pending.push(copy);
            continue;
          }

          if (copy.provisionalPath !== undefined) {
            const provisional = await inspectOwnedFile(
              dependencies,
              roots.provisionalRoot,
              copy.provisionalPath,
            );
            if (provisional !== undefined) {
              const checksum =
                provisional.sizeBytes === copy.expectedBytes
                  ? await dependencies.hash(provisional.canonicalPath, provisional.fileId)
                  : undefined;
              if (checksum !== undefined && checksum === copy.expectedChecksum) {
                await dependencies.promoteProvisional?.(copy, provisional.canonicalPath);
                await dependencies.markVerified(copy.id, checksum, copy.expectedBytes);
                continue;
              }
              await dependencies.quarantine(provisional.canonicalPath, provisional.fileId);
            }
          }
          pending.push(copy);
        }

        if (pending.length > 0 && !(await dependencies.sourceAvailable(session))) {
          await dependencies.regenerateManifest(sessionId);
          await dependencies.audit({
            sessionId,
            action: 'resume',
            outcome: 'paused',
            detail: 'source-unavailable',
          });
          return {
            sessionId,
            status: 'paused',
            reason: 'source-unavailable',
            scheduled: 0,
          };
        }

        for (const copy of pending) {
          throwIfAborted(signal);
          if (copy.temporaryPath !== undefined) {
            await removeOwnedFile(dependencies, roots.temporaryRoot, copy.temporaryPath);
          }
          await dependencies.resetCopy(copy.id);
          await dependencies.scheduleCopy(copy, signal);
        }
        throwIfAborted(signal);
        await dependencies.regenerateManifest(sessionId);
        await dependencies.markSession(sessionId, 'completed');
        await dependencies.audit({ sessionId, action: 'resume', outcome: 'completed' });
        return { sessionId, status: 'completed', scheduled: pending.length };
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          await dependencies.markSession(sessionId, 'cancelled');
          await dependencies.regenerateManifest(sessionId);
          await dependencies.audit({ sessionId, action: 'resume', outcome: 'cancelled' });
        } else {
          await dependencies.markSession(sessionId, 'failed');
          await dependencies.regenerateManifest(sessionId);
          await dependencies.audit({
            sessionId,
            action: 'resume',
            outcome: 'failed',
            detail: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
    });
  }

  function cleanup(sessionId: string, signal = new AbortController().signal): Promise<void> {
    return runExclusive(sessionId, 'cleanup', async () => {
      try {
        throwIfAborted(signal);
        const session = await dependencies.loadSession(sessionId);
        if (session === undefined || session.id !== sessionId) return;
        const roots = await dependencies.roots(sessionId);
        for (const copy of session.copies) {
          throwIfAborted(signal);
          assertOwnedTemporaryPath(sessionId, copy, roots);
          assertOwnedProvisionalPath(sessionId, copy, roots);
          if (copy.temporaryPath !== undefined) {
            await removeOwnedFile(dependencies, roots.temporaryRoot, copy.temporaryPath);
          }
          if (copy.provisionalPath !== undefined) {
            const provisional = await inspectOwnedFile(
              dependencies,
              roots.provisionalRoot,
              copy.provisionalPath,
            );
            if (provisional !== undefined) {
              await dependencies.quarantine(provisional.canonicalPath, provisional.fileId);
            }
          }
        }
        await dependencies.markSession(sessionId, 'cancelled');
        await dependencies.regenerateManifest(sessionId);
        await dependencies.audit({ sessionId, action: 'cleanup', outcome: 'completed' });
      } catch (error) {
        await dependencies.audit({
          sessionId,
          action: 'cleanup',
          outcome: signal.aborted ? 'cancelled' : 'failed',
          detail: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }

  return { resume, cleanup };
}
