# 🦅 Tiny Condor

**A tiny but powerful record-based database for Node.js**

> Simple, fast, and production-ready JSON record storage with built-in safety, performance optimizations, and monitoring.

Ever wanted a quick and easy way to store data in your app directly as JSON records? Tiny Condor is the answer.

## ✨ Features

- **🚀 Simple API** - Just 3 core functions: `create()`, `load()`, `save()`
- **📎 Blob Store** - Attach large/binary payloads with `putBlob()` / `getBlob()` — content-addressed, deduplicated, immutable
- **📝 Doc Store** - Store evolving markdown/text (agent memory, chats, notes) with `putDoc()` / `appendDoc()` / `getDoc()` — id-addressed, mutable, human-navigable
- **🔍 Agent-Memory Helpers** - `grepDocs()` for pattern recall, `renderIndex()` / `writeIndex()` for scannable directory views, `getDocLines()` for token-budgeted reads, frontmatter support
- **🔒 Production-Safe** - File locking, atomic writes, and crash protection
- **⚡ Optimized** - Fast deep equality, in-memory caching, and smart validation
- **📊 Observable** - Built-in metrics tracking for performance monitoring
- **🛡️ Resilient** - File size checks, timestamp validation, and enhanced error handling
- **📦 Lightweight** - Minimal dependencies, human-readable JSON storage
- **🔄 Git-Friendly** - Plain text format, perfect for version control and debugging

## 🎯 Perfect For

- Configuration storage with history
- Event sourcing and audit logs
- Prototyping and MVPs
- Small to medium datasets (<100MB)
- Apps needing human-readable data
- Teams wanting git-trackable state

## 📦 Installation

```bash
npm install tinycondor
```

## 🚀 Quick Start

### Basic Usage

You can save any type of data. The only requirement is the record must be identified by an `id` field.

```ts
import { create, load, save, clearCache } from 'tinycondor';

type CondorRec = {
    id: string;
    tm?: number;  // Auto-generated if not provided
};
```

The interface is simple and powerful:

```js
// Create a new database
const data = await create(initialRecords, dbfile, onErrors);

// Load existing records
const data = await load(dbfile, onErrors);

// Save/update records
const data = await save(recordArray, dbfile, onErrors);

// Free up memory when needed
clearCache(dbfile);
```

### Error Handling

The `onErrors` callback receives detailed database errors:

```js
const onErrorsHandler = ({ message, code, record }) => {
    // ALWAYS AVAILABLE
    //  message    - Human-readable error message
    //  code       - Error code (e.g., 'EEXIST', 'FILE_TOO_LARGE', 'INVALID_TIMESTAMP')
    //
    // OPTIONAL
    //  record     - Record that failed to load/save
    //  err        - Original error object with stack trace
    //  dbfile     - Path to database file
    //  operation  - Operation being performed (e.g., 'create', 'load', 'save')
    //  timestamp  - When the error occurred
    //  metrics    - Current database metrics
};
```

## 🔧 Advanced Features

### Blob Store (Large / Binary References)

Keep records small. When you want to attach images, uploads, snapshots, or any payload that would bloat the append-only log, store the bytes in the blob store and reference them by SHA-256 hash from your record.

```js
import { putBlob, getBlob, hasBlob, save, load } from 'tinycondor';

// Store bytes — same content always produces the same hash (dedup)
const avatarBytes = await fs.readFile('./avatar.png');
const hash = await putBlob(avatarBytes, './blobs', onErrors);

// Reference the hash from any record field you like
await save([{ id: 'u1', tm: Date.now(), avatar: hash }], './users.json', onErrors);

// Later — fetch the bytes back
const users = await load('./users.json', onErrors);
const rec = users.find(u => u.id === 'u1');
const bytes = await getBlob(rec.avatar, './blobs', onErrors);

// Cheap existence probe
const present = await hasBlob(hash, './blobs');
```

