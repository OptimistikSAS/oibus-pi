import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const BINARY_NAME = 'OIBusPiWindows.exe';
const BINARY_ENV_OVERRIDE = 'OIBUS_PI_WINDOWS_BINARY';
const EXTRACT_DIR_ENV = 'OIBUS_PI_EXTRACT_DIR';
// Kept in the error raised when the helper exits unexpectedly (the .NET runtime reports crashes there)
const MAX_STDERR_LENGTH = 4096;

/** The PI Data Archive a connection reads from. `version` and `uniqueId` are empty when the server does not report them. */
export interface PiServerInfo {
  name: string;
  version: string;
  uniqueId: string;
}

export interface PiConnectOptions {
  /**
   * Name of the PI Data Archive in the known servers table of PI AF Client on this machine. Not set or empty: the
   * default PI Data Archive of that table.
   */
  serverName?: string;
  /** Time to connect, in ms. Not set or 0: no timeout. */
  connectionTimeout?: number;
}

export interface PiReadOptions {
  /** Number of events per page of the bulk calls to the PI Data Archive. Default: 20 000. */
  pageSize?: number;
  /** Time to read all the values, in ms. Not set or 0: no timeout. */
  timeout?: number;
}

/**
 * A PI value:
 * - numbers for numeric points (except 64-bit integers beyond `Number.MAX_SAFE_INTEGER` and non-finite numbers, given
 *   as strings so that no digit is lost);
 * - the state name for digital states, including system states such as `I/O Timeout` or `Shutdown`;
 * - ISO 8601 UTC strings for timestamp points, base64 for blobs, strings otherwise.
 */
export type PiValue = string | number | boolean | null;

export interface PiRecordedValue {
  /** ISO 8601 UTC instant, with milliseconds */
  timestamp: string;
  value: PiValue;
  /** `false` for a bad value, such as a system digital state (`I/O Timeout`, `Bad Input`...) */
  good: boolean;
}

export interface PiPointValues {
  /** Name of the point, as spelled by the PI Data Archive */
  point: string;
  values: Array<PiRecordedValue>;
}

export interface PiQueryValues {
  query: string;
  /** The filter expression of the query, as requested */
  filter?: string;
  /** The points matching the query, each with its values */
  points: Array<PiPointValues>;
  /** Set when the query or the read of its points failed: `points` is then empty */
  error?: string;
}

/**
 * A point name or a query with a filter expression: a condition in the performance equation syntax, such as
 * `'SINUSOID' > 50`, evaluated by the PI Data Archive. Only the values passing it are returned.
 */
export interface PiFilteredPoint {
  name: string;
  filter?: string;
}

export interface PiFilteredQuery {
  query: string;
  filter?: string;
}

export interface PiReadRequest {
  /** Exact point names (no wildcard; not case-sensitive), each with an optional filter expression */
  points?: Array<string | PiFilteredPoint>;
  /**
   * PI point queries (see AVEVA's "PIPoint Query Syntax"), such as `tag:=sinus*` or `pointsource:=R`, each with an
   * optional filter expression. A query without attribute name (`sinus*`) searches the point names.
   */
  queries?: Array<string | PiFilteredQuery>;
}

/** A bulk read of named points that failed: the points sharing a filter expression are read in one bulk call */
export interface PiPointsError {
  names: Array<string>;
  filter?: string;
  error: string;
}

export interface PiReadResult {
  /**
   * One entry per requested point name (and filter) found, with `name` and `filter` as requested. The points without
   * filter come first, then the points of each filter expression, in request order.
   */
  points: Array<PiPointValues & { name: string; filter?: string }>;
  /** The requested point names not found on the PI Data Archive */
  notFound: Array<string>;
  /** The bulk reads of named points that failed, one per filter expression: their points are left out of `points` */
  pointsErrors: Array<PiPointsError>;
  /** One entry per query, in request order */
  queries: Array<PiQueryValues>;
}

type RawValue = [string, PiValue, boolean];
interface RawPointValues {
  point: string;
  name?: string;
  filter?: string;
  values: Array<RawValue>;
}

