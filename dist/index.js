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
  return new Promise(async (resolve2) => {
    const loaded = CACHE.get(dbfile);
    if (loaded) {
      const metrics = getOrCreateMetrics(dbfile);
      metrics.cacheHits++;
      resolve2(loaded);
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
        return resolve2(null);
      }
    } catch (err) {
      onErrors(enhanceError(err, "load/stat", dbfile));
      return resolve2(null);
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
        resolve2(null);
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
        resolve2(ctx.recs);
      });
    } catch (err) {
      onErrors({
        message: "Unexpected error 5327820",
        err
      });
      resolve2(null);
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
    const stat4 = await fh.stat();
    if (stat4.size === 0) {
      await fh.close();
      return true;
    }
    const buf = Buffer.alloc(1);
    await fh.read(buf, 0, 1, stat4.size - 1);
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

// src/docs.ts
import {
  mkdir as mkdir2,
  open as open2,
  readdir,
  readFile as readFile2,
  rename as rename3,
  stat as stat3,
  unlink as unlink3,
  writeFile as writeFile3
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join as join2,
  posix,
  relative,
  resolve
} from "node:path";
function normalizePrefix(relDir) {
  return relDir ? relDir.replace(/\\/g, "/").replace(/\/+$/, "") : "";
}
function resolveDocTarget(storeDir, rel, allowRoot) {
  if (typeof rel !== "string") return null;
  if (!allowRoot && !rel) return null;
  if (rel.includes("\0")) return null;
  if (isAbsolute(rel)) return null;
  const base = resolve(storeDir);
  const target = rel ? resolve(base, rel) : base;
  const r = relative(base, target);
  if (!allowRoot && !r || r.startsWith("..") || isAbsolute(r)) return null;
  return target;
}
async function putDoc(relPath, content, storeDir, onErrors) {
  const abs = resolveDocTarget(storeDir, relPath, false);
  if (!abs) {
    onErrors({
      code: "INVALID_PATH",
      message: `putDoc: invalid path '${relPath}'`
    });
    return false;
  }
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  try {
    await mkdir2(dirname(abs), { recursive: true });
    await writeFile3(tmp, content, "utf8");
    await rename3(tmp, abs);
    return true;
  } catch (err) {
    try {
      await unlink3(tmp);
    } catch {
    }
    onErrors({
      code: err.code,
      message: `putDoc: ${err.message || String(err)}`,
      err
    });
    return false;
  }
}
async function appendDoc(relPath, content, storeDir, onErrors) {
  const abs = resolveDocTarget(storeDir, relPath, false);
  if (!abs) {
    onErrors({
      code: "INVALID_PATH",
      message: `appendDoc: invalid path '${relPath}'`
    });
    return false;
  }
  try {
    await mkdir2(dirname(abs), { recursive: true });
    const fh = await open2(abs, "a");
    try {
      await fh.write(content, null, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    return true;
  } catch (err) {
    onErrors({
      code: err.code,
      message: `appendDoc: ${err.message || String(err)}`,
      err
    });
    return false;
  }
}
async function getDoc(relPath, storeDir, onErrors) {
  const abs = resolveDocTarget(storeDir, relPath, false);
  if (!abs) {
    onErrors({
      code: "INVALID_PATH",
      message: `getDoc: invalid path '${relPath}'`
    });
    return null;
  }
  try {
    return await readFile2(abs, "utf8");
  } catch (err) {
    onErrors({
      code: err.code,
      message: `getDoc: ${err.message}`,
      err
    });
    return null;
  }
}
async function hasDoc(relPath, storeDir) {
  const abs = resolveDocTarget(storeDir, relPath, false);
  if (!abs) return false;
  try {
    const st = await stat3(abs);
    return st.isFile();
  } catch {
    return false;
  }
}
async function listDocs(relDir, storeDir, onErrors) {
  const abs = resolveDocTarget(storeDir, relDir, true);
  if (abs === null) {
    onErrors({
      code: "INVALID_PATH",
      message: `listDocs: invalid path '${relDir}'`
    });
    return null;
  }
  try {
    const out = [];
    const prefix = normalizePrefix(relDir);
    await walk(abs, prefix, out);
    return out;
  } catch (err) {
    onErrors({
      code: err.code,
      message: `listDocs: ${err.message || String(err)}`,
      err
    });
    return null;
  }
}
async function walk(absDir, relPrefix, out) {
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    const absChild = join2(absDir, entry.name);
    const relChild = relPrefix ? posix.join(relPrefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      await walk(absChild, relChild, out);
    } else if (entry.isFile()) {
      try {
        const st = await stat3(absChild);
        out.push({
          path: relChild,
          size: st.size,
          mtime: st.mtimeMs
        });
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
    }
  }
}
async function deleteDoc(relPath, storeDir, onErrors) {
  const abs = resolveDocTarget(storeDir, relPath, false);
  if (!abs) {
    onErrors({
      code: "INVALID_PATH",
      message: `deleteDoc: invalid path '${relPath}'`
    });
    return false;
  }
  try {
    await unlink3(abs);
    return true;
  } catch (err) {
    onErrors({
      code: err.code,
      message: `deleteDoc: ${err.message}`,
      err
    });
    return false;
  }
}
async function renameDoc(fromPath, toPath, storeDir, onErrors) {
  const from = resolveDocTarget(storeDir, fromPath, false);
  const to = resolveDocTarget(storeDir, toPath, false);
  if (!from || !to) {
    onErrors({
      code: "INVALID_PATH",
      message: `renameDoc: invalid path ${!from ? `from='${fromPath}'` : `to='${toPath}'`}`
    });
    return false;
  }
  try {
    await mkdir2(dirname(to), { recursive: true });
    await rename3(from, to);
    return true;
  } catch (err) {
    onErrors({
      code: err.code,
      message: `renameDoc: ${err.message || String(err)}`,
      err
    });
    return false;
  }
}
async function getDocLines(relPath, from, to, storeDir, onErrors) {
  const abs = resolveDocTarget(storeDir, relPath, false);
  if (!abs) {
    onErrors({
      code: "INVALID_PATH",
      message: `getDocLines: invalid path '${relPath}'`
    });
    return null;
  }
  try {
    const content = await readFile2(abs, "utf8");
    const lines = content.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const start = Math.max(1, from) - 1;
    const end = Math.min(lines.length, to);
    if (start >= end) return "";
    return lines.slice(start, end).join("\n");
  } catch (err) {
    onErrors({
      code: err.code,
      message: `getDocLines: ${err.message}`,
      err
    });
    return null;
  }
}
function parseFrontmatter(content) {
  let nl;
  if (content.startsWith("---\n")) nl = "\n";
  else if (content.startsWith("---\r\n")) nl = "\r\n";
  else return { meta: {}, body: content };
  const openLen = 3 + nl.length;
  const fence = `${nl}---`;
  const close2 = content.indexOf(fence, openLen);
  if (close2 === -1) return { meta: {}, body: content };
  const after = close2 + fence.length;
  if (after !== content.length && content[after] !== "\n" && content[after] !== "\r") {
    return { meta: {}, body: content };
  }
  let bodyStart = after;
  if (content[bodyStart] === "\r") bodyStart++;
  if (content[bodyStart] === "\n") bodyStart++;
  const header = content.slice(openLen, close2);
  const body = content.slice(bodyStart);
  const meta = {};
  for (const raw of header.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    if (!key) continue;
    if (val.startsWith("[") && val.endsWith("]")) {
      meta[key] = val.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else {
      meta[key] = val.replace(/^["']|["']$/g, "");
    }
  }
  return { meta, body };
}
async function grepDocs(pattern, relDir, storeDir, onErrors, opts) {
  const abs = resolveDocTarget(storeDir, relDir, true);
  if (abs === null) {
    onErrors({
      code: "INVALID_PATH",
      message: `grepDocs: invalid path '${relDir}'`
    });
    return null;
  }
  if (typeof pattern !== "string" || !pattern) {
    onErrors({
      code: "INVALID_PATTERN",
      message: `grepDocs: empty pattern`
    });
    return null;
  }
  let re = null;
  let needle = pattern;
  if (opts?.regex) {
    try {
      re = new RegExp(pattern, opts.caseInsensitive ? "i" : "");
    } catch (err) {
      onErrors({
        code: "INVALID_PATTERN",
        message: `grepDocs: bad regex '${pattern}': ${err.message}`,
        err
      });
      return null;
    }
  } else if (opts?.caseInsensitive) {
    needle = pattern.toLowerCase();
  }
  const max = opts?.maxResults ?? Infinity;
  const prefix = normalizePrefix(relDir);
  const entries = [];
  try {
    await walk(abs, prefix, entries);
  } catch (err) {
    onErrors({
      code: err.code,
      message: `grepDocs: ${err.message || String(err)}`,
      err
    });
    return null;
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const out = [];
  const storeAbs = resolve(storeDir);
  for (const entry of entries) {
    if (out.length >= max) break;
    const absFile = join2(storeAbs, entry.path);
    let content;
    try {
      content = await readFile2(absFile, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") continue;
      onErrors({
        code: err.code,
        message: `grepDocs/read ${entry.path}: ${err.message}`,
        err
      });
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (out.length >= max) break;
      const text = lines[i];
      const hit = re ? re.test(text) : opts?.caseInsensitive ? text.toLowerCase().includes(needle) : text.includes(needle);
      if (hit) out.push({ path: entry.path, line: i + 1, text });
    }
  }
  return out;
}
var INDEX_FILENAME = "INDEX.md";
async function renderIndex(relDir, storeDir, onErrors, opts) {
  const abs = resolveDocTarget(storeDir, relDir, true);
  if (abs === null) {
    onErrors({
      code: "INVALID_PATH",
      message: `renderIndex: invalid path '${relDir}'`
    });
    return null;
  }
  const prefix = normalizePrefix(relDir);
  const all = [];
  try {
    await walk(abs, prefix, all);
  } catch (err) {
    onErrors({
      code: err.code,
      message: `renderIndex: ${err.message || String(err)}`,
      err
    });
    return null;
  }
  const recursive = opts?.recursive ?? false;
  const filtered = all.filter((e) => {
    if (posix.basename(e.path) === INDEX_FILENAME) return false;
    if (!recursive) {
      const rest = prefix ? e.path.slice(prefix.length + 1) : e.path;
      if (rest.includes("/")) return false;
    }
    return true;
  });
  filtered.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const rows = [];
  for (const entry of filtered) {
    const summary = await extractSummary(storeDir, entry.path);
    rows.push(
      `| ${entry.path} | ${formatSize(entry.size)} | ${formatDate(entry.mtime)} | ${escapeCell(summary)} |`
    );
  }
  const title = prefix ? `# Index: ${prefix}` : "# Index";
  const header = "| Path | Size | Modified | Summary |";
  const sep = "|------|------|----------|---------|";
  return [title, "", header, sep, ...rows].join("\n") + "\n";
}
async function writeIndex(relDir, storeDir, onErrors, opts) {
  const rendered = await renderIndex(relDir, storeDir, onErrors, opts);
  if (rendered === null) return false;
  const p = normalizePrefix(relDir);
  const target = p ? `${p}/${INDEX_FILENAME}` : INDEX_FILENAME;
  return await putDoc(target, rendered, storeDir, onErrors);
}
var SUMMARY_HEAD_BYTES = 4096;
async function extractSummary(storeDir, relPath) {
  const abs = resolveDocTarget(storeDir, relPath, false);
  if (!abs) return "";
  let fh;
  try {
    fh = await open2(abs, "r");
    const buf = Buffer.alloc(SUMMARY_HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const head = buf.slice(0, bytesRead).toString("utf8");
    const { meta } = parseFrontmatter(head);
    const s = meta.summary;
    return typeof s === "string" ? s : "";
  } catch {
    return "";
  } finally {
    if (fh) {
      try {
        await fh.close();
      } catch {
      }
    }
  }
}
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function formatDate(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function escapeCell(s) {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}
export {
  CondorErrSchema,
  CondorRecSchema,
  appendDoc,
  clearCache,
  create,
  deleteDoc,
  dumpMetrics,
  getBlob,
  getDoc,
  getDocLines,
  getMetrics,
  grepDocs,
  hasBlob,
  hasDoc,
  listDocs,
  load,
  load_,
  parseFrontmatter,
  putBlob,
  putDoc,
  renameDoc,
  renderIndex,
  save,
  writeIndex
};
