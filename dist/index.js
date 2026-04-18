// src/db.ts
import { z } from "zod";
import { createReadStream } from "node:fs";
import { open as openAsync, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { lock } from "proper-lockfile";
import equal from "fast-deep-equal";
var CACHE = /* @__PURE__ */ new Map();
var FILE_METRICS = /* @__PURE__ */ new Map();
function getOrCreateMetrics(dbfile) {
  let metrics = FILE_METRICS.get(dbfile);
  if (!metrics) {
    metrics = {
      dbfile,
      loadCount: 0,
      saveCount: 0,
      totalLoadTimeMs: 0,
      totalSaveTimeMs: 0,
      avgLoadTimeMs: 0,
      avgSaveTimeMs: 0,
      cacheHits: 0,
      cacheMisses: 0,
      recordsLoaded: 0,
      recordsSaved: 0,
      recordsRejected: 0,
      errorCount: 0,
      lastOperationTime: Date.now(),
      currentFileSize: 0,
      currentCacheSize: 0
    };
    FILE_METRICS.set(dbfile, metrics);
  }
  return metrics;
}
var CondorRecSchema = z.object({
  id: z.string(),
  tm: z.number()
}).catchall(z.any());
var CondorErrSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
  record: z.any().optional(),
  err: z.any().optional()
});
function clearCache(dbfile) {
  if (dbfile) {
    CACHE.delete(dbfile);
  } else {
    CACHE.clear();
  }
}
async function withLock(dbfile, fn) {
  const lockfile = `${dbfile}.lock`;
  let release = null;
  try {
    try {
      release = await lock(lockfile, {
        retries: {
          retries: 5,
          minTimeout: 100,
          maxTimeout: 2e3
        },
        stale: 1e4
        // 10 seconds
      });
    } catch (lockErr) {
      if (lockErr.code === "ENOENT" || lockErr.message?.includes("ENOENT")) {
      } else {
        throw lockErr;
      }
    }
    return await fn();
  } finally {
    if (release) {
      await release();
    }
  }
}
function validateTimestamp(tm, onErrors, recId) {
  if (tm < 1e6) {
    return true;
  }
  const now = Date.now();
  const yearInMs = 365 * 24 * 60 * 60 * 1e3;
  const year2020 = (/* @__PURE__ */ new Date("2020-01-01")).getTime();
  if (tm > now + yearInMs) {
    onErrors({
      code: "INVALID_TIMESTAMP",
      message: `Timestamp ${tm} is too far in future (now: ${now})${recId ? ` for record: ${recId}` : ""}`
    });
    return false;
  }
  if (tm < year2020) {
    onErrors({
      code: "INVALID_TIMESTAMP",
      message: `Timestamp ${tm} is before 2020${recId ? ` for record: ${recId}` : ""}`
    });
    return false;
  }
  return true;
}
function enhanceError(err, operation, dbfile) {
  const metrics = getOrCreateMetrics(dbfile);
  metrics.errorCount++;
  metrics.lastErrorTime = Date.now();
  return {
    message: `[${operation}] ${err.message || String(err)}`,
    code: err.code,
    err,
    record: {
      dbfile,
      operation,
      timestamp: Date.now(),
      metrics
    }
  };
}
async function create(initialRecords, dbfile, onErrors) {
  return await withLock(dbfile, async () => {
    const tempFile = `${dbfile}.tmp`;
    try {
      try {
        await stat(dbfile);
        onErrors({
          code: "EEXIST",
          message: `${dbfile} already exists - cannot create!`
        });
        return null;
      } catch (err) {
        if (err.code !== "ENOENT") {
          onErrors(enhanceError(err, "create/stat", dbfile));
          return null;
        }
      }
      const cached = /* @__PURE__ */ new Map();
      const data = updatedRecs(cached, initialRecords, onErrors);
      if (data.recs.length === 0) {
        onErrors({
          message: `failed to find any valid records to initialize file: ${dbfile}`
        });
        return null;
      }
      await writeFile(tempFile, data.str + "\n", "utf8");
      await rename(tempFile, dbfile);
      CACHE.set(dbfile, cached);
      return data.recs;
    } catch (err) {
      try {
        await unlink(tempFile);
      } catch {
      }
      onErrors(enhanceError(err, "create", dbfile));
      return null;
    }
  });
}
function updatedRecs(cached, recs, onErrors) {
  const updatedRecs2 = [];
  const updatedStr = [];
  recs.forEach((record) => {
    if (!record.id) {
      onErrors({
        message: `record missing id`,
        record
      });
      return;
    }
    const recWithTm = record.tm ? record : { ...record, tm: Date.now() };
    validateTimestamp(recWithTm.tm, onErrors, recWithTm.id);
    const current = cached.get(recWithTm.id);
    if (!current || current.tm < recWithTm.tm || current.tm === recWithTm.tm && notEq(current, recWithTm)) {
      try {
        updatedStr.push(JSON.stringify(recWithTm));
        updatedRecs2.push(recWithTm);
        cached.set(recWithTm.id, recWithTm);
      } catch (err) {
        onErrors({ message: `failed to convert record: ${recWithTm.id} to JSON` });
      }
    }
  });
  return {
    recs: updatedRecs2,
    str: updatedStr.join("\n")
  };
}
function notEq(c, r) {
  if (c === r) return false;
  const cWithoutTm = { ...c };
  const rWithoutTm = { ...r };
  delete cWithoutTm.tm;
  delete rWithoutTm.tm;
  return !equal(cWithoutTm, rWithoutTm);
}
async function load(dbfile, onErrors, maxFileSizeBytes = 100 * 1024 * 1024) {
  const recs = await load_(dbfile, onErrors, maxFileSizeBytes);
  if (!recs) return null;
  return unwrap(recs);
}
async function load_(dbfile, onErrors, maxFileSizeBytes = 100 * 1024 * 1024) {
  return new Promise(async (resolve) => {
    const loaded = CACHE.get(dbfile);
    if (loaded) {
      const metrics = getOrCreateMetrics(dbfile);
      metrics.cacheHits++;
      resolve(loaded);
      return;
    }
    try {
      const fileStats = await stat(dbfile);
      const metrics = getOrCreateMetrics(dbfile);
      metrics.currentFileSize = fileStats.size;
      metrics.cacheMisses++;
      if (fileStats.size > maxFileSizeBytes) {
        onErrors({
          code: "FILE_TOO_LARGE",
          message: `File ${dbfile} is too large (${fileStats.size} bytes). Max allowed: ${maxFileSizeBytes} bytes`
        });
        return resolve(null);
      }
    } catch (err) {
      onErrors(enhanceError(err, "load/stat", dbfile));
      return resolve(null);
    }
    const startTime = Date.now();
    try {
      const ctx = {
        closed: false,
        error: false,
        linenum: 0,
        recs: /* @__PURE__ */ new Map()
      };
      const rl = createInterface(createReadStream(dbfile));
      rl.on("line", (line) => {
        ctx.linenum++;
        try {
          const rec = CondorRecSchema.parse(JSON.parse(line));
          validateTimestamp(rec.tm, onErrors, rec.id);
          const current = ctx.recs.get(rec.id);
          if (!current || current.tm < rec.tm || current.tm === rec.tm && notEq(current, rec)) {
            ctx.recs.set(rec.id, rec);
          }
        } catch (err) {
          onErrors({
            message: `failed to get record from line: ${ctx.linenum}`,
            err,
            record: line
          });
        }
      });
      rl.on("error", (err) => {
        onErrors(enhanceError(err, "load/read", dbfile));
        ctx.error = true;
        ctx.closed = true;
        resolve(null);
      });
      rl.on("close", async () => {
        if (ctx.error) return;
        ctx.closed = true;
        const metrics = getOrCreateMetrics(dbfile);
        metrics.loadCount++;
        metrics.recordsLoaded += ctx.recs.size;
        const loadTime = Date.now() - startTime;
        metrics.totalLoadTimeMs += loadTime;
        metrics.avgLoadTimeMs = metrics.totalLoadTimeMs / metrics.loadCount;
        metrics.lastOperationTime = Date.now();
        metrics.currentCacheSize = ctx.recs.size;
        CACHE.set(dbfile, ctx.recs);
        resolve(ctx.recs);
      });
    } catch (err) {
      onErrors({
        message: "Unexpected error 5327820",
        err
      });
      resolve(null);
    }
  });
}
async function save(recordArray, dbfile, onErrors, maxFileSizeBytes = 100 * 1024 * 1024) {
  const startTime = Date.now();
  const metrics = getOrCreateMetrics(dbfile);
  return await withLock(dbfile, async () => {
    const current = await load_(dbfile, onErrors, maxFileSizeBytes);
    if (!current) {
      onErrors({
        message: `failed to get existing records from: ${dbfile}`
      });
      return null;
    }
    const working = new Map(current);
    const data = updatedRecs(working, recordArray, onErrors);
    if (data.recs.length == 0) {
      onErrors({
        message: `nothing new to save in: ${dbfile}`
      });
      return unwrap(current);
    }
    try {
      const fileStats = await stat(dbfile);
      metrics.currentFileSize = fileStats.size;
      if (fileStats.size > 50 * 1024 * 1024) {
        onErrors({
          code: "FILE_SIZE_WARNING",
          message: `File ${dbfile} is large (${fileStats.size} bytes). Consider running compaction.`
        });
      }
    } catch (err) {
      onErrors(enhanceError(err, "save/stat", dbfile));
    }
    try {
      const needsNewline = await fileEndsWithNewline(dbfile, onErrors);
      const toAppend = (needsNewline ? "" : "\n") + data.str + "\n";
      const fh = await openAsync(dbfile, "a");
      await fh.write(toAppend, null, "utf8");
      await fh.sync();
      await fh.close();
      CACHE.set(dbfile, working);
      metrics.saveCount++;
      metrics.recordsSaved += data.recs.length;
      const saveTime = Date.now() - startTime;
      metrics.totalSaveTimeMs += saveTime;
      metrics.avgSaveTimeMs = metrics.totalSaveTimeMs / metrics.saveCount;
      metrics.lastOperationTime = Date.now();
      return unwrap(working);
    } catch (err) {
      onErrors(enhanceError(err, "save/write", dbfile));
      return null;
    }
  });
}
function unwrap(recs) {
  return Array.from(recs.values());
}
async function fileEndsWithNewline(path, onErrors) {
  try {
    const fh = await openAsync(path, "r");
    const stat3 = await fh.stat();
    if (stat3.size === 0) {
      await fh.close();
      return true;
    }
    const buf = Buffer.alloc(1);
    await fh.read(buf, 0, 1, stat3.size - 1);
    await fh.close();
    return buf.toString() === "\n";
  } catch (err) {
    onErrors({
      message: `Failed checking fileEndsWithNewline` + err.message
    });
    return true;
  }
}
function getMetrics(dbfile) {
  if (dbfile) {
    return FILE_METRICS.get(dbfile);
  }
  return FILE_METRICS;
}
async function dumpMetrics(dbfile, outputPath) {
  const metrics = getMetrics(dbfile);
  const data = JSON.stringify(
    dbfile && metrics instanceof Map ? Array.from(metrics.entries()) : metrics,
    null,
    2
  );
  if (outputPath) {
    await writeFile(outputPath, data, "utf8");
  } else {
    console.log("=== TinyCondor Metrics ===");
    console.log(data);
  }
}