/**
 * `ok` only ever appears on `connect`/`disconnect` responses. `read` responses carry no `ok` at all — `error`'s presence
 * is the only failure signal.
 */
interface PiResponse {
  requestId?: string;
  ok?: boolean;
  error?: string;
  info?: PiServerInfo;
  points?: Array<RawPointValues>;
  notFound?: Array<string>;
  pointsErrors?: Array<PiPointsError>;
  queries?: Array<{ query: string; filter?: string; points: Array<RawPointValues>; error?: string }>;
}

// Only an x64 helper is shipped: Node.js has no 32-bit Windows release since v23, and Windows on ARM (arm64) is
// not supported.
const ARCH_FOLDERS: Partial<Record<NodeJS.Architecture, string>> = {
  x64: 'win-x64'
};

/**
 * Resolves the bundled OIBusPiWindows helper binary for the current architecture. Overridable via
 * OIBUS_PI_WINDOWS_BINARY (used to run a custom build during development).
 *
 * When the calling application is itself bundled with `pkg` (or `@yao-pkg/pkg`), `__dirname`-relative paths resolve
 * inside pkg's virtual snapshot filesystem: `fs` reads work there, but `child_process.spawn()` needs a real file. The
 * binary is then extracted first (see `extractFromPkgSnapshotIfNeeded`), into the folder named by OIBUS_PI_EXTRACT_DIR,
 * or else the temporary folder of the operating system.
 */
export function resolvePiBinaryPath(): string {
  const override = process.env[BINARY_ENV_OVERRIDE];
  if (override) {
    return override;
  }
  const archFolder = ARCH_FOLDERS[process.arch];
  if (!archFolder) {
    throw new Error(`Unsupported architecture for the PI Windows helper: ${process.arch}`);
  }
  const bundledPath = path.join(__dirname, '..', 'runtimes', archFolder, BINARY_NAME);
  return extractFromPkgSnapshotIfNeeded(bundledPath, process.env[EXTRACT_DIR_ENV] || os.tmpdir());
}

