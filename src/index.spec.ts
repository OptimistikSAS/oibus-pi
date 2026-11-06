import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PiBridge,
  PiConnection,
  __resetSharedBridgeForTesting,
  extractFromPkgSnapshotIfNeeded,
  resolvePiBinaryPath,
  toHelperRequest,
  toReadResult
} from './index';

/** A fake child process good enough to drive readline + event listeners the same way a real one would. */
class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = { write: mock.fn((_chunk: string) => true) };
  kill = mock.fn(() => true);

  respond(response: unknown): void {
    this.stdout.write(`${JSON.stringify(response)}\n`);
  }

  request(index: number): Record<string, unknown> {
    return JSON.parse((this.stdin.write.mock.calls[index].arguments[0] as string).trim());
  }

  lastRequest(): Record<string, unknown> {
    return this.request(this.stdin.write.mock.calls.length - 1);
  }
}

const originalPlatform = process.platform;
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

const setPkg = (enabled: boolean) => {
  if (enabled) {
    (process as unknown as { pkg?: unknown }).pkg = {};
  } else {
    delete (process as unknown as { pkg?: unknown }).pkg;
  }
};

describe('resolvePiBinaryPath', () => {
  afterEach(() => {
    delete process.env.OIBUS_PI_WINDOWS_BINARY;
    delete process.env.OIBUS_PI_EXTRACT_DIR;
    setPkg(false);
    mock.restoreAll();
  });

  it('extracts the helper into OIBUS_PI_EXTRACT_DIR when running under pkg', () => {
    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-extract-dir-test-'));
    const originalArch = process.arch;
    const readFileSync = fs.readFileSync;
    const bundledPath = path.join(__dirname, '..', 'runtimes', 'win-x64', 'OIBusPiWindows.exe');
    mock.method(fs, 'readFileSync', ((file: fs.PathOrFileDescriptor, options?: unknown) =>
      file === bundledPath ? Buffer.from('bundled helper') : readFileSync(file, options as BufferEncoding)) as typeof fs.readFileSync);
    Object.defineProperty(process, 'arch', { value: 'x64' });
    process.env.OIBUS_PI_EXTRACT_DIR = extractDir;
    setPkg(true);
    try {
      const resolved = resolvePiBinaryPath();
      assert.strictEqual(path.dirname(path.dirname(resolved)), path.join(extractDir, 'oibus-pi'));
      assert.strictEqual(readFileSync(resolved, 'utf8'), 'bundled helper');
    } finally {
      Object.defineProperty(process, 'arch', { value: originalArch });
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  });

  it('returns the OIBUS_PI_WINDOWS_BINARY override when set', () => {
    process.env.OIBUS_PI_WINDOWS_BINARY = 'C:\\custom\\OIBusPiWindows.exe';
    assert.strictEqual(resolvePiBinaryPath(), 'C:\\custom\\OIBusPiWindows.exe');
  });

  it('resolves the bundled x64 helper', () => {
    const originalArch = process.arch;
    Object.defineProperty(process, 'arch', { value: 'x64' });
    try {
      assert.strictEqual(resolvePiBinaryPath(), path.join(__dirname, '..', 'runtimes', 'win-x64', 'OIBusPiWindows.exe'));
    } finally {
      Object.defineProperty(process, 'arch', { value: originalArch });
    }
  });

  it('throws for an unsupported architecture', () => {
    const originalArch = process.arch;
    Object.defineProperty(process, 'arch', { value: 'arm64' });
    try {
      assert.throws(() => resolvePiBinaryPath(), /Unsupported architecture/);
    } finally {
      Object.defineProperty(process, 'arch', { value: originalArch });
    }
  });
});

// Exercised against throwaway scratch folders (not the package's own `runtimes/` folder or the real temp folder).
describe('extractFromPkgSnapshotIfNeeded', () => {
  let scratchDir: string;
  let tmpDir: string;
  let bundledPath: string;

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pkg-test-'));
    tmpDir = path.join(scratchDir, 'tmp');
    bundledPath = path.join(scratchDir, 'OIBusPiWindows.exe');
    fs.writeFileSync(bundledPath, 'fake binary contents');
  });

  afterEach(() => {
    setPkg(false);
    mock.restoreAll();
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it('returns the bundled path unchanged outside of a pkg bundle', () => {
    assert.strictEqual(extractFromPkgSnapshotIfNeeded(bundledPath, tmpDir), bundledPath);
    assert.strictEqual(fs.existsSync(tmpDir), false);
  });

  it('copies the binary to a folder named after its content when running under pkg', () => {
    setPkg(true);
    const resolved = extractFromPkgSnapshotIfNeeded(bundledPath, tmpDir);
    assert.strictEqual(path.dirname(path.dirname(resolved)), path.join(tmpDir, 'oibus-pi'));
    assert.match(path.basename(path.dirname(resolved)), /^[0-9a-f]{16}$/);
    assert.strictEqual(path.basename(resolved), 'OIBusPiWindows.exe');
    assert.strictEqual(fs.readFileSync(resolved, 'utf8'), 'fake binary contents');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(resolved)), ['OIBusPiWindows.exe'], 'no temporary file left');
  });

  it('reuses an already extracted copy, which may be running', () => {
    setPkg(true);
    const first = extractFromPkgSnapshotIfNeeded(bundledPath, tmpDir);
    const renameSync = mock.method(fs, 'renameSync');
    assert.strictEqual(extractFromPkgSnapshotIfNeeded(bundledPath, tmpDir), first);
    assert.strictEqual(renameSync.mock.calls.length, 0);
  });

  it('extracts another version of the binary to another folder', () => {
    setPkg(true);
    const first = extractFromPkgSnapshotIfNeeded(bundledPath, tmpDir);
    fs.writeFileSync(bundledPath, 'new fake binary contents');
    const second = extractFromPkgSnapshotIfNeeded(bundledPath, tmpDir);
    assert.notStrictEqual(second, first);
    assert.strictEqual(fs.readFileSync(second, 'utf8'), 'new fake binary contents');
    assert.strictEqual(fs.readFileSync(first, 'utf8'), 'fake binary contents');
  });

  it('uses the copy of another process that won the extraction race', () => {
    setPkg(true);
    mock.method(fs, 'renameSync', (_from: fs.PathLike, to: fs.PathLike) => {
      fs.writeFileSync(to, 'fake binary contents');
      throw new Error('EPERM: operation not permitted, rename');
    });
    const resolved = extractFromPkgSnapshotIfNeeded(bundledPath, tmpDir);
    assert.strictEqual(fs.readFileSync(resolved, 'utf8'), 'fake binary contents');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(resolved)), ['OIBusPiWindows.exe'], 'temporary file removed');
  });

  it('replaces an extracted copy that was altered, even with the same size', () => {
    setPkg(true);
    const first = extractFromPkgSnapshotIfNeeded(bundledPath, tmpDir);
    fs.writeFileSync(first, 'FAKE BINARY CONTENTS');
    assert.strictEqual(extractFromPkgSnapshotIfNeeded(bundledPath, tmpDir), first);
    assert.strictEqual(fs.readFileSync(first, 'utf8'), 'fake binary contents');
  });

  it('refuses an altered copy that cannot be replaced (run by another process)', () => {
    setPkg(true);
    const first = extractFromPkgSnapshotIfNeeded(bundledPath, tmpDir);
    fs.writeFileSync(first, 'FAKE BINARY CONTENTS');
    mock.method(fs, 'renameSync', () => {
      throw new Error('EBUSY: resource busy or locked, rename');
    });
    assert.throws(() => extractFromPkgSnapshotIfNeeded(bundledPath, tmpDir), /SHA-256 mismatch/);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(first)), ['OIBusPiWindows.exe'], 'temporary file removed');
  });

  it('refuses the copy of another process that does not match the bundled binary', () => {
    setPkg(true);
    mock.method(fs, 'renameSync', (_from: fs.PathLike, to: fs.PathLike) => {
      fs.writeFileSync(to, 'tampered contents');
      throw new Error('EPERM: operation not permitted, rename');
    });
    assert.throws(() => extractFromPkgSnapshotIfNeeded(bundledPath, tmpDir), /SHA-256 mismatch/);
  });

  it('throws when the copy cannot be renamed into place', () => {
    setPkg(true);
    mock.method(fs, 'renameSync', () => {
      throw new Error('EACCES: permission denied, rename');
    });
    assert.throws(() => extractFromPkgSnapshotIfNeeded(bundledPath, tmpDir), /EACCES/);
  });
});

