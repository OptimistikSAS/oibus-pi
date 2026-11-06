# @oibus/pi

A Windows-only npm package that reads the recorded values of a PI Data Archive: a small .NET Framework
console app driving the AF SDK, plus the TypeScript driver (`src/index.ts`) that spawns and talks to
it.

The calling process spawns this package's helper itself as a local child process on demand, talks to
it over a small stdio JSON protocol, and stops it once its last connection is closed.

> **Not affiliated with AVEVA.** This package is not affiliated with, sponsored by or endorsed by
> AVEVA Group Limited. AVEVA, PI System, PI AF and PI Data Archive are trademarks of AVEVA Group
> Limited or its subsidiaries, used here only to say what the package connects to.

## Licence, and what is not included

This repository is licensed under the **Apache License 2.0**: see [LICENSE](LICENSE) and
[NOTICE](NOTICE). The published binary embeds no third-party code (see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)).

**No AVEVA file is included**, anywhere: not in this repository, its CI, the npm package or the
helper. The helper has no compile-time reference to the AF SDK: it loads the .NET Framework AF SDK
(`OSIsoft.AFSDK`) at runtime from the PI AF Client installed on the machine, and calls it by late
binding. The AF SDK is licensed by AVEVA to the machine's owner; this package neither includes it nor
grants any right to it. If you redistribute this package, do not add any AVEVA file to it.

## Requirements on the machine

- Windows x64 (`os: ["win32"]` in `package.json`: npm refuses to install it elsewhere), with .NET
  Framework 4.8, which is part of Windows 10 (1903 and later), Windows 11 and Windows Server 2022
  and later (installable on Windows Server 2016 and 2019).
- **PI AF Client**, installed by the machine's owner under its own agreement with AVEVA. It installs
  the AF SDK in the Global Assembly Cache, where the helper finds it (or else in
  `%PIHOME%\AF\PublicAssemblies\4.0`), and holds the **known servers table**: the PI Data Archives a
  connection can name, and the default one.
- A **PI System Access (PSA) licence**: AVEVA requires one for any non-AVEVA program that reads PI
  data (AVEVA Software Schedule PI System, §3.3(b)(iv)).
- Access rights on the PI Data Archive for the **Windows account running the process** (a PI mapping
  or trust): the helper connects with Windows integrated security and never prompts for credentials.

## Install

```bash
npm install @oibus/pi
```

```ts
import { PiConnection } from '@oibus/pi';

// The default PI Data Archive of the known servers table, or one named in it
const connection = await PiConnection.connect({ serverName: 'MYPISERVER', connectionTimeout: 15_000 });
// connection.info: { name: 'MYPISERVER', version: '3.4.445.688', uniqueId: '...' }

const result = await connection.recordedValues(
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T01:00:00.000Z',
  {
    points: ['SINUSOID', { name: 'CDT158', filter: "'CDT158' > 50" }],
    queries: ['tag:=BA:*', { query: 'pointsource:=R', filter: "'SINUSOID' < 10" }]
  },
  { timeout: 60_000 }
);
// result.points: [{ name: 'SINUSOID', point: 'SINUSOID', values: [{ timestamp: '2026-01-01T00:00:00.000Z', value: 12.5, good: true }, ...] }, ...]
// result.notFound: names of the requested points the server does not know
// result.queries: [{ query: 'tag:=BA:*', points: [{ point: 'BA:TEMP.1', values: [...] }, ...] }, ...]
await connection.disconnect();
```

## Reading values

`recordedValues(startTime, endTime, request, options)` returns the recorded (compressed) values
between two ISO 8601 instants, **both included** (AF SDK `RecordedValues` with the `Inside` boundary),
in bulk calls paged by event count (`pageSize`, 20 000 events by default):

- `points`: exact point names (no wildcard, not case-sensitive). Each found point gives one entry,
  with `name` as requested and `point` as spelled by the server, in request order. The names the
  server does not know are listed in `notFound`.
