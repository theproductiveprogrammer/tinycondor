// src/db.ts
import { z } from "zod";
import { open, close, write, createReadStream } from "node:fs";
import { appendFile, open as openAsync } from "node:fs/promises";
import { createInterface } from "node:readline";
var CACHE = /* @__PURE__ */ new Map();
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
function clearCache() {
  CACHE.clear();
}
async function create(initialRecords, dbfile, onErrors) {
  return new Promise((resolve) => {
    open(dbfile, "wx", (err, fd) => {
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
      write(fd, data.str, null, "utf8", (err2) => {
        close(fd);
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
    if (!current || current.tm !== record.tm && notEq(current, record)) {
      try {
        updatedStr.push(JSON.stringify(record));
        updatedRecs2.push(record);
        if (!current || current.tm < record.tm) {
          cached.set(record.id, record);
        }
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
      const rl = createInterface(createReadStream(dbfile));
      rl.on("line", (line) => {
        ctx.linenum++;
        try {
          const rec = CondorRecSchema.parse(JSON.parse(line));
          const current = ctx.recs.get(rec.id);
          if (!current || current.tm < rec.tm) {
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
  await appendFile(dbfile, toAppend);
  return unwrap(current);
}
function unwrap(recs) {
  return Array.from(recs.values());
}
async function fileEndsWithNewline(path, onErrors) {
  try {
    const fh = await openAsync(path, "r");
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
export {
  CondorErrSchema,
  CondorRecSchema,
  clearCache,
  create,
  load,
  load_,
  save
};
