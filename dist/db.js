"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.create = create;
exports.load = load;
exports.load_ = load_;
exports.save = save;
const zod_1 = require("zod");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_readline_1 = require("node:readline");
const CACHE = new Map();
const CondorRecSchema = zod_1.z
    .object({
    id: zod_1.z.string(),
    tm: zod_1.z.number(),
})
    .catchall(zod_1.z.any());
const CondorErrSchema = zod_1.z.object({
    message: zod_1.z.string(),
    code: zod_1.z.string().optional(),
    record: zod_1.z.any().optional(),
    err: zod_1.z.any().optional(),
});
async function create(initialRecords, dbfile, onErrors) {
    return new Promise((resolve) => {
        (0, node_fs_1.open)(dbfile, "wx", (err, fd) => {
            if (err) {
                if (err.code === "EEXIST") {
                    onErrors({
                        code: "EEXIST",
                        message: `${dbfile} already exists - cannot create!`,
                    });
                }
                else {
                    onErrors(err);
                }
                return resolve(null);
            }
            const cached = new Map();
            CACHE.set(dbfile, cached);
            const data = updatedRecs(cached, initialRecords, onErrors);
            if (data.recs.length == 0) {
                onErrors({
                    message: `failed to find any valid records to initialize file: ${dbfile}`,
                });
                return resolve(null);
            }
            (0, node_fs_1.write)(fd, data.str, null, "utf8", (err) => {
                (0, node_fs_1.close)(fd);
                if (err) {
                    onErrors({
                        message: `failed to write initial records to file: ${dbfile}`,
                        err,
                    });
                    return resolve(null);
                }
                return resolve(data.recs);
            });
        });
    });
}
/*		way/
 * check that the record is valid (has an id), ensure a timestamp,
 * then check if it is not already an existing record.
 */
function updatedRecs(cached, recs, onErrors) {
    const updatedRecs = [];
    const updatedStr = [];
    recs.forEach((record) => {
        if (!record.id) {
            onErrors({
                message: `record missing id`,
                record,
            });
            return;
        }
        if (!record.tm)
            record.tm = Date.now();
        const current = cached.get(record.id);
        if (!current || (current.tm !== record.tm && notEq(current, record))) {
            try {
                updatedStr.push(JSON.stringify(record));
                updatedRecs.push(record);
                if (!current || current.tm < record.tm) {
                    cached.set(record.id, record);
                }
            }
            catch (err) {
                onErrors({ message: `failed to convert record: ${record.id} to JSON` });
            }
        }
    });
    return {
        recs: updatedRecs,
        str: updatedStr.join("\n"),
    };
}
function notEq(c, r) {
    const keys = Object.keys(c);
    if (keys.length !== Object.keys(r).length)
        return true;
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k === "tm")
            continue;
        if (typeof c[k] === "object") {
            if (notEq(c[k], r[k]))
                return true;
        }
        else {
            if (c[k] !== r[k])
                return true;
        }
    }
    return false;
}
async function load(dbfile, onErrors) {
    const recs = await load_(dbfile, onErrors);
    if (!recs)
        return null;
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
                recs: new Map(),
            };
            const rl = (0, node_readline_1.createInterface)((0, node_fs_1.createReadStream)(dbfile));
            rl.on("line", (line) => {
                ctx.linenum++;
                try {
                    const rec = CondorRecSchema.parse(JSON.parse(line));
                    const current = ctx.recs.get(rec.id);
                    if (!current || current.tm < rec.tm) {
                        ctx.recs.set(rec.id, rec);
                    }
                }
                catch (err) {
                    onErrors({
                        message: `failed to get record from line: ${ctx.linenum}`,
                        err,
                        record: line,
                    });
                }
            });
            rl.on("error", (err) => {
                onErrors({
                    message: "error(1231) when reading data for:" + dbfile,
                    err,
                });
                ctx.error = true;
                if (!ctx.closed) {
                    resolve(null);
                }
            });
            rl.on("close", async () => {
                if (ctx.error)
                    return;
                ctx.closed = true;
                CACHE.set(dbfile, ctx.recs);
                resolve(ctx.recs);
            });
        }
        catch (err) {
            onErrors({
                message: "Unexpected error 5327820",
                err,
            });
            resolve(null);
        }
    });
}
async function save(recordArray, dbfile, onErrors) {
    const current = await load_(dbfile, onErrors);
    if (!current) {
        onErrors({
            message: `failed to get existing records from: ${dbfile}`,
        });
        return null;
    }
    const data = updatedRecs(current, recordArray, onErrors);
    if (data.recs.length == 0) {
        onErrors({
            message: `nothing new to save in: ${dbfile}`,
        });
        return unwrap(current);
    }
    await (0, promises_1.appendFile)(dbfile, data.str);
    return unwrap(current);
}
function unwrap(recs) {
    return Array.from(recs.values());
}
