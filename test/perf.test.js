import { test, summary } from "./harness.mjs";
import assert from "node:assert/strict";
import { transform, hasErrors } from "../dist/index.js";

// Regression guard for a real go-xslt bug (fixed in v0.0.3): fn:json-to-xml
// never called xmltree.AssignOrder on its result tree, so any subsequent
// path/count over it fell back to an O(k) linear scan per node comparison,
// turning a wide flat JSON array into an O(n^2) call.
//
// This compares how the time SCALES (4x the data -> ~4x the time if linear,
// ~16x if quadratic), not an absolute time. An absolute limit is a function
// of the machine: the first version of this test used one calibrated on a
// fast laptop and failed on a slower CI runner with nothing wrong. A ratio
// of two timings taken on the same machine in the same process doesn't care
// how fast that machine is. Each size takes the best of a few runs so a
// single noisy-neighbour hiccup can't tip it.
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

async function bestEngineMs(n, runs = 3) {
  const items = [];
  for (let i = 0; i < n; i++) items.push({ id: `item-${i}`, n: i * 1.5 });
  const input = JSON.stringify(items);
  let best = Infinity;
  for (let r = 0; r < runs; r++) {
    const res = await transform({ stylesheet, initialTemplate: "main", params: { input } });
    assert.equal(hasErrors(res), false, JSON.stringify(res.diagnostics));
    assert.equal(res.output, String(n));
    best = Math.min(best, res.durationMs);
  }
  return best;
}

await test("json-to-xml on a wide flat array scales linearly, not quadratically", async () => {
  const small = 30_000;
  const large = 120_000; // 4x
  const tSmall = await bestEngineMs(small);
  const tLarge = await bestEngineMs(large);
  const ratio = tLarge / Math.max(tSmall, 1);
  console.log(`  json-to-xml: ${small} items ${tSmall}ms, ${large} items ${tLarge}ms, ratio ${ratio.toFixed(1)} (linear ~4, quadratic ~16)`);
  assert.ok(
    ratio < 9,
    `4x the data took ${ratio.toFixed(1)}x the time (${tSmall}ms -> ${tLarge}ms); linear is ~4, quadratic ~16 — looks quadratic again`,
  );
});

summary();
