import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration, formatTokens } from "../../src/lib/format.ts";

test("formatTokens shortens counts to k and m and drops a trailing .0", () => {
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1000), "1k");
	assert.equal(formatTokens(1250), "1.3k");
	assert.equal(formatTokens(45300), "45.3k");
	assert.equal(formatTokens(200000), "200k");
	assert.equal(formatTokens(999949), "999.9k");
	assert.equal(formatTokens(999950), "1m");
	assert.equal(formatTokens(1234567), "1.2m");
});

test("formatTokens rounds to the requested number of decimals", () => {
	assert.equal(formatTokens(1150), "1.2k");
	assert.equal(formatTokens(10350), "10.4k");
	assert.equal(formatTokens(1150000), "1.2m");
	assert.equal(formatTokens(45300, 0), "45k");
	assert.equal(formatTokens(999500, 0), "1m");
	assert.equal(formatTokens(1567890, 0), "2m");
	assert.equal(formatTokens(1234567, 2), "1.23m");
});

test("formatDuration uses whole seconds and compact minutes", () => {
	assert.equal(formatDuration(0), "0s");
	assert.equal(formatDuration(1999), "1s");
	assert.equal(formatDuration(59999), "59s");
	assert.equal(formatDuration(60000), "1m0s");
	assert.equal(formatDuration(92000), "1m32s");
});
