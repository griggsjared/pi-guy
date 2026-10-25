import assert from "node:assert/strict";
import { test } from "node:test";
import { readResponseTextLimited } from "../../src/statusline/http.ts";

test("limits response bodies while streaming", async () => {
	let headerCancelled = false;
	const oversizedHeader = new Response(new ReadableStream({
		start(controller) { controller.enqueue(new Uint8Array([1])); },
		cancel() { headerCancelled = true; },
	}), { headers: { "content-length": "100" } });
	await assert.rejects(readResponseTextLimited(oversizedHeader, 10, "Test"), /too large/);
	assert.equal(headerCancelled, true);

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("123"));
			controller.enqueue(new TextEncoder().encode("456"));
			controller.close();
		},
	});
	await assert.rejects(readResponseTextLimited(new Response(stream), 5, "Test"), /too large/);
});
