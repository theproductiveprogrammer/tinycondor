import { z } from "zod";
import { open, close, write, createReadStream } from "node:fs";
import { appendFile, open as openAsync } from "node:fs/promises";
import { createInterface } from "node:readline";

const CACHE: Map<string, Map<string, CondorRec>> = new Map();

export const CondorRecSchema = z
	.object({
		id: z.string(),
		tm: z.number(),
	})
	.catchall(z.any());
export type CondorRec = z.infer<typeof CondorRecSchema>;

export const CondorErrSchema = z.object({
	message: z.string(),
	code: z.string().optional(),
	record: z.any().optional(),
	err: z.any().optional(),
});
export type CondorErr = z.infer<typeof CondorErrSchema>;

export type CondorErrHandler = (err: CondorErr) => void;

export function clearCache() {
	CACHE.clear();
}

export async function create(
	initialRecords: CondorRec[],
	dbfile: string,
	onErrors: CondorErrHandler
): Promise<CondorRec[] | null> {
	return new Promise((resolve) => {
		open(dbfile, "wx", (err, fd) => {
			if (err) {
				if (err.code === "EEXIST") {
					onErrors({
						code: "EEXIST",
						message: `${dbfile} already exists - cannot create!`,
					});
				} else {
					onErrors(err);
				}
				return resolve(null);
			}
			const cached = new Map<string, CondorRec>();
			CACHE.set(dbfile, cached);
			const data = updatedRecs(cached, initialRecords, onErrors);
			if (data.recs.length == 0) {
				onErrors({
					message: `failed to find any valid records to initialize file: ${dbfile}`,
				});
				return resolve(null);
			}
			write(fd, data.str, null, "utf8", (err) => {
				close(fd);
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

type UpdatedRecs = {
	recs: CondorRec[];
	str: string;
};

/*		way/
 * check that the record is valid (has an id), ensure a timestamp,
 * then check if it is not already an existing record.
 */
function updatedRecs(
	cached: Map<string, CondorRec>,
	recs: CondorRec[],
	onErrors: CondorErrHandler
): UpdatedRecs {
	const updatedRecs: CondorRec[] = [];
	const updatedStr: string[] = [];
	recs.forEach((record) => {
		if (!record.id) {
			onErrors({
				message: `record missing id`,
				record,
			});
			return;
		}
		if (!record.tm) record.tm = Date.now();
		const current = cached.get(record.id);
		if (
			!current ||
			current.tm < record.tm ||
			(current.tm === record.tm && notEq(current, record))
		) {
			try {
				updatedStr.push(JSON.stringify(record));
				updatedRecs.push(record);
				cached.set(record.id, record);
			} catch (err) {
				onErrors({ message: `failed to convert record: ${record.id} to JSON` });
			}
		}
	});
	return {
		recs: updatedRecs,
		str: updatedStr.join("\n"),
	};
}

function notEq(c: any, r: any): boolean {
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

export async function load(
	dbfile: string,
	onErrors: CondorErrHandler
): Promise<CondorRec[] | null> {
	const recs = await load_(dbfile, onErrors);
	if (!recs) return null;
	return unwrap(recs);
}

interface Ctx {
	closed: boolean;
	error: boolean;
	linenum: number;
	recs: Map<string, CondorRec>;
}
export async function load_(
	dbfile: string,
	onErrors: CondorErrHandler
): Promise<Map<string, CondorRec> | null> {
	return new Promise((resolve) => {
		const loaded = CACHE.get(dbfile);
		if (loaded) {
			resolve(loaded);
			return;
		}

		try {
			const ctx: Ctx = {
				closed: false,
				error: false,
				linenum: 0,
				recs: new Map<string, CondorRec>(),
			};

			const rl = createInterface(createReadStream(dbfile));
			rl.on("line", (line) => {
				ctx.linenum++;
				try {
					const rec = CondorRecSchema.parse(JSON.parse(line));
					const current = ctx.recs.get(rec.id);
					if (
						!current ||
						current.tm < rec.tm ||
						(current.tm === rec.tm && notEq(current, rec))
					) {
						ctx.recs.set(rec.id, rec);
					}
				} catch (err) {
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
				if (ctx.error) return;
				ctx.closed = true;
				CACHE.set(dbfile, ctx.recs);
				resolve(ctx.recs);
			});
		} catch (err) {
			onErrors({
				message: "Unexpected error 5327820",
				err,
			});
			resolve(null);
		}
	});
}

export async function save(
	recordArray: CondorRec[],
	dbfile: string,
	onErrors: CondorErrHandler
): Promise<CondorRec[] | null> {
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
	const needsNewline = await fileEndsWithNewline(dbfile, onErrors);
	const toAppend = (needsNewline ? "" : "\n") + data.str + "\n";
	await appendFile(dbfile, toAppend);
	return unwrap(current);
}

function unwrap(recs: Map<string, CondorRec>): CondorRec[] {
	return Array.from(recs.values());
}

async function fileEndsWithNewline(
	path: string,
	onErrors: CondorErrHandler
): Promise<boolean> {
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
	} catch (err: any) {
		onErrors({
			message: `Failed checking fileEndsWithNewline` + err.message,
		});
		return true;
	}
}