function sha256(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** Whether the file exists with exactly this SHA-256 */
function hasHash(filePath: string, hash: string): boolean {
  try {
    return sha256(fs.readFileSync(filePath)) === hash;
  } catch {
    return false;
  }
}

/**
 * Outside of a pkg bundle, returns the bundled path unchanged. Inside one (`process.pkg` is set), copies the binary
 * out of the snapshot to `<extractDir>/oibus-pi/<content hash>/` and returns that path.
 *
 * The folder is named after the binary's content, so that several applications on the same machine (two OIBus
 * services, for instance) share one extracted copy per helper version: Windows forbids replacing an executable while
 * it runs, so an already extracted copy is reused, and a new version goes to its own folder. A copy is written to a
 * per-process temporary name first and then renamed into place (atomic on the same volume), so that no process ever
 * spawns a partially written file; when another process won the race, its copy is used.
 *
 * An extracted copy is only ever spawned after its SHA-256 was checked against the bundled binary: a copy that was
 * altered in the extraction folder (which may be writable by other users, as the temporary folder is) is replaced, and
 * when it cannot be replaced (another process runs it), an error is thrown instead of running it.
 *
 * Exported for this package's own tests — not part of the public API.
 */
export function extractFromPkgSnapshotIfNeeded(bundledPath: string, extractDir: string = os.tmpdir()): string {
  if (!('pkg' in process)) {
    return bundledPath;
  }
  const content = fs.readFileSync(bundledPath);
  const hash = sha256(content);
  const extractedPath = path.join(extractDir, 'oibus-pi', hash.slice(0, 16), path.basename(bundledPath));
  if (hasHash(extractedPath, hash)) {
    return extractedPath;
  }
  fs.mkdirSync(path.dirname(extractedPath), { recursive: true });
  const tempPath = `${extractedPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, content);
  try {
    fs.renameSync(tempPath, extractedPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    // Another process extracted (and may already run) the same binary in the meantime: its copy is used, once checked
    if (!fs.existsSync(extractedPath)) {
      throw error;
    }
  }
  if (!hasHash(extractedPath, hash)) {
    throw new Error(`The extracted PI helper ${extractedPath} does not match the bundled one (SHA-256 mismatch): it was not run`);
  }
  return extractedPath;
}

interface PendingRequest {
  resolve: (response: PiResponse) => void;
  reject: (error: Error) => void;
}

/**
 * Manages exactly one OIBusPiWindows child process and multiplexes any number of concurrent logical connections over
 * it via a per-connection `id` and a per-request `requestId` for response correlation — responses can arrive out of
 * order across connections. `spawnFn` is injectable so tests can supply a fake child process.
 */
export class PiBridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private nextRequestId = 1;
  private startupError: Error | null = null;
  private stderr = '';

  constructor(
    private readonly binaryPath: string = resolvePiBinaryPath(),
    private readonly spawnFn: typeof spawn = spawn
  ) {}

  get isRunning(): boolean {
    return this.child !== null;
  }

  send(command: Record<string, unknown>): Promise<PiResponse> {
    this.ensureStarted();
    if (this.startupError) {
      return Promise.reject(this.startupError);
    }
    const child = this.child!;
    const requestId = String(this.nextRequestId++);
    return new Promise<PiResponse>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ ...command, requestId })}\n`);
    });
  }

  stop(): void {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    this.failAll(new Error('PI helper process was stopped'));
  }

  private ensureStarted(): void {
    if (this.child) {
      return;
    }
    this.startupError = null;
    this.stderr = '';
    const child = this.spawnFn(this.binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;

    createInterface({ input: child.stdout }).on('line', line => this.handleLine(line));
    // Always consumed, so that the helper never blocks on a full stderr pipe
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-MAX_STDERR_LENGTH);
    });
    // Events of a process already stopped (and maybe replaced by a new one) are ignored: stop() already failed its
    // pending requests, and the ones pending now belong to the new process.
    child.on('error', error => {
      if (this.child !== child) {
        return;
      }
      this.startupError = error;
      this.failAll(error);
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) {
        return;
      }
      this.child = null;
      const details = this.stderr.trim();
      this.failAll(new Error(`PI helper exited unexpectedly (code ${code}, signal ${signal})${details ? `: ${details}` : ''}`));
    });
  }

  private handleLine(line: string): void {
    let response: PiResponse;
    try {
      response = JSON.parse(line) as PiResponse;
    } catch {
      return;
    }
    const requestId = response.requestId;
    if (!requestId) {
      return;
    }
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }
    this.pending.delete(requestId);
    pending.resolve(response);
  }

  private failAll(error: Error): void {
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    for (const request of pending) {
      request.reject(error);
    }
  }
}

let sharedBridge: PiBridge | null = null;
let refCount = 0;
let bridgeFactory: () => PiBridge = () => new PiBridge();

function acquireBridge(): PiBridge {
  if (!sharedBridge) {
    sharedBridge = bridgeFactory();
  }
  refCount++;
  return sharedBridge;
}

function releaseBridge(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0 && sharedBridge) {
    sharedBridge.stop();
    sharedBridge = null;
  }
}

/**
 * Test-only seam: swaps the factory used to create the shared bridge singleton and resets reference counting. Not part
 * of the package's public API.
 */
export function __resetSharedBridgeForTesting(factory?: () => PiBridge): void {
  if (sharedBridge) {
    sharedBridge.stop();
  }
  sharedBridge = null;
  refCount = 0;
  bridgeFactory = factory ?? (() => new PiBridge());
}

function toPointValues(raw: RawPointValues): PiPointValues {
  return {
    point: raw.point,
    values: raw.values.map(([timestamp, value, good]) => ({ timestamp, value, good }))
  };
}

/**
 * Builds the read result from the helper's response, where values are sent as `[timestamp, value, good]` arrays.
 * Exported for this package's own tests — not part of the public API.
 */
