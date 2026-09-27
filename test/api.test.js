import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { transform, validate, evalXPath, hasErrors, ready } from "../dist/index.js";

test("ready() pre-loads the engine without throwing", async () => {
  await ready();
});

test("transform: basic template match + XPath arithmetic", async () => {
  const res = await transform({
    stylesheet: `<?xml version="1.0"?>
<xsl:stylesheet version="3.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:template match="/">
    <hello><xsl:value-of select="1 + 2"/></hello>
  </xsl:template>
</xsl:stylesheet>`,
    source: "<root/>",
  });
  assert.equal(hasErrors(res), false);
  assert.equal(res.output, '<?xml version="1.0" encoding="UTF-8"?><hello>3</hello>');
  assert.equal(res.method, "xml");
  assert.deepEqual(res.messages, []);
  assert.deepEqual(res.secondaryOutputs, []);
  assert.equal(typeof res.durationMs, "number");
});

test("transform: stylesheet parameters", async () => {
  const res = await transform({
    stylesheet: `<?xml version="1.0"?>
<xsl:stylesheet version="3.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:param name="name" select="'world'"/>
  <xsl:template match="/">
    <greeting>Hello, <xsl:value-of select="$name"/>!</greeting>
  </xsl:template>
</xsl:stylesheet>`,
    source: "<root/>",
    params: { name: "Tim" },
  });
  assert.equal(hasErrors(res), false);
  assert.match(res.output, /Hello, Tim!/);
});

test("transform: initialTemplate invokes a named template with no source document", async () => {
  const res = await transform({
    stylesheet: `<?xml version="1.0"?>
<xsl:stylesheet version="3.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:template name="entry"><out>from named template</out></xsl:template>
</xsl:stylesheet>`,
    initialTemplate: "entry",
  });
  assert.equal(hasErrors(res), false);
  assert.match(res.output, /from named template/);
});

test("transform: compile error surfaces as a diagnostic, not a throw", async () => {
  const res = await transform({
    stylesheet: "<not-a-stylesheet/>",
    source: "<root/>",
  });
  assert.equal(hasErrors(res), true);
  assert.ok(res.diagnostics.length > 0);
  assert.equal(res.diagnostics[0].severity, "error");
});

test("transform: document() resolves against baseDir via the real filesystem", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "node-xslt-"));
  fs.writeFileSync(path.join(dir, "other.xml"), "<r><v>42</v></r>");
  const res = await transform({
    stylesheet: `<?xml version="1.0"?>
<xsl:stylesheet version="3.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:template match="/">
    <out><xsl:value-of select="document('other.xml')/r/v"/></out>
  </xsl:template>
</xsl:stylesheet>`,
    source: "<root/>",
    baseDir: dir,
  });
  assert.equal(hasErrors(res), false);
  assert.match(res.output, /42/);
});

test("evalXPath: expression with no context item", async () => {
  const res = await evalXPath({ expression: "1 + 2" });
  assert.equal(hasErrors(res), false);
  assert.equal(res.count, 1);
  assert.equal(res.value, "3");
  assert.equal(res.items[0].type, "xs:integer");
});

test("evalXPath: expression against a source document", async () => {
  const res = await evalXPath({
    expression: "/root/child/text()",
    source: "<root><child>hi</child></root>",
  });
  assert.equal(hasErrors(res), false);
  assert.equal(res.value, "hi");
});

test("evalXPath: doc() resolves against baseDir via the real filesystem", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "node-xslt-"));
  fs.writeFileSync(path.join(dir, "other.xml"), "<r><v>42</v></r>");
  const res = await evalXPath({
    expression: "doc('other.xml')/r/v/string()",
    baseDir: dir,
  });
  assert.equal(hasErrors(res), false);
  assert.equal(res.value, "42");
});

test("validate: valid instance against an XSD schema", async () => {
  const res = await validate({
    schemas: [
      `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root" type="xs:string"/>
</xs:schema>`,
    ],
    instance: "<root>hello</root>",
  });
  assert.equal(res.valid, true);
  assert.deepEqual(res.diagnostics, []);
});

test("validate: invalid instance reports diagnostics, not a throw", async () => {
  const res = await validate({
    schemas: [
      `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root" type="xs:integer"/>
</xs:schema>`,
    ],
    instance: "<root>not-a-number</root>",
  });
  assert.equal(res.valid, false);
  assert.ok(res.diagnostics.length > 0);
});
