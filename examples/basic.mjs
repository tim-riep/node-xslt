import { transform, evalXPath, validate, hasErrors } from "../dist/index.js";

const stylesheet = `<?xml version="1.0"?>
<xsl:stylesheet version="3.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:template match="/">
    <greeting>Hello, <xsl:value-of select="/root/@name"/>! (2 + 2 = <xsl:value-of select="2 + 2"/>)</greeting>
  </xsl:template>
</xsl:stylesheet>`;

const res = await transform({ stylesheet, source: `<root name="World"/>` });
console.log("transform:", hasErrors(res) ? res.diagnostics : res.output);

const xres = await evalXPath({ expression: "reverse((1,2,3))" });
console.log("evalXPath:", xres.value);

const vres = await validate({
  schemas: [
    `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root" type="xs:string"/>
</xs:schema>`,
  ],
  instance: "<root>hello</root>",
});
console.log("validate:", vres.valid);