**How it works.** Blobs are hashed with SHA-256 and written to `{storeDir}/ab/cdef0123...` using a git-style 2-char fanout directory. Writes are atomic (temp file + rename) and idempotent — storing the same bytes twice is a no-op. Hashes are validated before any filesystem access to block path traversal.

**Scope.** `putBlob` accepts `string | Buffer` (strings encoded as utf8); `getBlob` returns a `Buffer`. Intended for payloads up to a few hundred MB. There is no built-in garbage collection — when you overwrite a record with a new blob hash, the old blob remains on disk. Write a sweep yourself when needed.

### Doc Store (Mutable Text Documents)

When the data is evolving text — LLM chat logs, agent memory files, per-user notes — the blob store is the wrong tool: content-addressed means every edit creates a new file and orphans the old one. The doc store gives you id-addressed, mutable storage with a human-navigable folder layout instead.

```js
import { putDoc, appendDoc, getDoc, listDocs, deleteDoc } from 'tinycondor';

// Overwrite (atomic temp + rename)
await putDoc('agents/planner/memory.md', '# Goals\n- ship v2', './docs', onErrors);

// Append turn-by-turn (fsynced before return)
await appendDoc('chats/session-42.md', '\n**user:** hello\n', './docs', onErrors);
await appendDoc('chats/session-42.md', '**assistant:** hi!\n', './docs', onErrors);

// Read
const memory = await getDoc('agents/planner/memory.md', './docs', onErrors);

// Walk a subtree for compaction flows
const entries = await listDocs('chats', './docs', onErrors);
// entries => [{ path: 'chats/session-42.md', size: 48, mtime: 1713456789000 }, ...]

// Remove old docs during compaction
await deleteDoc('chats/session-01.md', './docs', onErrors);
```

**How it works.** Docs live at `{storeDir}/{relPath}` using the path you choose — `chats/session-42.md`, `agents/planner/memory.md`, whatever makes sense. `putDoc` writes to a temp file and renames, so a crash can never leave a half-written doc. `appendDoc` opens in append mode and fsyncs before close. `listDocs` walks the named subtree recursively and returns every file (not directories) with its size and mtime, so "keep the newest N memories, delete the rest" is a short script. Every function rejects paths with `..`, absolute paths, or null bytes before any fs access.

**Scope.** Text only — `putDoc` and `appendDoc` take `string`, `getDoc` returns `string`. For bytes, use the blob store. There is no locking; if two processes append to the same doc concurrently the writes interleave.

### Agent-Memory Helpers

