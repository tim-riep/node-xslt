// Mirrors the JSON shapes of github.com/tim-riep/go-xslt's engine package
// (engine.Request/Result, engine.ValidateRequest/Result,
// engine.XPathRequest/Result) field for field. Keep this in sync with that
// package's `json:"..."` tags, not with Go field names.

/** A single transformation request. */
export interface TransformRequest {
  /** The XSLT source text. */
  stylesheet: string;
  /** The XML input document. May be omitted when initialTemplate is set. */
  source?: string;
  /** Top-level stylesheet parameters (string-typed for now). */
  params?: Record<string, string>;
  /**
   * Names an xsl:template to invoke first (xsl:initial-template) instead of
   * matching against the source root.
   */
  initialTemplate?: string;
  /**
   * Workspace directory used to resolve relative URIs in xsl:import/include,
   * document()/doc(), unparsed-text(), and to write xsl:result-document.
   * Omitted disables disk resolution.
   */
  baseDir?: string;
}

/** A result produced by xsl:result-document. */
export interface SecondaryOutput {
  href: string;
  content: string;
  method: string;
}

export type Severity = "error" | "warning";
export type Phase = "parse" | "compile" | "run" | "validate";

/**
 * A single error or warning produced while compiling or running a
 * transformation. line/col are 1-based; 0 means "unknown".
 */
export interface Diagnostic {
  severity: Severity;
  line: number;
  col: number;
  /** A W3C-style error code where known (e.g. "XPST0003"). */
  code: string;
  message: string;
  phase: Phase;
}

/**
 * The outcome of a transformation. output holds the serialized result tree;
 * diagnostics holds any errors/warnings. When a fatal error occurs, output is
 * empty and diagnostics contains at least one error.
 */
export interface TransformResult {
  output: string;
  diagnostics: Diagnostic[];
  /** Wall-clock transform time in milliseconds. */
  durationMs: number;
  /** The effective output method ("xml", "html", "text", "json"). */
  method: string;
  /** Text emitted by xsl:message. */
  messages: string[];
  /** Documents produced by xsl:result-document. */
  secondaryOutputs: SecondaryOutput[];
}

export type XSDVersion = "1.0" | "1.1";

/** Validates an XML instance document against one or more XSD schemas. */
export interface ValidateRequest {
  /**
   * The schema document source texts. The first is the entry schema; the
   * rest are additional documents available to xs:import/include.
   */
  schemas: string[];
  /** The XML instance document to validate. */
  instance: string;
  /** "1.0" (default) or "1.1". */
  version?: XSDVersion;
  /**
   * Resolves relative schema locations (xs:import/xs:include/
   * xsi:schemaLocation). Omitted disables disk resolution.
   */
  baseDir?: string;
}

/**
 * The outcome of a validation. valid is true iff the instance is
 * schema-valid; diagnostics carries schema-compile and validation errors
 * (and is non-empty when valid is false).
 */
export interface ValidateResult {
  valid: boolean;
  diagnostics: Diagnostic[];
  durationMs: number;
}

/**
 * Evaluates a standalone XPath 3.1 expression, optionally against an XML
 * context document.
 */
export interface XPathRequest {
  /** The XPath 3.1 expression to evaluate. */
  expression: string;
  /**
   * An optional XML document. When non-empty its document node is the
   * context item, so path expressions like /root/child work; when omitted
   * the expression is evaluated with no context item (e.g. 1 + 2,
   * current-dateTime(), string-length('abc')).
   */
  source?: string;
  /**
   * Resolves relative URIs in fn:doc/fn:unparsed-text/fn:collection. Omitted
   * disables disk resolution (those functions report the resource as
   * unavailable rather than erroring).
   */
  baseDir?: string;
}

/** One item of an XPath result sequence. */
export interface XPathItem {
  /**
   * A short label: a node kind ("element", "attribute", …), an atomic type
   * QName ("xs:integer", …), or "map"/"array"/"function".
   */
  type: string;
  /**
   * The item's string value (element/attribute string value; atomic lexical
   * form).
   */
  value: string;
}

/** The outcome of an XPath evaluation. */
export interface XPathResult {
  /** The string value of the whole result sequence. */
  value: string;
  /** One entry per item in the result sequence. */
  items: XPathItem[];
  /** The number of items in the result sequence. */
  count: number;
  diagnostics: Diagnostic[];
  durationMs: number;
}

/**
 * What {@link TransformResult} carries alongside streamed output: everything
 * except `output` itself, which a streaming call delivers as bytes through a
 * callback/stream instead of buffering into that field (it stays empty, same
 * as the underlying engine's TransformTo).
 */
export type TransformStreamMeta = Omit<TransformResult, "output">;

/** Reports whether a result contains any error-severity diagnostic. */
export function hasErrors(res: {
  diagnostics: Diagnostic[];
}): boolean {
  return res.diagnostics.some((d) => d.severity === "error");
}
