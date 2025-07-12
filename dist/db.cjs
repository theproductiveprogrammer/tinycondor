"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/db.ts
var db_exports = {};
__export(db_exports, {
  CondorErrSchema: () => CondorErrSchema,
  CondorRecSchema: () => CondorRecSchema,
  clearCache: () => clearCache,
  create: () => create,
  load: () => load,
  load_: () => load_,
  save: () => save
});
module.exports = __toCommonJS(db_exports);
var import_zod = require("zod");
var import_node_fs = require("fs");
var import_promises = require("fs/promises");
var import_node_readline = require("readline");
var CACHE = /* @__PURE__ */ new Map();
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
function clearCache() {
  CACHE.clear();
}
async function create(initialRecords, dbfile, onErrors) {
  return new Promise((resolve) => {
    (0, import_node_fs.open)(dbfile, "wx", (err, fd) => {
      if (err) {
        if (err.code === "EEXIST") {
          onErrors({
            code: "EEXIST",
            message: `${dbfile} already exists - cannot create!`
          });
        } else {
          onErrors(err);
        }
        return resolve(null);
      }
      const cached = /* @__PURE__ */ new Map();
      CACHE.set(dbfile, cached);
      const data = updatedRecs(cached, initialRecords, onErrors);
      if (data.recs.length == 0) {
        onErrors({
          message: `failed to find any valid records to initialize file: ${dbfile}`
        });
        return resolve(null);
      }
      (0, import_node_fs.write)(fd, data.str, null, "utf8", (err2) => {
        (0, import_node_fs.close)(fd);
        if (err2) {
          onErrors({
            message: `failed to write initial records to file: ${dbfile}`,
            err: err2
          });
          return resolve(null);
        }
        return resolve(data.recs);
      });
    });
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
    if (!record.tm) record.tm = Date.now();
    const current = cached.get(record.id);
    if (!current || current.tm < record.tm || current.tm === record.tm && notEq(current, record)) {
      try {
        updatedStr.push(JSON.stringify(record));
        updatedRecs2.push(record);
        cached.set(record.id, record);
      } catch (err) {
        onErrors({ message: `failed to convert record: ${record.id} to JSON` });
      }
    }
  });
  return {
    recs: updatedRecs2,
    str: updatedStr.join("\n")
  };
}
function notEq(c, r) {
  const keys = Object.keys(c);
  if (keys.length !== Object.keys(r).length) return true;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k === "tm") continue;
    if (typeof c[k] === "object") {
      if (notEq(c[k], r[k])) return true;
    } else {
      if (c[k] !== r[k]) return true;
    }
  }
  return false;
}
async function load(dbfile, onErrors) {
  const recs = await load_(dbfile, onErrors);
  if (!recs) return null;
  return unwrap(recs);
}
async function load_(dbfile, onErrors) {
  return new Promise((resolve) => {
    const loaded = CACHE.get(dbfile);
    if (loaded) {
      resolve(loaded);
      return;
    }
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
        onErrors({
          message: "error(1231) when reading data for:" + dbfile,
          err
        });
        ctx.error = true;
        if (!ctx.closed) {
          resolve(null);
        }
      });
      rl.on("close", async () => {
        if (ctx.error) return;
        ctx.closed = true;
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
async function save(recordArray, dbfile, onErrors) {
  const current = await load_(dbfile, onErrors);
  if (!current) {
    onErrors({
      message: `failed to get existing records from: ${dbfile}`
    });
    return null;
  }
  const data = updatedRecs(current, recordArray, onErrors);
  if (data.recs.length == 0) {
    onErrors({
      message: `nothing new to save in: ${dbfile}`
    });
    return unwrap(current);
  }
  const needsNewline = await fileEndsWithNewline(dbfile, onErrors);
  const toAppend = (needsNewline ? "" : "\n") + data.str + "\n";
  await (0, import_promises.appendFile)(dbfile, toAppend);
  return unwrap(current);
}
function unwrap(recs) {
  return Array.from(recs.values());
}
async function fileEndsWithNewline(path, onErrors) {
  try {
    const fh = await (0, import_promises.open)(path, "r");
    const stat = await fh.stat();
    if (stat.size === 0) {
      await fh.close();
      return true;
    }
    const buf = Buffer.alloc(1);
    await fh.read(buf, 0, 1, stat.size - 1);
    await fh.close();
    return buf.toString() === "\n";
  } catch (err) {
    onErrors({
      message: `Failed checking fileEndsWithNewline` + err.message
    });
    return true;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CondorErrSchema,
  CondorRecSchema,
  clearCache,
  create,
  load,
  load_,
  save
});
