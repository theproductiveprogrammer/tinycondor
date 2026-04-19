"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  CondorErrSchema: () => CondorErrSchema,
  CondorRecSchema: () => CondorRecSchema,
  appendDoc: () => appendDoc,
  clearCache: () => clearCache,
  create: () => create,
  deleteDoc: () => deleteDoc,
  dumpMetrics: () => dumpMetrics,
  getBlob: () => getBlob,
  getDoc: () => getDoc,
  getDocLines: () => getDocLines,
  getMetrics: () => getMetrics,
  grepDocs: () => grepDocs,
  hasBlob: () => hasBlob,
  hasDoc: () => hasDoc,
  listDocs: () => listDocs,
  load: () => load,
  load_: () => load_,
  parseFrontmatter: () => parseFrontmatter,
  putBlob: () => putBlob,
  putDoc: () => putDoc,
  renameDoc: () => renameDoc,
  renderIndex: () => renderIndex,
  save: () => save,
  writeIndex: () => writeIndex
});
module.exports = __toCommonJS(index_exports);

// src/db.ts
var import_zod = require("zod");
var import_node_fs = require("fs");
var import_promises = require("fs/promises");
var import_node_readline = require("readline");
var import_proper_lockfile = require("proper-lockfile");
var import_fast_deep_equal = __toESM(require("fast-deep-equal"), 1);
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
var CondorRecSchema = import_zod.z.object({
  id: import_zod.z.string(),
  tm: import_zod.z.number()
}).catchall(import_zod.z.any());
var CondorErrSchema = import_zod.z.object({
  message: import_zod.z.string(),
  code: import_zod.z.string().optional(),
  record: import_zod.z.any().optional(),
  err: import_zod.z.any().optional()
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
      release = await (0, import_proper_lockfile.lock)(lockfile, {
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
        await (0, import_promises.stat)(dbfile);
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
      await (0, import_promises.writeFile)(tempFile, data.str + "\n", "utf8");
      await (0, import_promises.rename)(tempFile, dbfile);
      CACHE.set(dbfile, cached);
      return data.recs;
    } catch (err) {
      try {
        await (0, import_promises.unlink)(tempFile);
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
  return !(0, import_fast_deep_equal.default)(cWithoutTm, rWithoutTm);
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
      const fileStats = await (0, import_promises.stat)(dbfile);
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
      const rl = (0, import_node_readline.createInterface)((0, import_node_fs.createReadStream)(dbfile));
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
      const fileStats = await (0, import_promises.stat)(dbfile);
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
      const fh = await (0, import_promises.open)(dbfile, "a");
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
    const fh = await (0, import_promises.open)(path, "r");
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
    await (0, import_promises.writeFile)(outputPath, data, "utf8");
  } else {
    console.log("=== TinyCondor Metrics ===");
    console.log(data);
  }
}

// src/store.ts
var import_node_crypto = require("crypto");
var import_promises2 = require("fs/promises");
var import_node_path = require("path");
function blobPath(storeDir, hash) {
  return (0, import_node_path.join)(storeDir, hash.slice(0, 2), hash.slice(2));
}
function isValidHash(h) {
  return typeof h === "string" && /^[0-9a-f]{64}$/.test(h);
}
async function putBlob(data, storeDir, onErrors) {
  try {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const hash = (0, import_node_crypto.createHash)("sha256").update(buf).digest("hex");
    const final = blobPath(storeDir, hash);
    try {
      await (0, import_promises2.stat)(final);
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
    const dir = (0, import_node_path.join)(storeDir, hash.slice(0, 2));
    await (0, import_promises2.mkdir)(dir, { recursive: true });
    const tmp = `${final}.tmp-${process.pid}-${Date.now()}`;
    try {
      await (0, import_promises2.writeFile)(tmp, buf);
      await (0, import_promises2.rename)(tmp, final);
    } catch (err) {
      try {
        await (0, import_promises2.unlink)(tmp);
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
    return await (0, import_promises2.readFile)(blobPath(storeDir, hash));
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
    await (0, import_promises2.stat)(blobPath(storeDir, hash));
    return true;
  } catch {
    return false;
  }
}

// src/docs.ts
var import_promises3 = require("fs/promises");
var import_node_path2 = require("path");
function normalizePrefix(relDir) {
  return relDir ? relDir.replace(/\\/g, "/").replace(/\/+$/, "") : "";
}
function resolveDocTarget(storeDir, rel, allowRoot) {
  if (typeof rel !== "string") return null;
  if (!allowRoot && !rel) return null;
  if (rel.includes("\0")) return null;
  if ((0, import_node_path2.isAbsolute)(rel)) return null;
  const base = (0, import_node_path2.resolve)(storeDir);
  const target = rel ? (0, import_node_path2.resolve)(base, rel) : base;
  const r = (0, import_node_path2.relative)(base, target);
  if (!allowRoot && !r || r.startsWith("..") || (0, import_node_path2.isAbsolute)(r)) return null;
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
    await (0, import_promises3.mkdir)((0, import_node_path2.dirname)(abs), { recursive: true });
    await (0, import_promises3.writeFile)(tmp, content, "utf8");
    await (0, import_promises3.rename)(tmp, abs);
    return true;
  } catch (err) {
    try {
      await (0, import_promises3.unlink)(tmp);
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
    await (0, import_promises3.mkdir)((0, import_node_path2.dirname)(abs), { recursive: true });
    const fh = await (0, import_promises3.open)(abs, "a");
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
    return await (0, import_promises3.readFile)(abs, "utf8");
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
    const st = await (0, import_promises3.stat)(abs);
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
    entries = await (0, import_promises3.readdir)(absDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    const absChild = (0, import_node_path2.join)(absDir, entry.name);
    const relChild = relPrefix ? import_node_path2.posix.join(relPrefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      await walk(absChild, relChild, out);
    } else if (entry.isFile()) {
      try {
        const st = await (0, import_promises3.stat)(absChild);
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
    await (0, import_promises3.unlink)(abs);
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
    await (0, import_promises3.mkdir)((0, import_node_path2.dirname)(to), { recursive: true });
    await (0, import_promises3.rename)(from, to);
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
    const content = await (0, import_promises3.readFile)(abs, "utf8");
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
  const storeAbs = (0, import_node_path2.resolve)(storeDir);
  for (const entry of entries) {
    if (out.length >= max) break;
    const absFile = (0, import_node_path2.join)(storeAbs, entry.path);
    let content;
    try {
      content = await (0, import_promises3.readFile)(absFile, "utf8");
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
    if (import_node_path2.posix.basename(e.path) === INDEX_FILENAME) return false;
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
    fh = await (0, import_promises3.open)(abs, "r");
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
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
});