describe('toReadResult', () => {
  it('builds the values of the named points and of the queries', () => {
    assert.deepStrictEqual(
      toReadResult({
        points: [
          { name: 'cdt158', point: 'CDT158', values: [['2026-01-01T00:00:00.000Z', 12, true]] },
          { name: 'cdt158', point: 'CDT158', filter: "'CDT158' > 20", values: [] }
        ],
        notFound: ['MISSING'],
        pointsErrors: [{ names: ['BROKEN'], filter: "'BROKEN' > 1", error: '[-11091] Event Not Found' }],
        queries: [
          {
            query: 'tag:=SIN*',
            filter: "'SINUSOID' > 1",
            points: [
              {
                point: 'SINUSOID',
                values: [
                  ['2026-01-01T00:00:00.000Z', 1.5, true],
                  ['2026-01-01T00:01:00.000Z', 'I/O Timeout', false]
                ]
              }
            ]
          },
          { query: 'pointsource:=X', points: [], error: '[-12010] Bad query' }
        ]
      }),
      {
        points: [
          { name: 'cdt158', point: 'CDT158', values: [{ timestamp: '2026-01-01T00:00:00.000Z', value: 12, good: true }] },
          { name: 'cdt158', point: 'CDT158', filter: "'CDT158' > 20", values: [] }
        ],
        notFound: ['MISSING'],
        pointsErrors: [{ names: ['BROKEN'], filter: "'BROKEN' > 1", error: '[-11091] Event Not Found' }],
        queries: [
          {
            query: 'tag:=SIN*',
            filter: "'SINUSOID' > 1",
            points: [
              {
                point: 'SINUSOID',
                values: [
                  { timestamp: '2026-01-01T00:00:00.000Z', value: 1.5, good: true },
                  { timestamp: '2026-01-01T00:01:00.000Z', value: 'I/O Timeout', good: false }
                ]
              }
            ]
          },
          { query: 'pointsource:=X', points: [], error: '[-12010] Bad query' }
        ]
      }
    );
  });

  it('defaults what is missing', () => {
    assert.deepStrictEqual(toReadResult({}), { points: [], notFound: [], pointsErrors: [], queries: [] });
  });

  it('names a point by its own name when the request name is missing', () => {
    assert.deepStrictEqual(toReadResult({ points: [{ point: 'CDT158', values: [] }] }).points, [{ name: 'CDT158', point: 'CDT158', values: [] }]);
  });
});