- `queries`: [PI point queries](https://docs.aveva.com/bundle/af-sdk/page/html/pipoint-query-syntax-overview.htm),
  such as `tag:=sinus*`, `pointsource:=R` or `tag:=BA* AND pointtype:=Float32`. A query without
  attribute name (`sinus*`) searches the point names. Each query gives one entry with the points it
  matched.

Each point or query is either a string, or an object (`{ name, filter }`, `{ query, filter }`) with a
**filter expression**: a condition in the
[performance equation syntax](https://docs.aveva.com/bundle/af-sdk/page/html/M_OSIsoft_AF_PI_PIPoint_RecordedValues.htm),
such as `'SINUSOID' > 50`, evaluated by the PI Data Archive. Only the values passing it are returned
(no `Filtered` marker), which saves the transfer of the others. A bulk call takes one filter for all
its points: the named points are read in one bulk call per distinct filter (a single call when none
has a filter), each query in its own call. The same name can be requested with several filters: each
gives its own entry, with its `filter`.

Partial failures do not fail the read: when a bulk read of named points fails (one per filter),
`pointsErrors` gives its names, filter and PI message; when a query fails, its entry has an `error`. The promise only rejects when the
whole read fails: timeout, or a lost connection to the PI Data Archive (PI errors `-10722`, `-10723`,
`-10733`, `-10734`). After a lost connection, the next read connects again.

| PI value                         | JSON value                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| Numeric (Float16/32/64, Int16/32) | number (a Float32 keeps its shortest form: `1.1`, not `1.100000023841858`)                  |
| Digital state                    | its name (`"On"`), system states included (`"I/O Timeout"`, `"Shutdown"`)                     |
| String                           | string                                                                                       |
| Timestamp                        | ISO 8601 UTC string                                                                          |
| Blob                             | base64 string                                                                                |

Each value also has `good`: `false` for a bad value, such as a system digital state. Timestamps are
ISO 8601 UTC strings with milliseconds.

## Timeouts

- `connectionTimeout` (ms) of `connect()` and `timeout` (ms) of `recordedValues()`: enforced by the
  helper. An AF SDK call cannot be cancelled: on expiry the promise rejects right away
  (`Connection timed out after <n> ms`, `Read timed out after <n> ms`), and the call completes in the
  background, its result dropped.

Not set (or 0): no timeout.

## Architecture

A single .NET Framework helper process, spawned lazily on the first `connect()` call and stopped
once the last open connection disconnects, multiplexes any number of concurrent logical connections
over one stdio JSON protocol: each connection is tracked by a UUID `id`, and every request/response
carries a `requestId` so responses (which can arrive out of order across connections) get matched
back to the right caller. Commands on the same connection id run in strict arrival order, while
commands on different connection ids run concurrently. When stdin closes, the process drains all
in-flight work before exiting.

The AF SDK keeps one object per PI Data Archive in a process: connections to the same server share
it, and it is disconnected when the last of them disconnects. **Connect is idempotent**, and each
read first connects the server again if it was disconnected.

The AF SDK is loaded once, on the first `connect()`, and every type and static member the helper uses
is checked then: a PI AF Client version without one of them is reported by name
(`The installed AF SDK has no ...`), and a machine without PI AF Client gives
`PI AF Client is not installed: ...`.

If the helper exits unexpectedly, every pending request is rejected with its exit code and the end of
what it wrote to stderr.

## Works inside a `pkg`-bundled application too

Inside a [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg) bundle, paths resolved relative to
`__dirname` point into pkg's virtual snapshot filesystem: `fs` reads them, but
`child_process.spawn()` needs a real file. So when `process.pkg` is set, `resolvePiBinaryPath()`
extracts the embedded helper to `<extract dir>/oibus-pi/<content hash>/OIBusPiWindows.exe` and spawns
it from there. The extract dir is the folder named by the `OIBUS_PI_EXTRACT_DIR` environment variable,
or else the temporary folder of the operating system. The folder is named after the helper's content:
several applications on the same machine share one extracted copy per helper version, and an already
extracted copy is reused (Windows forbids replacing an executable while it runs).

An extracted copy is only spawned once its SHA-256 matches the embedded helper. A copy altered in the
extract dir, which may be writable by other users (the temporary folder is), is replaced; when it
cannot be replaced because another process runs it, the connection fails instead of running it. Point
`OIBUS_PI_EXTRACT_DIR` to a folder only the service account can write to (for OIBus, a folder of its
data folder, for instance) to keep other users from planting a file there at all.

The consuming application still needs to tell `pkg` to embed the helper. Add the `runtimes/win-x64`
folder to its `pkg.assets`:

```json
"pkg": {
  "assets": ["node_modules/@oibus/pi/runtimes/win-x64/**/*"]
}
```

## Protocol

Newline-delimited JSON on stdin/stdout, requests/responses correlated by `requestId`. `ok` only ever
appears on `connect`/`disconnect`; `read` responses carry no `ok` at all — `error`'s presence is the
only failure signal. Values are sent as `[timestamp, value, good]` arrays (the TypeScript side builds
the objects). Timeouts are in milliseconds and optional.

```jsonc
{"requestId":"1","command":"connect","id":"<connection-uuid>","serverName":"MYPISERVER","connectionTimeout":15000}
{"requestId":"2","command":"read","id":"<connection-uuid>","startTime":"2026-01-01T00:00:00.000Z","endTime":"2026-01-01T01:00:00.000Z","points":[{"name":"SINUSOID"},{"name":"CDT158","filter":"'CDT158' > 50"}],"queries":[{"query":"tag:=BA:*"}],"pageSize":20000,"timeout":60000}
{"requestId":"3","command":"disconnect","id":"<connection-uuid>"}
```

Responses:

```jsonc
{"requestId":"1","ok":true,"info":{"name":"MYPISERVER","version":"3.4.445.688","uniqueId":"..."}}
{"requestId":"2","points":[{"name":"SINUSOID","point":"SINUSOID","values":[["2026-01-01T00:00:00.000Z",12.5,true]]},{"name":"CDT158","point":"CDT158","filter":"'CDT158' > 50","values":[]}],"notFound":[],"pointsErrors":[],"queries":[{"query":"tag:=BA:*","points":[]}]}
{"requestId":"3","ok":true}
{"requestId":"4","error":"[-10734] PINET: Broken Connection"}
```

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) before working on the helper.

The TypeScript side builds and its unit tests run on any platform (against a fake child process).
The helper builds on any platform with the .NET 10 SDK (it targets .NET Framework 4.8 through
Microsoft's reference assemblies package), but only runs on Windows; Node/npm versions are pinned in
`package.json`'s `engines` field (on Linux/macOS, install with `npm install --force`, since the
package declares `os: ["win32"]`).

```bash
npm install                 # dev dependencies (typescript, tsx, @types/node)
npm run build               # tsc -> dist/index.js + dist/index.d.ts
npm run build:runtimes      # the helper, into runtimes/win-x64/ (what gets published)
npm test                    # unit tests
```

Before each release, check the helper on a Windows machine with PI AF Client, against a PI Data
Archive the account running it can read.

## Release

Releases are cut by pushing a `v*` tag (e.g. `v0.1.0`) — see `.github/workflows/publish.yml`. That
workflow, on a Windows runner, builds the helper (`npm run build:runtimes`) and the TypeScript side,
runs the tests, then publishes through npm Trusted Publishing (OIDC):
configure it for this package on npmjs.com before the first release.

Bump `version` in `package.json` before tagging. `dist/` and `runtimes/` are
gitignored (built fresh by CI, never committed).
