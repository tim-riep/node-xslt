import { test } from "node:test";
import assert from "node:assert/strict";
import { transform, hasErrors } from "../dist/index.js";

// Regression guard for a real go-xslt bug (fixed in v0.0.3): fn:json-to-xml
// never called xmltree.AssignOrder on its result tree, so any subsequent
// path/count over it fell back to an O(k) linear scan per node comparison —
// turning an 80,000-element flat JSON array into an O(n^2) ~6.4s call
// instead of an O(n) ~0.6s one. This asserts the O(n) shape held, not an
// exact timing: the threshold is generous (10x the measured fixed-version
// time) specifically so it fails on a quadratic regression, not on ordinary
// CI machine variance.
test("json-to-xml on a wide flat array stays roughly linear, not quadratic", async () => {
  const n = 80000;
  const items = [];
  for (let i = 0; i < n; i++) items.push({ id: `item-${i}`, n: i * 1.5 });
  const input = JSON.stringify(items);

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

  const res = await transform({ stylesheet, initialTemplate: "main", params: { input } });
  assert.equal(hasErrors(res), false);
  assert.equal(res.output, String(n));
  // Fixed (v0.0.3): ~0.6-1.3s locally. Broken (<=v0.0.2): ~6.4s at this n.
  assert.ok(
    res.durationMs < 6000,
    `expected roughly linear json-to-xml (<6000ms for n=${n}), got ${res.durationMs}ms — looks quadratic again`,
  );
});
