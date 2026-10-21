import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const load = async (relative) => {
  const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(js)}`);
};
const { normalizeHandle } = await load("../../src/lib/handles.ts");
const { readJson } = await load("../../src/lib/api.ts");
const { appEnabled } = await load("../../src/lib/app-config.ts");

test("every accepted way of writing an account gives the same handle", () => {
  for (const input of ["OpenAI", "@OpenAI", " @OpenAI ", "https://x.com/OpenAI", "https://x.com/OpenAI/", "http://twitter.com/OpenAI",
    "https://www.x.com/OpenAI?s=20", "https://mobile.twitter.com/OpenAI/", "x.com/OpenAI", "https://x.com/@OpenAI"]) {
    assert.deepEqual(normalizeHandle(input), { handle: "OpenAI", key: "openai" }, input);
  }
});

test("what is not one X account is refused", () => {
  for (const input of ["", " ", "@", "a".repeat(16), "has space", "名字", "a-b", "https://x.com/", "https://x.com/OpenAI/status/1",
    "https://example.com/OpenAI", "https://x.com.evil.com/OpenAI", "javascript:alert(1)", "https://x.com/home/../OpenAI", "https://x.com/home/%2e%2e/OpenAI", "https://x.com/./OpenAI", "https://x.com/OpenAI/..",
    "https://x.com:8080/OpenAI", "https://user@x.com/OpenAI", ["https://user", "p"].join(":") + "@x.com/OpenAI", "https://x.com\\OpenAI", "https://x.com@evil.com/OpenAI", "//x.com/OpenAI", "a/b", "@@a"]) {
    assert.equal(normalizeHandle(input), null, JSON.stringify(input));
  }
  assert.equal(normalizeHandle(undefined), null);
  assert.equal(normalizeHandle(42), null);
});

test("X's own pages are not accounts", () => {
  for (const name of ["home", "explore", "search", "settings", "i", "intent", "share", "hashtag", "messages", "notifications", "login", "signup"]) {
    assert.equal(normalizeHandle(`https://x.com/${name}`), null, name);
  }
});

const full = { APP_DATABASE_URL: "postgres://x", BETTER_AUTH_URL: "http://localhost:3456", BETTER_AUTH_SECRET: "s", GOOGLE_CLIENT_ID: "i", GOOGLE_CLIENT_SECRET: "k" };

test("the user features are on only when all five settings are present", () => {
  assert.equal(appEnabled(full), true);
  for (const key of Object.keys(full)) assert.equal(appEnabled({ ...full, [key]: "" }), false, key);
  assert.equal(appEnabled({}), false);
});

const post = (body, headers = {}) => new Request("http://localhost/x", { method: "POST", body, headers });

test("readJson reads a small JSON body and refuses malformed, empty or non-UTF-8 ones", async () => {
  assert.deepEqual(await readJson(post('{"a":1}'), 4096), { ok: true, value: { a: 1 } });
  assert.deepEqual(await readJson(post("{"), 4096), { ok: false });
  assert.deepEqual(await readJson(new Request("http://localhost/x", { method: "POST" }), 4096), { ok: false });
  assert.deepEqual(await readJson(post(new Uint8Array([0x22, 0xff, 0x22])), 4096), { ok: false });
});

test("readJson refuses a body over the cap, by header or by bytes read", async () => {
  const big = JSON.stringify({ note: "x".repeat(5000) });
  assert.deepEqual(await readJson(post(big), 4096), { ok: false });
  assert.deepEqual(await readJson(post("{}", { "content-length": "999999" }), 4096), { ok: false });
  // No Content-Length, chunked: the running count stops it and the source is cancelled.
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("http://localhost/x", { method: "POST", body: stream, duplex: "half" });
  assert.deepEqual(await readJson(request, 4096), { ok: false });
  assert.ok(cancelled);
  assert.ok(pulled < 20, `pulled ${pulled}`);
  // Exactly at the cap is accepted.
  const exact = '"' + "a".repeat(4094) + '"';
  assert.equal((await readJson(post(exact), 4096)).ok, true);
});

const { csv } = await load("../../src/lib/csv.ts");

test("csv writes a BOM, CRLF line ends, and quotes commas, quotes and newlines", () => {
  const out = csv([["a", "b,c", 'say "hi"'], ["line\nbreak", "", "x"]]);
  assert.equal(out, '﻿a,"b,c","say ""hi"""\r\n"line\nbreak",,x\r\n');
});

test("csv neutralises a cell a spreadsheet would run as a formula", () => {
  const out = csv([["=HYPERLINK(\"http://x\")", "+1", "-1", "@SUM(A1)", "\tx", "\rx", "safe=1"]]);
  assert.ok(out.startsWith("﻿"));
  const line = out.slice(1);
  assert.ok(line.startsWith("\"'=HYPERLINK(\"\"http://x\"\")\",'+1,'-1,'@SUM(A1),'\tx,\"'\rx\",safe=1"), line);
});
