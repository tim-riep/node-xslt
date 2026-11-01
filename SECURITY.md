# Security policy

## Supported versions

node-xslt is before 1.0. Security fixes go into the next release; only the
latest release on npm is supported.

| Version | Supported |
|---|---|
| latest release | yes |
| older releases | no |

Most security fixes come from the [go-xslt](https://github.com/tim-riep/go-xslt)
engine compiled into this package. When go-xslt publishes an advisory,
node-xslt picks up the fixed version and releases it as soon as CI passes on
all six platforms.

## Reporting a vulnerability

Please report security problems **privately**, through GitHub's
[private vulnerability reporting](https://github.com/tim-riep/node-xslt/security/advisories/new),
not in a public issue.

If the problem is in the engine itself (it reproduces with go-xslt alone),
you can report it to
[go-xslt](https://github.com/tim-riep/go-xslt/security/advisories/new)
instead; reporting it here is fine too, it will be forwarded.

Please include the smallest input that shows the problem (stylesheet, source
document, schema or XPath expression), the request you passed (`baseDir` and
any other options), the node-xslt version, your Node.js version and your
platform.

node-xslt is maintained by one person. You can expect an acknowledgement
within a week, and a fix as soon as the problem is understood. Once the fix
is released, the report is published as a security advisory and, if you
wish, names you.

## What counts as a vulnerability

node-xslt is meant to process input it does not trust. A vulnerability is any
way for a stylesheet, document, schema or expression to get past the limits
of the engine (see the go-xslt
[security guide](https://tim-riep.github.io/go-xslt/guide/security)) or of
this package, for example to:

- read or write a file outside `baseDir`, or any file when `baseDir` is
  omitted
- reach the network
- run past the engine's step, depth or output limits
- crash or hang the Node.js process that calls node-xslt, rather than only
  the worker process that ran the call
- make a call that should return `diagnostics` never settle, or leave the
  worker pool unable to serve later calls

Problems in how this package loads its native library count too, for example
a way to make it load a library other than the one shipped in `dist/native/`.

## What does not

- Behaviour the request allows: with `baseDir` set, a stylesheet may read the
  files under it and write `xsl:result-document` output there.
- Memory use. The engine does not limit the memory of the trees a call
  builds; a hard limit needs the worker processes to run with one.
- Slow but finite calls within the engine's limits.
- Vulnerabilities in your own Node.js or operating system.
- Results that differ from the specifications. Those are bugs; please report
  them as ordinary [issues](https://github.com/tim-riep/node-xslt/issues).
