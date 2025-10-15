# 🦅 Tiny Condor

**A tiny but powerful record-based database for Node.js**

> Simple, fast, and production-ready JSON record storage with built-in safety, performance optimizations, and monitoring.

Ever wanted a quick and easy way to store data in your app directly as JSON records? Tiny Condor is the answer.

## ✨ Features

- **🚀 Simple API** - Just 3 core functions: `create()`, `load()`, `save()`
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
