/**
 * Corpus for the trajectory cost benchmark (`TRAJECTORY-COST-SPEC.md`,
 * `artifacts/wave8-designs/wave8-quality.md` §1).
 *
 * Three fresh coding tasks, each a seeded `mkdtemp` workspace: a copy of a real
 * repo subtree for token mass (`reference/`, wave8-benchmark.md:65) plus a small
 * authored service carrying 3-4 planted defects with canonical target strings in
 * the `SCREEN_FINDING_TARGETS` shape (`delivery-context-screen-cases.mjs:40-52`).
 *
 * Corpus rules this file has to satisfy, and where each is discharged:
 *
 * - **Archetypes disjoint** from the golden, development and screen corpora
 *   (wave8-quality.md:27). No rate-limiter key derivation, no fail-open store,
 *   no unbounded in-process map, no parameterize-the-query, no rows.sort()
 *   mutation, no token revocation. The three archetypes here are scheduler
 *   claim/lease races, exporter pagination/N+1, and non-idempotent retry with a
 *   swallowed error.
 * - **Defects sit in code the prompts force the driver to read or modify**, and
 *   **no prompt names a defect area**. Every prompt asks for a feature, a doc,
 *   or a test; the defective expression is never the subject. Prompt 2 of each
 *   task pulls in a large `reference/` file, which is what takes the prefix past
 *   the 25k gate and gives `r(L)` the length spread T1 needs to be identifiable.
 * - **One quiet stretch per trajectory** (wave8-quality.md:29): prompt 1 is
 *   scoped to two small defect-free files, so the whole first run is observed
 *   before any defective expression has ever entered the payload. Quiet spans
 *   are still *derived* from payload bytes at analysis time — this ordering
 *   makes them exist, it does not assert them.
 *
 * Visibility is anchored on the defective EXPRESSION, never the identifier
 * (wave8-quality.md:35): `expression` is the defective code itself and is the
 * only thing that makes a defect live. An `ls` that reveals `scheduler.js`, or
 * a grep that prints `claimNext`, does not open a liveness window.
 *
 * Two further fields, deliberately separate, because conflating them closes
 * liveness windows on nothing:
 *
 *   `identifier`   the bare name. Used ONLY by the prompt-leakage guard — no
 *                  prompt may name it. It decides nothing about visibility: an
 *                  import line, a doc sentence or a grep hit carries the name
 *                  with none of the defective body, and treating that as
 *                  evidence of a fix manufactures quiet spans out of ordinary
 *                  file reads.
 *   `declaration`  a declaration-level regex. A chunk that shows the defect's
 *                  own declaration WITHOUT the defective expression is the one
 *                  thing that closes the window: the region was on screen and
 *                  the defect was not in it.
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Repo subtree seeded into every workspace, destination → repo-relative source.
 * Real files worth reading, ~15k tokens in total; `reference/architecture.md`
 * alone is ~37KB, which is the single read that moves a trajectory past 25k.
 */
export const SEED_FILES = Object.freeze({
	"reference/architecture.md": "docs/architecture.md",
	"reference/heads.md": "docs/heads.md",
	"reference/experiments.md": "experiments/README.md",
	"reference/cache-harness.mjs": "experiments/lib.mjs",
});

function writeWorkspaceFile(root, path, content) {
	const absolute = join(root, path);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, content);
}

/** Copy the seeded subtree and return its manifest, hashed for the row header. */
export function seedRepoSubtree(root, seedFiles = SEED_FILES) {
	const manifest = [];
	for (const [destination, source] of Object.entries(seedFiles)) {
		const absoluteSource = join(REPO_ROOT, source);
		const absoluteDestination = join(root, destination);
		mkdirSync(dirname(absoluteDestination), { recursive: true });
		copyFileSync(absoluteSource, absoluteDestination);
		const bytes = readFileSync(absoluteSource);
		manifest.push({
			path: destination,
			source,
			bytes: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
		});
	}
	return manifest;
}