export function toReadResult(response: PiResponse): PiReadResult {
  return {
    points: (response.points ?? []).map(raw => ({
      name: raw.name ?? raw.point,
      ...(raw.filter !== undefined ? { filter: raw.filter } : {}),
      ...toPointValues(raw)
    })),
    notFound: response.notFound ?? [],
    pointsErrors: response.pointsErrors ?? [],
    queries: (response.queries ?? []).map(query => ({
      query: query.query,
      ...(query.filter !== undefined ? { filter: query.filter } : {}),
      points: query.points.map(toPointValues),
      ...(query.error !== undefined ? { error: query.error } : {})
    }))
  };
}

/** The filter expression of a request entry, left out when missing or blank */
function withFilter<T extends object>(entry: T, filter: string | undefined): T & { filter?: string } {
  return filter?.trim() ? { ...entry, filter: filter.trim() } : entry;
}

/**
 * The points and queries of a request as the helper reads them: objects, with their filter expression when set.
 * Exported for this package's own tests — not part of the public API.
 */
export function toHelperRequest(request: PiReadRequest): { points: Array<PiFilteredPoint>; queries: Array<PiFilteredQuery> } {
  return {
    points: (request.points ?? []).map(point => (typeof point === 'string' ? { name: point } : withFilter({ name: point.name }, point.filter))),
    queries: (request.queries ?? []).map(query =>
      typeof query === 'string' ? { query } : withFilter({ query: query.query }, query.filter)
    )
  };
}

/**
 * One logical connection to a PI Data Archive, through the AF SDK of the PI AF Client installed on this machine (this
 * package contains no AVEVA file). Any number of `PiConnection`s share a single OIBusPiWindows child
 * process, spawned lazily on the first `connect()` and stopped once the last connection is closed. Reads on the same
 * connection run one at a time, in call order; reads on different connections run concurrently.
 *
 * The helper connects with the Windows account running the process (PI trusts or mappings), never with a prompt.
 */
export class PiConnection {
  private closed = false;

  private constructor(
    private readonly id: string,
    private readonly bridge: PiBridge,
    readonly info: PiServerInfo
  ) {}

  static async connect(options: PiConnectOptions = {}): Promise<PiConnection> {
    if (process.platform !== 'win32' && !process.env[BINARY_ENV_OVERRIDE]) {
      throw new Error('PI requires Windows');
    }
    const bridge = acquireBridge();
    const id = crypto.randomUUID();
    try {
      const response = await bridge.send({
        command: 'connect',
        id,
        serverName: options.serverName || undefined,
        connectionTimeout: options.connectionTimeout
      });
      if (!response.ok) {
        throw new Error(response.error ?? 'Unknown error while connecting');
      }
      return new PiConnection(id, bridge, response.info!);
    } catch (error) {
      releaseBridge();
      throw error;
    }
  }

  /**
   * Reads the recorded (compressed) values of points between two ISO 8601 instants, both included, for points given by
   * exact name and for points matching PI point queries, each with an optional filter expression applied by the PI
   * Data Archive. The named points are read in one bulk call per distinct filter expression, each query in its own call.
   *
   * A point name not found, or a query or bulk read that fails, is reported in the result while the rest is still
   * read. The promise only rejects when the whole read failed (timeout, lost connection to the PI Data Archive...), with
   * the PI error message; logging it is left to the caller. After a lost connection, the next read connects again.
   */
  async recordedValues(startTime: string, endTime: string, request: PiReadRequest, options: PiReadOptions = {}): Promise<PiReadResult> {
    if (this.closed) {
      throw new Error('Connection is closed');
    }
    const response = await this.bridge.send({
      command: 'read',
      id: this.id,
      startTime,
      endTime,
      ...toHelperRequest(request),
      pageSize: options.pageSize,
      timeout: options.timeout
    });
    if (response.error) {
      throw new Error(response.error);
    }
    return toReadResult(response);
  }

  async disconnect(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await this.bridge.send({ command: 'disconnect', id: this.id });
    } catch {
      // Best-effort: the helper may already be gone (crash, prior stop). Either way this connection's slot on the
      // shared bridge is released below.
    } finally {
      releaseBridge();
    }
  }
}
