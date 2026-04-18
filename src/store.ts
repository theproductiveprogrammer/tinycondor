import { createHash } from "node:crypto";
import {
	mkdir,
	readFile,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import type { CondorErrHandler } from "./db";

// Git-style fanout: first 2 hex chars become a subdirectory so no
// single directory grows unbounded as the store fills up.
function blobPath(storeDir: string, hash: string): string {
	return join(storeDir, hash.slice(0, 2), hash.slice(2));
}

// Hash must be exactly 64 lowercase hex chars (sha256 output). This
// guards against path traversal via malicious hash strings — callers
// could otherwise smuggle "../" segments into blobPath().
function isValidHash(h: string): boolean {
	return typeof h === "string" && /^[0-9a-f]{64}$/.test(h);
}

// The problem is records need to reference large or binary payloads
// without embedding them inline in the append-only log.
// The way we solve this is by hashing bytes with sha256 and writing
// them to a content-addressed path. Same bytes always produce the
// same path, so repeat writes are no-ops (dedup) and concurrent
// writes race harmlessly on an atomic rename.
// flow: user code -> putBlob() <-- HERE
export async function putBlob(
	data: string | Buffer,
	storeDir: string,
	onErrors: CondorErrHandler
): Promise<string | null> {
	try {
		const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
		const hash = createHash("sha256").update(buf).digest("hex");
		const final = blobPath(storeDir, hash);

		// Dedup: if the blob is already present, skip the write entirely.
		try {
			await stat(final);
			return hash;
		} catch (err: any) {
			if (err.code !== "ENOENT") {
				onErrors({
					code: err.code,
					message: `putBlob/stat: ${err.message}`,
					err,
				});
				return null;
			}
		}

		const dir = join(storeDir, hash.slice(0, 2));
		await mkdir(dir, { recursive: true });

		// Write to a pid/time-scoped tmp file and rename into place so a
		// crash mid-write cannot leave a partial blob at the final path.
		const tmp = `${final}.tmp-${process.pid}-${Date.now()}`;
		try {
			await writeFile(tmp, buf);
			await rename(tmp, final);
		} catch (err: any) {
			try {
				await unlink(tmp);
			} catch {
				// ignore cleanup errors
			}
			onErrors({
				code: err.code,
				message: `putBlob/write: ${err.message}`,
				err,
			});
			return null;
		}

		return hash;
	} catch (err: any) {
		onErrors({
			code: err.code,
			message: `putBlob: ${err.message || String(err)}`,
			err,
		});
		return null;
	}
}

// The problem is callers holding a blob hash need the bytes back.
// The way we solve this is by reading directly from the content-
// addressed path after validating the hash shape.
// flow: user code -> getBlob() <-- HERE
export async function getBlob(
	hash: string,
	storeDir: string,
	onErrors: CondorErrHandler
): Promise<Buffer | null> {
	if (!isValidHash(hash)) {
		onErrors({
			code: "INVALID_HASH",
			message: `getBlob: invalid hash '${hash}'`,
		});
		return null;
	}
	try {
		return await readFile(blobPath(storeDir, hash));
	} catch (err: any) {
		onErrors({
			code: err.code,
			message: `getBlob: ${err.message}`,
			err,
		});
		return null;
	}
}

// Cheap existence probe. Returns false on any error including bad
// hash — callers use this to branch, not to surface failures.
// flow: user code -> hasBlob() <-- HERE
export async function hasBlob(
	hash: string,
	storeDir: string
): Promise<boolean> {
	if (!isValidHash(hash)) return false;
	try {
		await stat(blobPath(storeDir, hash));
		return true;
	} catch {
		return false;
	}
}
