import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { text as streamToString } from "node:stream/consumers";
import { transform, transformStream, hasErrors } from "../dist/index.js";

const bigStylesheet = `<?xml version="1.0"?>
<xsl:stylesheet version="3.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:template match="/">
    <items><xsl:for-each select="1 to 5000"><item n="{.}">日本語テキスト-émoji-🎉-<xsl:value-of select="."/></item></xsl:for-each></items>
  </xsl:template>
</xsl:stylesheet>`;

test("transformStream: byte-identical to the buffered transform() for a large multi-byte document", async () => {
  const { output, result } = transformStream({
    stylesheet: bigStylesheet,
    source: "<root/>",
  });

  let chunkCount = 0;
  const parts = [];
  for await (const chunk of output) {
    chunkCount++;
    assert.ok(Buffer.isBuffer(chunk));
    parts.push(chunk);
  }
  const meta = await result;
  const streamed = Buffer.concat(parts).toString("utf8");

  assert.equal(hasErrors(meta), false);
  assert.equal(meta.output, undefined);
  assert.equal(meta.method, "xml");
  assert.ok(chunkCount > 1, "expected the large document to arrive in more than one chunk");

  const buffered = await transform({ stylesheet: bigStylesheet, source: "<root/>" });
  assert.equal(streamed, buffered.output);
});

test("transformStream: small output still round-trips via output + result", async () => {
  const { output, result } = transformStream({
    stylesheet: `<?xml version="1.0"?>
<xsl:stylesheet version="3.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:template match="/"><ok><xsl:value-of select="1 + 2"/></ok></xsl:template>
</xsl:stylesheet>`,
    source: "<root/>",
  });
  const text = await streamToString(output);
  const meta = await result;
  assert.equal(hasErrors(meta), false);
  assert.match(text, /<ok>3<\/ok>/);
});

test("transformStream: backpressure — a slow consumer pauses production", async () => {
  const { output, result } = transformStream({
    stylesheet: bigStylesheet,
    source: "<root/>",
  });

  let received = 0;
  output.on("data", () => {
    received++;
  });
  // Pause immediately: nothing should error, and result should only settle
  // once we resume and drain everything.
  output.pause();
  await new Promise((resolve) => setTimeout(resolve, 50));
  output.resume();

  const meta = await result;
  assert.equal(hasErrors(meta), false);
  assert.ok(received > 0);
});

test("transformStream: compile error surfaces as a diagnostic on result, not a throw or stream error", async () => {
  const { output, result } = transformStream({
    stylesheet: "<not-a-stylesheet/>",
    source: "<root/>",
  });
  const chunks = [];
  for await (const chunk of output) chunks.push(chunk);
  const meta = await result;
  assert.equal(hasErrors(meta), true);
  assert.ok(meta.diagnostics.length > 0);
  assert.equal(Buffer.concat(chunks).length, 0);
});

test("transformStream: document() resolves against baseDir via the real filesystem", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "node-xslt-stream-"));
  fs.writeFileSync(path.join(dir, "other.xml"), "<r><v>42</v></r>");
  const { output, result } = transformStream({
    stylesheet: `<?xml version="1.0"?>
<xsl:stylesheet version="3.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:template match="/"><out><xsl:value-of select="document('other.xml')/r/v"/></out></xsl:template>
</xsl:stylesheet>`,
    source: "<root/>",
    baseDir: dir,
  });
  const text = await streamToString(output);
  const meta = await result;
  assert.equal(hasErrors(meta), false);
  assert.match(text, /42/);
});

test("transformStream: destroying output early surfaces as a run diagnostic, not a hang", async () => {
  const { output, result } = transformStream({
    stylesheet: bigStylesheet,
    source: "<root/>",
  });
  output.pause();
  // Wait for at least one chunk to have been pushed (and backpressure to
  // engage), then abort without ever resuming.
  await new Promise((resolve) => output.once("readable", resolve));
  output.destroy();

  const meta = await result;
  assert.equal(hasErrors(meta), true);
});
