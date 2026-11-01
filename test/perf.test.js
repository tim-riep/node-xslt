import { test, summary } from "./harness.mjs";
import assert from "node:assert/strict";
import { transform, hasErrors } from "../dist/index.js";

// Regression guard for a real go-xslt bug (fixed in v0.0.3): fn:json-to-xml
// never called xmltree.AssignOrder on its result tree, so any subsequent
// path/count over it fell back to an O(k) linear scan per node comparison,
// turning a wide flat JSON array into an O(n^2) call.
//
// This compares how the time SCALES (8x the data -> ~8x the time if linear,
// ~64x if quadratic), not an absolute time. An absolute limit is a function
// of the machine: the first version of this test used one calibrated on a
// fast laptop and failed on a slower CI runner with nothing wrong. A ratio
// of two timings taken on the same machine in the same process doesn't care
// how fast that machine is. Each size takes the best of three runs, taken
// alternately so a slow stretch on a shared runner hits both sizes. With
// only 4x the data (linear ~4, quadratic ~16) the macos-15-intel runner's
// noise reached ratios of 9.8 on fixed code; 8x leaves a much wider gap.
const stylesheet = `<xsl:stylesheet version="3.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:xf="http://www.w3.org/2005/xpath-functions"
  exclude-result-prefixes="#all">
  <xsl:output method="text"/>
  <xsl:param name="input" as="xs:string" required="yes"/>
  <xsl:template name="main">
    <xsl:variable name="xml" select="json-to-xml($input)"/>
    <xsl:value-of select="count($xml/xf:array/xf:map)"/>
  </xsl:template>
</xsl:stylesheet>`;

function jsonInput(n) {
  const items = [];
  for (let i = 0; i < n; i++) items.push({ id: `item-${i}`, n: i * 1.5 });
  return JSON.stringify(items);
}

async function engineMs(n, input) {
  const res = await transform({ stylesheet, initialTemplate: "main", params: { input } });
  assert.equal(hasErrors(res), false, JSON.stringify(res.diagnostics));
  assert.equal(res.output, String(n));
  return res.durationMs;
}

await test("json-to-xml on a wide flat array scales linearly, not quadratically", async () => {
  const small = 30_000;
  const large = 240_000; // 8x: linear ~8, quadratic ~64
  const inSmall = jsonInput(small);
  const inLarge = jsonInput(large);
  let tSmall = Infinity;
  let tLarge = Infinity;
  for (let r = 0; r < 3; r++) {
    tSmall = Math.min(tSmall, await engineMs(small, inSmall));
    tLarge = Math.min(tLarge, await engineMs(large, inLarge));
  }
  const ratio = tLarge / Math.max(tSmall, 1);
  console.log(`  json-to-xml: ${small} items ${tSmall}ms, ${large} items ${tLarge}ms, ratio ${ratio.toFixed(1)} (linear ~8, quadratic ~64)`);
  assert.ok(
    ratio < 20,
    `8x the data took ${ratio.toFixed(1)}x the time (${tSmall}ms -> ${tLarge}ms); linear is ~8, quadratic ~64 — looks quadratic again`,
  );
});

summary();