The doc store exists so you can build an **external memory for chat-only agents**: persistent profile, session transcripts, pattern notes, handoff artifacts. Five helpers make that workflow first-class without pulling in a vector database. ([Letta's 2025 benchmark](https://www.letta.com/blog/benchmarking-ai-agent-memory) showed filesystem + grep beats vector-graph memory on LoCoMo — this is by design, not a shortcut.)

```js
import {
  grepDocs, renderIndex, writeIndex, getDocLines, renameDoc
} from 'tinycondor';

// Pattern recognition — "you mentioned your sister three times this week"
const hits = await grepDocs('sister', 'players/charles/conversations', './docs', onErrors);
// => [{ path: 'players/charles/conversations/urim/2026-04-01.md', line: 14, text: '...' }, ...]

// Scan a directory without loading every file
const index = await renderIndex('players/charles', './docs', onErrors, { recursive: true });
// Returns a markdown table with path, size, modified date, and summary (from frontmatter).

// Persist the same index as a real file for git/file-only consumers
await writeIndex('players/charles', './docs', onErrors, { recursive: true });
// Writes players/charles/INDEX.md.

// Token-budgeted reads — load only the relevant range
const snippet = await getDocLines(
  'players/charles/conversations/urim/2026-04-05.md',
  40, 60, './docs', onErrors
);

// Archiving during compaction — atomic move, auto-creates dest dirs
await renameDoc(
  'players/charles/conversations/urim/2026-04-01.md',
  'players/charles/archive/2026-04/2026-04-01.md',
  './docs', onErrors
);
```

**Frontmatter.** Any doc can start with a YAML-ish block. `renderIndex` reads `summary:` into the Summary column; `tags:` is available via `parseFrontmatter`.

```markdown
---
summary: Excavated the drift pattern around career
tags: [career, drift, urim]
---
# Body...
```

**grepDocs options.** Pass `{ regex: true }` for regex patterns, `{ caseInsensitive: true }`, or `{ maxResults: N }` to cap the scan. Matches come back sorted by path then line for stable agent output.

**Why agent-maintained indexes, not auto-on-write.** `writeIndex` is opt-in on purpose: every write cascading into parent-dir updates would multiply I/O and widen the race window on batched operations. Call `writeIndex` when you want a persisted snapshot — e.g. at the end of an agent turn, or during compaction.

### File Size Protection

Prevent out-of-memory errors with configurable size limits:

```js
// Set custom file size limit (default: 100MB)
const data = await load(dbfile, onErrors, 50 * 1024 * 1024); // 50MB limit
const saved = await save(records, dbfile, onErrors, 50 * 1024 * 1024);

// Automatic warnings at 50MB suggesting compaction
```

### Performance Metrics

Track database performance and health:

```js
import { getMetrics, dumpMetrics } from 'tinycondor';

// Get metrics for specific file
const metrics = getMetrics(dbfile);
console.log(`Avg load time: ${metrics.avgLoadTimeMs}ms`);
console.log(`Cache hit rate: ${metrics.cacheHits / (metrics.cacheHits + metrics.cacheMisses)}`);

// Get all metrics
const allMetrics = getMetrics();

// Dump to console
await dumpMetrics();

// Save to file
await dumpMetrics(dbfile, './metrics.json');
```

**Available Metrics:**
```ts
{
  // Performance
  loadCount: number;
  saveCount: number;
  avgLoadTimeMs: number;
  avgSaveTimeMs: number;

  // Cache efficiency
  cacheHits: number;
  cacheMisses: number;

  // Volume
  recordsLoaded: number;
  recordsSaved: number;
  recordsRejected: number;

  // Health
  errorCount: number;
  lastErrorTime?: number;
  lastOperationTime: number;

  // Size tracking
  currentFileSize: number;
  currentCacheSize: number;
}
```

## 🛡️ Safety Features

### File Locking
Prevents concurrent write corruption in multi-process environments.

### Atomic Writes
Uses temp file + rename pattern to prevent corruption from power loss during file creation.

### Crash Protection
`fsync()` ensures data is written to disk before operations complete.

### Timestamp Validation
Automatically detects suspicious timestamps (too far in future or before 2020).

### Smart Error Recovery
Enhanced error messages with full context for easier debugging.

## ⚡ Performance

- **Fast Deep Equality** - Optimized comparisons with early-exit
- **In-Memory Caching** - Avoid repeated file reads
- **Efficient Updates** - Only writes changed records
- **Append-Only Architecture** - Fast writes without full rewrites

## 📚 API Reference

### `create(initialRecords, dbfile, onErrors)`
Create a new database file with initial records.
- Returns: `Promise<CondorRec[] | null>`
- Fails if file already exists

### `load(dbfile, onErrors, maxFileSizeBytes?)`
Load records from existing database.
- Returns: `Promise<CondorRec[] | null>`
- Default max size: 100MB

### `save(recordArray, dbfile, onErrors, maxFileSizeBytes?)`
Save/update records to database.
- Returns: `Promise<CondorRec[] | null>`
- Automatically merges with existing records based on timestamp

### `clearCache(dbfile?)`
Clear in-memory cache for specific file or all files.
- Returns: `void`

### `putBlob(data, storeDir, onErrors)`
Hash `data` (string or Buffer) with SHA-256 and store under `storeDir` using a `ab/cdef...` fanout layout. Idempotent — duplicates are skipped.
- Returns: `Promise<string | null>` — 64-char hex hash on success

### `getBlob(hash, storeDir, onErrors)`
Fetch blob bytes for a previously-stored hash.
- Returns: `Promise<Buffer | null>`
- Rejects malformed hashes (anything other than 64 lowercase hex chars) before touching the filesystem

### `hasBlob(hash, storeDir)`
Probe whether a blob is present.
- Returns: `Promise<boolean>` — `false` on any error, including invalid hash

### `putDoc(relPath, content, storeDir, onErrors)`
Atomically write `content` (utf8 string) to `{storeDir}/{relPath}`. Auto-creates parent directories.
- Returns: `Promise<boolean>` — `true` on success

### `appendDoc(relPath, content, storeDir, onErrors)`
Append `content` (utf8 string) to `{storeDir}/{relPath}`, fsyncing before return. Creates the file if missing.
- Returns: `Promise<boolean>` — `true` on success

### `getDoc(relPath, storeDir, onErrors)`
Read a doc as a utf8 string.
- Returns: `Promise<string | null>`

### `hasDoc(relPath, storeDir)`
Probe whether a doc is present (directories return `false`).
- Returns: `Promise<boolean>` — `false` on any error, including invalid path

### `listDocs(relDir, storeDir, onErrors)`
Recursively list every file under `{storeDir}/{relDir}`. Pass `""` to walk the whole store. Missing `relDir` returns `[]` silently.
- Returns: `Promise<DocEntry[] | null>` where `DocEntry` is `{ path: string; size: number; mtime: number }`

### `deleteDoc(relPath, storeDir, onErrors)`
Remove a single doc.
- Returns: `Promise<boolean>` — `true` on success

### `renameDoc(fromPath, toPath, storeDir, onErrors)`
Atomically move a doc. Auto-creates the destination's parent directories. Cross-filesystem moves surface as `EXDEV`.
- Returns: `Promise<boolean>` — `true` on success

### `getDocLines(relPath, from, to, storeDir, onErrors)`
Read a 1-indexed inclusive line range. Out-of-range `from`/`to` clamp silently so callers can pass generous bounds.
- Returns: `Promise<string | null>`

### `grepDocs(pattern, relDir, storeDir, onErrors, opts?)`
Scan every doc under `relDir` for a pattern. Options: `{ regex?, caseInsensitive?, maxResults? }`. Matches come back sorted by path then line.
- Returns: `Promise<DocMatch[] | null>` where `DocMatch` is `{ path: string; line: number; text: string }`

### `renderIndex(relDir, storeDir, onErrors, opts?)`
Return a markdown table (path, size, modified, summary-from-frontmatter) describing the directory's contents. Pass `{ recursive: true }` to include descendants. Skips `INDEX.md` files automatically.
- Returns: `Promise<string | null>`

### `writeIndex(relDir, storeDir, onErrors, opts?)`
Generate the same markdown as `renderIndex` and persist it to `{relDir}/INDEX.md`. Overwrites any existing index atomically.
- Returns: `Promise<boolean>`

### `parseFrontmatter(content)`
Parse a YAML-ish frontmatter block from the top of a string. Supports scalar values (`key: value`) and inline arrays (`key: [a, b, c]`). Returns `{ meta, body }` where `meta` is `{ [key: string]: string | string[] }`.

### `getMetrics(dbfile?)`
Get performance metrics for specific file or all files.
- Returns: `FileMetrics | Map<string, FileMetrics> | undefined`

### `dumpMetrics(dbfile?, outputPath?)`
Dump metrics to console or file.
- Returns: `Promise<void>`

## 🔄 How It Works

1. **Append-Only Log** - New records are appended to the file
2. **Latest Wins** - On load, the most recent version of each record (by `id`) is kept
3. **Timestamp-Based** - Records with newer `tm` values override older ones
4. **In-Memory Cache** - Loaded records stay in memory for fast access

## 🎓 Best Practices

1. **Regular Backups** - Always maintain backups of your database files
2. **Regular Compaction** - Watch for file size warnings and compact when needed
3. **Error Monitoring** - Always implement robust error handlers
4. **Metrics Tracking** - Use metrics to identify performance bottlenecks
5. **Size Limits** - Set appropriate `maxFileSizeBytes` for your use case
6. **Cache Management** - Use `clearCache()` in long-running processes
7. **Test Your Recovery** - Regularly test your backup and recovery procedures

## 🔮 When to Use SQLite Instead

Consider SQLite for:
- Datasets >10K records or >10MB
- Complex queries beyond simple key lookup
- High concurrency requirements
- Need for relational data
- Full ACID transaction support

Tiny Condor excels at:
- Simple record storage
- Human-readable data
- Git-friendly state
- Rapid prototyping
- Debugging and auditing

## ⚠️ Important Disclaimers

### Data Safety

While Tiny Condor includes multiple safety features (file locking, atomic writes, fsync), **no software can guarantee 100% data safety**. You should:

- ✅ **Always maintain regular backups** of your database files
- ✅ **Test your backup and recovery procedures** before relying on them
- ✅ **Monitor error handlers** for any data integrity issues
- ✅ **Use appropriate file size limits** to prevent out-of-memory errors
- ✅ **Consider using SQLite** for mission-critical data or larger datasets

### Production Use

Tiny Condor is suitable for production use cases within its design constraints:

- ✅ **Good for:** Configuration storage, event logs, small datasets, prototypes
- ⚠️ **Consider alternatives for:** High-volume transactions, complex queries, large datasets (>100MB), high-concurrency scenarios

### Warranty Disclaimer

**THIS SOFTWARE IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND**, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and noninfringement. In no event shall the authors or copyright holders be liable for any claim, damages, or other liability arising from the use of this software.

See the [LICENSE](./LICENSE) file for full legal details.

### Data Loss Prevention

To minimize the risk of data loss:

1. **Implement comprehensive error handlers** - Monitor all errors via the `onErrors` callback
2. **Set up automated backups** - Use cron jobs or similar to back up database files regularly
3. **Monitor metrics** - Track error counts and file sizes to detect issues early
4. **Test failure scenarios** - Verify behavior during power loss, disk full, etc.
5. **Have a recovery plan** - Document and test your data recovery procedures

### Known Limitations

- **File-based locking** may not work correctly on network file systems (NFS, SMB)
- **Append-only architecture** means files grow until compacted
- **Single-writer recommended** for best reliability (multiple writers supported via locking but may have edge cases)
- **No built-in encryption** - Implement at the application level if needed
- **No schema validation** beyond `id` and `tm` fields - Use Zod or similar for application-level validation
- **No blob garbage collection** - Orphaned blobs accumulate when records are updated to point at new hashes. Run a manual sweep if this matters for your workload.
- **No doc locking** - Concurrent `appendDoc` calls to the same path from separate processes will interleave. Serialize at the application layer if that matters.

## 📄 License

ISC License - see [LICENSE](./LICENSE) file for details.

Copyright (c) 2024, Charles Lobo

## 🤝 Contributing

Issues and PRs welcome at [github.com/theproductiveprogrammer/tinycondor](https://github.com/theproductiveprogrammer/tinycondor)

Please include:
- Clear description of the issue or feature
- Reproduction steps for bugs
- Test cases for new features
- Documentation updates where applicable

## 🙏 Acknowledgments

Built with:
- [zod](https://github.com/colinhacks/zod) - Schema validation
- [proper-lockfile](https://github.com/moxystudio/node-proper-lockfile) - File locking
- [fast-deep-equal](https://github.com/epoberezkin/fast-deep-equal) - Optimized equality checks
