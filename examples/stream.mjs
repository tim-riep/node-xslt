import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { transformStream, hasErrors } from "../dist/index.js";

const stylesheet = `<?xml version="1.0"?>
<xsl:stylesheet version="3.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:template match="/">
    <items><xsl:for-each select="1 to 20000"><item><xsl:value-of select="."/></item></xsl:for-each></items>
  </xsl:template>
</xsl:stylesheet>`;

const dir = await mkdtemp(path.join(tmpdir(), "node-xslt-example-"));
const outFile = path.join(dir, "out.xml");

const { output, result } = transformStream({ stylesheet, source: "<root/>" });
await pipeline(output, createWriteStream(outFile));

const meta = await result;
if (hasErrors(meta)) {
  console.error("transform failed:", meta.diagnostics);
} else {
  const bytes = (await readFile(outFile)).length;
  console.log(`wrote ${bytes} bytes to ${outFile} in ${meta.durationMs}ms`);
}

await rm(dir, { recursive: true });