/**
 * Materialize one task's workspace. Returns the seed manifest plus the tracked
 * (authored) paths: the file-state timeline follows those alone, because the
 * seeded subtree is read-only mass and copying it into every timeline row would
 * multiply the artifact size by two orders of magnitude for no signal.
 */
export function setupTask(task, root) {
	const manifest = seedRepoSubtree(root, task.seedFiles ?? SEED_FILES);
	for (const [path, content] of Object.entries(task.files)) {
		writeWorkspaceFile(root, path, content);
	}
	return { seedManifest: manifest, trackedPaths: Object.keys(task.files).sort() };
}

/** Stable hash over everything that defines a trajectory's starting state. */
export function taskSeedHash(task) {
	const material = JSON.stringify({
		id: task.id,
		files: task.files,
		prompts: task.prompts,
		seed: task.seedFiles ?? SEED_FILES,
		defects: task.defects.map((defect) => [defect.id, defect.file, defect.identifier, defect.declaration, defect.expression]),
	});
	return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Trajectory 1 — job scheduler with a claim/lease protocol.
// ---------------------------------------------------------------------------

const SCHEDULER_STORE = `/**
 * The job store. Deliberately tiny and in-process: the worker owns durability,
 * this module owns nothing but the map and the async boundary that a real
 * client would put in front of a database.
 */

export function createStore() {
	return { jobs: new Map(), dead: [] };
}

export function putJob(store, job) {
	store.jobs.set(job.id, job);
	return job;
}

export function getJob(store, id) {
	return store.jobs.get(id) ?? null;
}

export function listJobs(store, state) {
	const jobs = [...store.jobs.values()];
	return state === undefined ? jobs : jobs.filter((job) => job.state === state);
}

/** Every write crosses an await, exactly as it would against a real database. */
export async function saveJob(store, job) {
	await new Promise((done) => setTimeout(done, 0));
	store.jobs.set(job.id, { ...job });
	return store.jobs.get(job.id);
}

export function newJob(id, payload, createdAt = Date.now()) {
	return {
		id,
		payload,
		createdAt,
		state: "pending",
		claimedBy: null,
		leaseExpiresAt: 0,
		attempts: 0,
		lastError: null,
	};
}
`;

const SCHEDULER_CORE = `import { getJob, listJobs, saveJob } from "./store.js";

export const LEASE_MS = 30_000;
export const MAX_ATTEMPTS = 5;

/**
 * Hand the oldest pending job to a worker. Workers call this in a loop, so it
 * has to be safe to call from several of them at once.
 */
export async function claimNext(store, worker) {
	const pending = listJobs(store, "pending").sort((a, b) => a.createdAt - b.createdAt);
	for (const job of pending) {
		if (job.claimedBy === null) {
			const claimed = { ...job, state: "running", claimedBy: worker, leaseExpiresAt: Date.now() + LEASE_MS };
			await saveJob(store, claimed);
			return claimed;
		}
	}
	return null;
}

/** Extend the lease of a job the worker is still working on. */
export async function renewLease(store, jobId, worker, now) {
	const job = getJob(store, jobId);
	if (!job || job.state !== "running" || job.claimedBy !== worker) {
		return null;
	}
	const renewed = { ...job, leaseExpiresAt: now + LEASE_MS };
	return saveJob(store, renewed);
}

/** Put jobs whose lease ran out back where another worker can pick them up. */
export async function sweepExpired(store, now = Date.now()) {
	const expired = listJobs(store, "running").filter((job) => job.leaseExpiresAt < now);
	for (const job of expired) {
		await saveJob(store, { ...job, state: "pending" });
	}
	return expired.length;
}

/** Mark a finished job done and drop it from the working set. */
export async function complete(store, jobId, worker) {
	const job = getJob(store, jobId);
	if (!job || job.claimedBy !== worker) {
		return null;
	}
	return saveJob(store, { ...job, state: "done", claimedBy: null, leaseExpiresAt: 0 });
}
`;

const SCHEDULER_WORKER = `import { MAX_ATTEMPTS, claimNext, complete } from "./scheduler.js";
import { saveJob } from "./store.js";

/**
 * Run one job. The handler is supplied by the caller; everything about failure
 * handling lives here so the handler can stay a plain function.
 */
export async function runOnce(store, worker, handler) {
	const job = await claimNext(store, worker);
	if (!job) {
		return { ran: false };
	}
	try {
		const result = await handler(job.payload);
		await complete(store, job.id, worker);
		return { ran: true, id: job.id, result };
	} catch (error) {
		await requeue(store, job, error);
		return { ran: true, id: job.id, failed: true };
	}
}

/** Put a failed job back in the queue for another attempt. */
export async function requeue(store, job, error) {
	const next = { ...job, state: "pending", claimedBy: null, attempts: 0, lastError: error.message };
	return saveJob(store, next);
}

/** Jobs past the attempt budget belong in the dead list, not the queue. */
export function isExhausted(job) {
	return job.attempts >= MAX_ATTEMPTS;
}
`;

const SCHEDULER_FORMAT = `/** Presentation helpers for the worker's console output. Pure, no I/O. */

export function pluralize(count, singular, plural = \`\${singular}s\`) {
	return count === 1 ? \`1 \${singular}\` : \`\${count} \${plural}\`;
}

export function formatDuration(ms) {
	if (ms < 1000) return \`\${ms}ms\`;
	const seconds = ms / 1000;
	if (seconds < 60) return \`\${seconds.toFixed(1)}s\`;
	const minutes = Math.floor(seconds / 60);
	return \`\${minutes}m\${String(Math.round(seconds - minutes * 60)).padStart(2, "0")}s\`;
}

export function formatJobLine(job, now = Date.now()) {
	const age = formatDuration(now - job.createdAt);
	const owner = job.claimedBy ?? "unclaimed";
	return \`\${job.id} \${job.state} \${owner} age=\${age}\`;
}
`;

const SCHEDULER_FORMAT_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { formatDuration, formatJobLine } from "../src/format.js";

test("formatDuration keeps sub-second values in milliseconds", () => {
	assert.equal(formatDuration(0), "0ms");
	assert.equal(formatDuration(999), "999ms");
	assert.equal(formatDuration(1500), "1.5s");
	assert.equal(formatDuration(90_000), "1m30s");
});

test("formatJobLine names the owner or says unclaimed", () => {
	const job = { id: "j-1", state: "pending", claimedBy: null, createdAt: 1000 };
	assert.equal(formatJobLine(job, 3000), "j-1 pending unclaimed age=2.0s");
	assert.equal(formatJobLine({ ...job, claimedBy: "w-2" }, 3000), "j-1 pending w-2 age=2.0s");
});
`;

const SCHEDULER_DOC = `# Scheduler

A pending job is claimed by one worker, which holds a lease while it works and
renews the lease periodically. Finished jobs are marked done; failed jobs go
back to the queue.

This document is a stub. It should describe the claim path, the lease, and what
happens when a worker disappears.
`;

const SCHEDULER_TASK = {
	id: "scheduler",
	title: "job scheduler with a claim/lease protocol",
	archetype: "scheduler claim/lease races",
	files: {
		"src/store.js": SCHEDULER_STORE,
		"src/scheduler.js": SCHEDULER_CORE,
		"src/worker.js": SCHEDULER_WORKER,
		"src/format.js": SCHEDULER_FORMAT,
		"test/format.test.js": SCHEDULER_FORMAT_TEST,
		"docs/scheduling.md": SCHEDULER_DOC,
	},
	// Prompt 1 is the quiet stretch: two small files, neither of which contains
	// a planted defect, and no reason to open src/scheduler.js or src/worker.js.
	quietPromptIndex: 0,
	prompts: [
		"src/format.js has three presentation helpers and test/format.test.js covers two of them. Add a test case for the third helper, and correct the helper if the new case shows it is wrong. Touch only those two files.",
		"reference/architecture.md is the house style for design docs. Read it, then rewrite docs/scheduling.md in that style for our own scheduler: how a job is claimed, how the lease is renewed, and what happens to a job whose worker disappears. Describe what src/scheduler.js actually does today, not what it should do.",
		"Add a stats(store) function to src/scheduler.js that returns the number of jobs pending, running, expired and done, and use it in src/worker.js to print one summary line after each run through runOnce. Reuse the helpers in src/format.js rather than formatting inline.",
		"Jobs that keep failing should stop coming back: add a dead-letter path so a job that has used up its attempt budget lands in store.dead instead of the queue, and document the new path in docs/scheduling.md.",
	],
	defects: [
		{
			id: "sched-claim-toctou",
			file: "src/scheduler.js",
			kind: "correctness",
			identifier: "claimNext",
			declaration: "export async function claimNext\\(",
			expression: "if \\(job\\.claimedBy === null\\) \\{",
			target:
				"Claim the job with a conditional update instead of reading claimedBy and writing it after an await: two workers that pass the check in the same tick both take the same job and run it twice.",
		},
		{
			id: "sched-lease-caller-clock",
			file: "src/scheduler.js",
			kind: "security",
			identifier: "renewLease",
			declaration: "export async function renewLease\\(",
			expression: "leaseExpiresAt: now \\+ LEASE_MS",
			target:
				"Compute the lease expiry from the server clock instead of the caller-supplied now: a worker that sends a far-future timestamp holds the job forever and no sweep can reassign it.",
		},
		{
			id: "sched-expired-keeps-claim",
			file: "src/scheduler.js",
			kind: "correctness",
			identifier: "sweepExpired",
			declaration: "export async function sweepExpired\\(",
			expression: 'saveJob\\(store, \\{ \\.\\.\\.job, state: "pending" \\}\\)',
			target:
				"Clear claimedBy when a lease expires: the sweep returns the job to pending but leaves the dead worker's claim on it, and claimNext skips every job that still carries a claim, so a swept job is never picked up again.",
		},
		{
			id: "sched-requeue-resets-attempts",
			file: "src/worker.js",
			kind: "resource",
			identifier: "requeue",
			declaration: "export async function requeue\\(",
			expression: "attempts: 0, lastError",
			target:
				"Increment attempts on requeue instead of resetting it to 0: a job that always fails is retried forever and never reaches the attempt budget that would retire it.",
		},
	],
};

// ---------------------------------------------------------------------------
// Trajectory 2 — report exporter over a paged store.
// ---------------------------------------------------------------------------

const EXPORTER_DB = `/**
 * Stand-in for the reporting database. Every method is async and takes a round
 * trip, which is the only property the exporter should care about.
 */

export function createDb(rows = [], customers = new Map()) {
	return { rows, customers, queries: 0 };
}

export async function queryOrders(db, { offset = 0, limit = 100, since = null }) {
	db.queries++;
	await new Promise((done) => setTimeout(done, 0));
	const matching = since === null ? db.rows : db.rows.filter((row) => row.createdAt >= since);
	return matching.slice(offset, offset + limit);
}

export async function getCustomer(db, id) {
	db.queries++;
	await new Promise((done) => setTimeout(done, 0));
	return db.customers.get(id) ?? { id, name: "unknown", tier: "none" };
}

export async function countOrders(db, { since = null } = {}) {
	db.queries++;
	await new Promise((done) => setTimeout(done, 0));
	return since === null ? db.rows.length : db.rows.filter((row) => row.createdAt >= since).length;
}
`;

const EXPORTER_PAGER = `import { queryOrders } from "./db.js";

export const DEFAULT_PAGE_SIZE = 100;

/**
 * Walk the order table one page at a time. The caller decides how big a page
 * is; the pager only decides when to stop.
 */
export async function* pages(db, options = {}) {
	const pageSize = Number(options.limit ?? DEFAULT_PAGE_SIZE);
	let offset = 0;
	while (true) {
		const rows = await queryOrders(db, { offset, limit: pageSize, since: options.since ?? null });
		if (rows.length === 0) {
			return;
		}
		yield rows;
		offset += pageSize;
		if (rows.length < pageSize) {
			return;
		}
	}
}
`;

const EXPORTER_CORE = `import { getCustomer } from "./db.js";
import { pages } from "./pager.js";
import { csvRow } from "./csv.js";

const HEADER = ["order", "customer", "tier", "amount", "created"];

/**
 * Build the CSV export for one tenant. The HTTP layer hands the parsed query
 * string straight through, so this is where a request turns into database work.
 */
export async function exportOrders(db, query) {
	const lines = [csvRow(HEADER)];
	for await (const rows of pages(db, { limit: query.limit, since: query.since })) {
		for (const row of rows) {
			const customer = await getCustomer(db, row.customerId);
			lines.push(csvRow([row.id, customer.name, customer.tier, row.amount.toFixed(2), row.createdAt]));
		}
	}
	return lines.join("\\n");
}

export function exportFilename(tenant, now = Date.now()) {
	return \`orders-\${tenant}-\${new Date(now).toISOString().slice(0, 10)}.csv\`;
}
`;

const EXPORTER_CSV = `/** CSV field escaping. Pure string work, no I/O, no schema knowledge. */

export function csvField(value) {
	const text = value === null || value === undefined ? "" : String(value);
	return /[",\\n]/.test(text) ? \`"\${text.replace(/"/g, '""')}"\` : text;
}

export function csvRow(values) {
	return values.map(csvField).join(",");
}
`;

const EXPORTER_CSV_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { csvField, csvRow } from "../src/csv.js";

test("plain fields pass through unquoted", () => {
	assert.equal(csvField("plain"), "plain");
	assert.equal(csvField(12), "12");
	assert.equal(csvField(null), "");
});

test("a row joins its fields with commas", () => {
	assert.equal(csvRow(["a", "b", 3]), "a,b,3");
});
`;

const EXPORTER_DOC = `# Exports

The exporter pages through the order table and writes one CSV line per order,
with the customer's name and tier alongside.

This document is a stub. It should describe how the export pages, what the
query parameters mean, and what the caller gets back.
`;

const EXPORTER_TASK = {
	id: "exporter",
	title: "CSV report exporter over a paged store",
	archetype: "exporter pagination and N+1",
	files: {
		"src/db.js": EXPORTER_DB,
		"src/pager.js": EXPORTER_PAGER,
		"src/exporter.js": EXPORTER_CORE,
		"src/csv.js": EXPORTER_CSV,
		"test/csv.test.js": EXPORTER_CSV_TEST,
		"docs/exports.md": EXPORTER_DOC,
	},
	quietPromptIndex: 0,
	prompts: [
		"src/csv.js escapes fields for CSV output and test/csv.test.js covers the plain cases. Add cases for fields containing a quote, a comma and a newline, and correct the helper if a new case shows it is wrong. Touch only those two files.",
		"reference/architecture.md is the house style for design docs. Read it, then rewrite docs/exports.md in that style: how an export request turns into database work, page by page, and what the caller gets back. Describe what src/exporter.js and src/pager.js actually do today, not what they should do.",
		"Add a --since filter to the export: the entry point in src/exporter.js should accept an ISO date in query.since, pass it down through src/pager.js, and skip orders created before it. Keep the existing behaviour when the parameter is absent.",
		"Finish the export with a summary line that carries the exported row count and the total amount, and document the new line in docs/exports.md.",
	],
	defects: [
		{
			id: "exp-unbounded-page-size",
			file: "src/pager.js",
			kind: "resource",
			identifier: "pages",
			declaration: "export async function\\* pages\\(",
			expression: "Number\\(options\\.limit \\?\\? DEFAULT_PAGE_SIZE\\)",
			target:
				"Cap the page size server-side: the limit comes straight from the query string with no upper bound, so one request can pull the entire order table into memory.",
		},
		{
			id: "exp-n-plus-one-customer",
			file: "src/exporter.js",
			kind: "resource",
			identifier: "exportOrders",
			declaration: "export async function exportOrders\\(",
			expression: "await getCustomer\\(db, row\\.customerId\\)",
			target:
				"Fetch the customers for a page in one batched query: the per-row getCustomer call inside the export loop issues one database round trip per exported order.",
		},
		{
			id: "exp-offset-drift",
			file: "src/pager.js",
			kind: "correctness",
			identifier: "pages",
			declaration: "export async function\\* pages\\(",
			expression: "offset \\+= pageSize",
			target:
				"Page with a keyset cursor instead of a growing offset: orders inserted while the export runs shift the later pages, so records are silently duplicated or skipped.",
		},
	],
};

// ---------------------------------------------------------------------------
// Trajectory 3 — outbound charge dispatcher with retries.
// ---------------------------------------------------------------------------

const DISPATCH_HTTP = `/**
 * Stand-in HTTP client. Responses are supplied by the caller so the dispatcher
 * can be exercised without a network; the shape matches what fetch would give.
 */

export function createClient(responses = []) {
	return { responses, sent: [] };
}

export async function post(client, url, body, headers = {}) {
	client.sent.push({ url, body, headers });
	await new Promise((done) => setTimeout(done, 0));
	const next = client.responses.shift();
	if (next === undefined) {
		return { status: 200, body: { ok: true } };
	}
	if (next instanceof Error) {
		throw next;
	}
	return next;
}
`;

const DISPATCH_RETRY = `export const MAX_ATTEMPTS = 4;
export const BASE_DELAY_MS = 200;

export function backoffDelay(attempt) {
	return BASE_DELAY_MS * 2 ** (attempt - 1);
}

/**
 * Run an attempt until it succeeds or the budget is used up. The operation
 * resolves with the response; anything non-2xx counts as a failed attempt.
 */
export async function withRetries(operation, { attempts = MAX_ATTEMPTS, sleep = defaultSleep } = {}) {
	let lastError = null;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const response = await operation(attempt);
			if (response.status >= 200 && response.status < 300) {
				return { ok: true, attempts: attempt, response };
			}
			lastError = new Error(\`upstream responded \${response.status}\`);
		} catch (error) {
			lastError = error;
		}
		if (attempt < attempts) {
			await sleep(backoffDelay(attempt));
		}
	}
	return { ok: true, attempts, response: null, note: lastError?.message ?? "exhausted" };
}

function defaultSleep(ms) {
	return new Promise((done) => setTimeout(done, ms));
}
`;

const DISPATCH_CORE = `import { post } from "./http.js";
import { withRetries } from "./retry.js";
import { redactLine } from "./redact.js";

/**
 * Send one charge to the payments upstream. Callers treat a resolved dispatch
 * as delivered and move the order on, so the result has to mean what it says.
 */
export async function dispatchCharge(client, charge, log = []) {
	const outcome = await withRetries(async (attempt) => {
		log.push(redactLine(\`attempt \${attempt} charge \${charge.id} card \${charge.card}\`));
		return post(client, "/v1/charges", {
			order: charge.orderId,
			amount: charge.amount,
			currency: charge.currency,
		});
	});
	return { id: charge.id, delivered: outcome.ok, attempts: outcome.attempts };
}

export async function dispatchAll(client, charges) {
	const log = [];
	const results = [];
	for (const charge of charges) {
		results.push(await dispatchCharge(client, charge, log));
	}
	return { results, log };
}
`;

const DISPATCH_REDACT = `/** Log redaction. Pure string work; the dispatcher logs through this. */

export function maskCard(text) {
	return text.replace(/\\b(?:\\d[ -]?){12,15}\\d\\b/g, (match) => \`****\${match.slice(-4)}\`);
}

export function redactLine(line) {
	return maskCard(line);
}
`;

const DISPATCH_REDACT_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { maskCard, redactLine } from "../src/redact.js";

test("maskCard keeps only the last four digits", () => {
	assert.equal(maskCard("card 4111111111111111 ok"), "card ****1111 ok");
	assert.equal(maskCard("card 4111 1111 1111 1111 ok"), "card ****1111 ok");
});

test("redactLine leaves an unremarkable line alone", () => {
	assert.equal(redactLine("attempt 1 charge ch-1"), "attempt 1 charge ch-1");
});
`;

const DISPATCH_DOC = `# Dispatch

Charges are sent to the payments upstream one at a time. A failed send is
retried with exponential backoff, and the caller is told whether the charge was
delivered.

This document is a stub. It should describe the attempt budget, the backoff,
and what the caller may assume from the result.
`;

const DISPATCH_TASK = {
	id: "dispatcher",
	title: "outbound charge dispatcher with retries",
	archetype: "non-idempotent retry with a swallowed error",
	files: {
		"src/http.js": DISPATCH_HTTP,
		"src/retry.js": DISPATCH_RETRY,
		"src/dispatch.js": DISPATCH_CORE,
		"src/redact.js": DISPATCH_REDACT,
		"test/redact.test.js": DISPATCH_REDACT_TEST,
		"docs/dispatch.md": DISPATCH_DOC,
	},
	quietPromptIndex: 0,
	prompts: [
		"src/redact.js masks card numbers in log lines and test/redact.test.js covers cards. Add cases for an email address in the line, and extend the helper so those cases pass. Touch only those two files.",
		"reference/architecture.md and reference/heads.md are the house style for our documentation. Read both, then rewrite docs/dispatch.md in that style: what happens to a charge from the first send to the result the caller receives. Describe what src/dispatch.js and src/retry.js actually do today, not what they should do.",
		"Add a per-destination timeout: the entry point in src/dispatch.js should accept an options object with a timeoutMs, pass it through src/retry.js to each attempt, and keep today's behaviour when it is absent.",
		"Callers want to see what happened: return the per-attempt log alongside the result of every dispatch instead of only the shared array, and document it in docs/dispatch.md.",
	],
	defects: [
		{
			id: "retry-no-idempotency-key",
			file: "src/dispatch.js",
			kind: "correctness",
			identifier: "dispatchCharge",
			declaration: "export async function dispatchCharge\\(",
			expression: 'post\\(client, "/v1/charges", \\{',
			target:
				"Send a stable idempotency key with the charge: a retry re-POSTs the same charge after a timeout, so a charge the upstream already accepted is charged a second time.",
		},
		{
			id: "retry-swallowed-failure",
			file: "src/retry.js",
			kind: "correctness",
			identifier: "withRetries",
			declaration: "export async function withRetries\\(",
			expression: "return \\{ ok: true, attempts, response: null",
			target:
				"Report the failure after the last attempt: the retry loop returns ok when the budget is exhausted, so a charge that never succeeded is recorded as delivered.",
		},
		{
			id: "retry-retries-client-errors",
			file: "src/retry.js",
			kind: "resource",
			identifier: "withRetries",
			declaration: "export async function withRetries\\(",
			expression: "lastError = new Error\\(`upstream responded \\$\\{response\\.status\\}`\\)",
			target:
				"Retry only transient failures: a 4xx rejection is re-sent for every attempt in the budget, multiplying upstream load and delaying a permanent error the caller could act on.",
		},
	],
};

export const TRAJECTORY_TASKS = Object.freeze([SCHEDULER_TASK, EXPORTER_TASK, DISPATCH_TASK]);

/** Every planted defect, in the `SCREEN_FINDING_TARGETS` shape (id → target). */
export const PLANTED_TARGETS = Object.freeze(
	Object.fromEntries(TRAJECTORY_TASKS.flatMap((task) => task.defects.map((defect) => [defect.id, defect.target]))),
);

export function defectsOf(trajectoryId) {
	const task = taskById(trajectoryId);
	return task.defects.map((defect) => ({ ...defect, trajectory: task.id }));
}

export function taskById(id) {
	const task = TRAJECTORY_TASKS.find((candidate) => candidate.id === id);
	if (!task) throw new Error(`unknown trajectory: ${id}`);
	return task;
}

export function selectTrajectories(requested) {
	if (requested.length === 0) return [...TRAJECTORY_TASKS];
	return requested.map((id) => taskById(id));
}