// src/store.ts
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rename as rename2,
  stat as stat2,
  unlink as unlink2,
  writeFile as writeFile2
} from "node:fs/promises";
import { join } from "node:path";
function blobPath(storeDir, hash) {
  return join(storeDir, hash.slice(0, 2), hash.slice(2));
}
function isValidHash(h) {
  return typeof h === "string" && /^[0-9a-f]{64}$/.test(h);
}
async function putBlob(data, storeDir, onErrors) {
  try {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const hash = createHash("sha256").update(buf).digest("hex");
    const final = blobPath(storeDir, hash);
    try {
      await stat2(final);
      return hash;
    } catch (err) {
      if (err.code !== "ENOENT") {
        onErrors({
          code: err.code,
          message: `putBlob/stat: ${err.message}`,
          err
        });
        return null;
      }
    }
    const dir = join(storeDir, hash.slice(0, 2));
    await mkdir(dir, { recursive: true });
    const tmp = `${final}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile2(tmp, buf);
      await rename2(tmp, final);
    } catch (err) {
      try {
        await unlink2(tmp);
      } catch {
      }
      onErrors({
        code: err.code,
        message: `putBlob/write: ${err.message}`,
        err
      });
      return null;
    }
    return hash;
  } catch (err) {
    onErrors({
      code: err.code,
      message: `putBlob: ${err.message || String(err)}`,
      err
    });
    return null;
  }
}
async function getBlob(hash, storeDir, onErrors) {
  if (!isValidHash(hash)) {
    onErrors({
      code: "INVALID_HASH",
      message: `getBlob: invalid hash '${hash}'`
    });
    return null;
  }
  try {
    return await readFile(blobPath(storeDir, hash));
  } catch (err) {
    onErrors({
      code: err.code,
      message: `getBlob: ${err.message}`,
      err
    });
    return null;
  }
}
async function hasBlob(hash, storeDir) {
  if (!isValidHash(hash)) return false;
  try {
    await stat2(blobPath(storeDir, hash));
    return true;
  } catch {
    return false;
  }
}
export {
  CondorErrSchema,
  CondorRecSchema,
  clearCache,
  create,
  dumpMetrics,
  getBlob,
  getMetrics,
  hasBlob,
  load,
  load_,
  putBlob,
  save
};