describe('toHelperRequest', () => {
  it('sends the points and queries as objects, with their filter when set', () => {
    assert.deepStrictEqual(
      toHelperRequest({
        points: ['CDT158', { name: 'SINUSOID' }, { name: 'SINUSOID', filter: " 'SINUSOID' > 50 " }, { name: 'TEXT', filter: '  ' }],
        queries: ['tag:=BA*', { query: 'tag:=SIN*', filter: "'SINUSOID' < 10" }, { query: 'tag:=X*', filter: '' }]
      }),
      {
        points: [{ name: 'CDT158' }, { name: 'SINUSOID' }, { name: 'SINUSOID', filter: "'SINUSOID' > 50" }, { name: 'TEXT' }],
        queries: [{ query: 'tag:=BA*' }, { query: 'tag:=SIN*', filter: "'SINUSOID' < 10" }, { query: 'tag:=X*' }]
      }
    );
  });

  it('sends empty lists by default', () => {
    assert.deepStrictEqual(toHelperRequest({}), { points: [], queries: [] });
  });
});

describe('PiBridge', () => {
  let lastChild: FakeChildProcess;
  let spawnMock: ReturnType<typeof createSpawnMock>;
  const createSpawnMock = () =>
    mock.fn((_binary: string, _args: Array<string>, _options: unknown) => {
      lastChild = new FakeChildProcess();
      return lastChild as unknown as ReturnType<typeof import('node:child_process').spawn>;
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createBridge = () => new PiBridge('binary.exe', spawnMock as any);

  beforeEach(() => {
    spawnMock = createSpawnMock();
  });

  it('spawns the helper lazily, once, with a hidden window', async () => {
    const bridge = createBridge();
    assert.strictEqual(bridge.isRunning, false);
    const first = bridge.send({ command: 'read', id: 'a' });
    const second = bridge.send({ command: 'read', id: 'b' });
    assert.strictEqual(bridge.isRunning, true);
    assert.strictEqual(spawnMock.mock.calls.length, 1);
    assert.strictEqual(spawnMock.mock.calls[0].arguments[0], 'binary.exe');
    assert.deepStrictEqual(spawnMock.mock.calls[0].arguments[2], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    bridge.stop();
    await assert.rejects(first);
    await assert.rejects(second);
  });

  it('tags every outgoing command with a distinct requestId and resolves by matching it back', async () => {
    const bridge = createBridge();
    const first = bridge.send({ command: 'read', id: 'a' });
    const second = bridge.send({ command: 'read', id: 'b' });

    const req1 = lastChild.request(0);
    const req2 = lastChild.request(1);
    assert.notStrictEqual(req1.requestId, req2.requestId);

    // Answer out of order — the second request's response arrives first.
    lastChild.respond({ requestId: req2.requestId, points: [] });
    lastChild.respond({ requestId: req1.requestId, points: [] });

    assert.deepStrictEqual(await second, { requestId: req2.requestId, points: [] });
    assert.deepStrictEqual(await first, { requestId: req1.requestId, points: [] });
  });

  it('ignores lines that are not JSON, have no requestId or answer no pending request', async () => {
    const bridge = createBridge();
    const pending = bridge.send({ command: 'read', id: 'a' });
    const { requestId } = lastChild.lastRequest();
    lastChild.stdout.write('not json\n');
    lastChild.respond({ error: 'no request id' });
    lastChild.respond({ requestId: 'unknown', ok: true });
    lastChild.respond({ requestId, ok: true });
    assert.deepStrictEqual(await pending, { requestId, ok: true });
  });

  it('fails every pending request when the process exits unexpectedly, with what it wrote to stderr', async () => {
    const bridge = createBridge();
    const pending = bridge.send({ command: 'read', id: 'a' });
    lastChild.stderr.write('Unhandled exception. System.OutOfMemoryException\n');
    await new Promise(resolve => setImmediate(resolve));
    lastChild.emit('exit', 1, null);
    await assert.rejects(pending, {
      message: 'PI helper exited unexpectedly (code 1, signal null): Unhandled exception. System.OutOfMemoryException'
    });
    assert.strictEqual(bridge.isRunning, false);
  });

  it('spawns a new process for the next command after an unexpected exit', async () => {
    const bridge = createBridge();
    const pending = bridge.send({ command: 'read', id: 'a' });
    lastChild.emit('exit', null, 'SIGTERM');
    await assert.rejects(pending, { message: 'PI helper exited unexpectedly (code null, signal SIGTERM)' });

    const next = bridge.send({ command: 'read', id: 'a' });
    assert.strictEqual(spawnMock.mock.calls.length, 2);
    lastChild.respond({ requestId: lastChild.lastRequest().requestId, points: [] });
    await next;
  });

  it('fails a send() issued while spawning failed', async () => {
    const bridge = createBridge();
    const pending = bridge.send({ command: 'connect', id: 'a' });
    lastChild.emit('error', new Error('spawn ENOENT'));
    await assert.rejects(pending, { message: 'spawn ENOENT' });
    await assert.rejects(bridge.send({ command: 'connect', id: 'a' }), { message: 'spawn ENOENT' });
  });

  it('stop() kills the process and rejects anything still pending', async () => {
    const bridge = createBridge();
    const pending = bridge.send({ command: 'read', id: 'a' });
    bridge.stop();
    await assert.rejects(pending, { message: 'PI helper process was stopped' });
    assert.strictEqual(lastChild.kill.mock.calls.length, 1);
    assert.strictEqual(bridge.isRunning, false);
  });

  it('ignores the late exit and error events of a stopped process', async () => {
    const bridge = createBridge();
    bridge.send({ command: 'read', id: 'a' }).catch(() => undefined);
    const stoppedChild = lastChild;
    bridge.stop();

    const pending = bridge.send({ command: 'read', id: 'a' });
    stoppedChild.emit('exit', null, 'SIGTERM');
    stoppedChild.emit('error', new Error('kill EPERM'));
    assert.strictEqual(bridge.isRunning, true);
    lastChild.respond({ requestId: lastChild.lastRequest().requestId, points: [] });
    await pending;
  });
});

describe('PiConnection', () => {
  let lastChild: FakeChildProcess;
  let spawnMock: ReturnType<typeof mock.fn>;
  const info = { name: 'PISRV1', version: '3.4.445.688', uniqueId: 'b6f3a7c2-0000-0000-0000-000000000001' };

  const connect = async (options?: { serverName?: string; connectionTimeout?: number }) => {
    const connectPromise = PiConnection.connect(options);
    lastChild.respond({ ...lastChild.lastRequest(), ok: true, info });
    return connectPromise;
  };
  const disconnect = async (connection: PiConnection) => {
    const disconnectPromise = connection.disconnect();
    lastChild.respond({ ...lastChild.lastRequest(), ok: true });
    await disconnectPromise;
  };

  beforeEach(() => {
    spawnMock = mock.fn((_binary: string, _args: Array<string>, _options: unknown) => {
      lastChild = new FakeChildProcess();
      return lastChild;
    });
    setPlatform('win32');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __resetSharedBridgeForTesting(() => new PiBridge('binary.exe', spawnMock as any));
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    delete process.env.OIBUS_PI_WINDOWS_BINARY;
    __resetSharedBridgeForTesting();
  });

  it('rejects immediately on a non-Windows platform without touching the shared bridge', async () => {
    setPlatform('linux');
    await assert.rejects(PiConnection.connect(), { message: 'PI requires Windows' });
    assert.strictEqual(spawnMock.mock.calls.length, 0);
  });

  it('accepts a non-Windows platform when a helper binary is given (development)', async () => {
    setPlatform('linux');
    process.env.OIBUS_PI_WINDOWS_BINARY = '/path/to/helper';
    const connection = await connect();
    assert.deepStrictEqual(connection.info, info);
  });

  it('connects to the named server with the timeout and exposes the server info', async () => {
    const connectPromise = PiConnection.connect({ serverName: 'PISRV1', connectionTimeout: 5000 });
    const request = lastChild.lastRequest();
    assert.deepStrictEqual(
      { command: request.command, serverName: request.serverName, connectionTimeout: request.connectionTimeout },
      { command: 'connect', serverName: 'PISRV1', connectionTimeout: 5000 }
    );
    assert.match(request.id as string, /^[0-9a-f-]{36}$/);
    lastChild.respond({ ...request, ok: true, info });
    const connection = await connectPromise;
    assert.deepStrictEqual(connection.info, info);
  });

  it('connects to the default server when no or an empty server name is given', async () => {
    await connect();
    await connect({ serverName: '' });
    assert.deepStrictEqual(
      [lastChild.request(0), lastChild.request(1)].map(request => [request.serverName, request.connectionTimeout]),
      [
        [undefined, undefined],
        [undefined, undefined]
      ]
    );
  });

  it('releases the shared process reference when connect() itself fails', async () => {
    const failingPromise = PiConnection.connect({ serverName: 'OTHER' });
    lastChild.respond({ ...lastChild.lastRequest(), error: 'PI Data Archive "OTHER" is not in the known servers table of PI AF Client' });
    await assert.rejects(failingPromise, { message: 'PI Data Archive "OTHER" is not in the known servers table of PI AF Client' });
    assert.strictEqual(lastChild.kill.mock.calls.length, 1, 'nothing else was using the process, so it is torn down');

    await connect();
    assert.strictEqual(spawnMock.mock.calls.length, 2, 'a fresh process is spawned for the next attempt');
  });

  it('rejects with a generic message when connect() fails without error', async () => {
    const failingPromise = PiConnection.connect();
    lastChild.respond({ requestId: lastChild.lastRequest().requestId });
    await assert.rejects(failingPromise, { message: 'Unknown error while connecting' });
  });

  it('recordedValues() sends the time range, points, queries and options and returns the values', async () => {
    const connection = await connect();
    const readPromise = connection.recordedValues(
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T01:00:00.000Z',
      { points: ['CDT158', { name: 'CDT158', filter: "'CDT158' > 20" }], queries: ['tag:=SIN*'] },
      { pageSize: 1000, timeout: 15000 }
    );
    const request = lastChild.lastRequest();
    assert.deepStrictEqual(request, {
      command: 'read',
      id: lastChild.request(0).id,
      startTime: '2026-01-01T00:00:00.000Z',
      endTime: '2026-01-01T01:00:00.000Z',
      points: [{ name: 'CDT158' }, { name: 'CDT158', filter: "'CDT158' > 20" }],
      queries: [{ query: 'tag:=SIN*' }],
      pageSize: 1000,
      timeout: 15000,
      requestId: request.requestId
    });
    lastChild.respond({
      requestId: request.requestId,
      points: [{ name: 'CDT158', point: 'CDT158', values: [['2026-01-01T00:00:00.000Z', 12, true]] }],
      notFound: [],
      queries: [{ query: 'tag:=SIN*', points: [] }]
    });
    assert.deepStrictEqual(await readPromise, {
      points: [{ name: 'CDT158', point: 'CDT158', values: [{ timestamp: '2026-01-01T00:00:00.000Z', value: 12, good: true }] }],
      notFound: [],
      pointsErrors: [],
      queries: [{ query: 'tag:=SIN*', points: [] }]
    });
  });

  it('recordedValues() sends empty lists and no option by default', async () => {
    const connection = await connect();
    const readPromise = connection.recordedValues('2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', {});
    const request = lastChild.lastRequest();
    assert.deepStrictEqual([request.points, request.queries, request.pageSize, request.timeout], [[], [], undefined, undefined]);
    lastChild.respond({ requestId: request.requestId });
    assert.deepStrictEqual(await readPromise, { points: [], notFound: [], pointsErrors: [], queries: [] });
  });

  it('recordedValues() rejects when the helper reports a failure', async () => {
    const connection = await connect();
    const readPromise = connection.recordedValues('2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', { points: ['CDT158'] });
    lastChild.respond({ requestId: lastChild.lastRequest().requestId, error: '[-10734] PINET: Broken Connection' });
    await assert.rejects(readPromise, { message: '[-10734] PINET: Broken Connection' });
  });

  it('recordedValues() rejects once the connection is closed', async () => {
    const connection = await connect();
    await disconnect(connection);
    await assert.rejects(connection.recordedValues('2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', {}), {
      message: 'Connection is closed'
    });
  });

  it('shares one process across two concurrent connections and answers both independently', async () => {
    const first = await connect();
    const second = await connect({ serverName: 'PISRV2' });
    assert.strictEqual(spawnMock.mock.calls.length, 1, 'only one helper process for both connections');

    const readA = first.recordedValues('2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', { points: ['A'] });
    const readB = second.recordedValues('2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', { points: ['B'] });
    const reqA = lastChild.request(2);
    const reqB = lastChild.request(3);
    assert.notStrictEqual(reqA.id, reqB.id, 'each connection keeps its own id');

    // Answer B first, then A — order must not matter.
    lastChild.respond({ requestId: reqB.requestId, notFound: ['B'] });
    lastChild.respond({ requestId: reqA.requestId, notFound: ['A'] });
    assert.deepStrictEqual((await readB).notFound, ['B']);
    assert.deepStrictEqual((await readA).notFound, ['A']);
  });

  it('keeps the shared process alive until the last connection disconnects', async () => {
    const first = await connect();
    const second = await connect();

    await disconnect(first);
    assert.strictEqual(lastChild.kill.mock.calls.length, 0, 'still one connection using the shared process');

    await disconnect(second);
    assert.strictEqual(lastChild.kill.mock.calls.length, 1, 'process stopped once the last connection left');
  });

  it('disconnect() is idempotent', async () => {
    const connection = await connect();
    await disconnect(connection);
    await assert.doesNotReject(connection.disconnect());
    assert.strictEqual(lastChild.kill.mock.calls.length, 1);
  });

  it('disconnect() releases the shared process even when the helper is gone', async () => {
    const connection = await connect();
    const disconnectPromise = connection.disconnect();
    lastChild.emit('exit', 1, null);
    await assert.doesNotReject(disconnectPromise);

    await connect();
    assert.strictEqual(spawnMock.mock.calls.length, 2, 'a fresh process is spawned for the next connection');
  });
});
