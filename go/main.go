// Command wasmbind compiles the goxslt engine (github.com/tim-riep/go-xslt)
// to WebAssembly and exposes it to JavaScript as a small set of promise-
// returning functions under globalThis.__goXslt. transform/validate/evalXPath
// never cross the Go/JS boundary with anything but strings, so the same
// request/response shapes the Go engine already uses (see engine.Request,
// engine.Result, ...) are what the Node wrapper package marshals directly.
// transformTo streams its output as raw byte chunks through a caller-
// supplied callback instead (see jsChunkWriter).
//
// This binary is only ever run inside a WebAssembly host (GOOS=js
// GOARCH=wasm); it has no meaning as a native executable.
package main

import (
	"encoding/json"
	"errors"
	"syscall/js"

	"github.com/tim-riep/go-xslt/engine"
)

func main() {
	ns := js.Global().Get("Object").New()
	ns.Set("transform", js.FuncOf(asyncJSONFunc(runTransform)))
	ns.Set("validate", js.FuncOf(asyncJSONFunc(runValidate)))
	ns.Set("evalXPath", js.FuncOf(asyncJSONFunc(runEvalXPath)))
	ns.Set("transformTo", js.FuncOf(transformToEntry))
	js.Global().Set("__goXslt", ns)

	// Signal the Node-side loader that __goXslt is ready to call. go.run()'s
	// returned promise never resolves (this program never exits), so the
	// loader can't just await it; it awaits this explicit hook instead. This
	// call happens synchronously during wasm instantiation, before main
	// parks below, so it always fires before the loader's `await ready` has
	// a chance to hang.
	if init := js.Global().Get("__goXsltInit"); init.Truthy() {
		init.Invoke()
	}

	// Block forever: main returning would tear down the Go runtime and make
	// the registered callbacks above unusable. A pending js.Func keeps the
	// wasm instance alive across this park instead of it being treated as a
	// fatal all-goroutines-asleep deadlock.
	select {}
}

// runAsPromise starts work on a new goroutine and returns a JS Promise that
// resolves to its result. The synchronous js.FuncOf callback that calls this
// returns immediately with the pending Promise; work itself runs off that
// call stack. That matters whenever work can block on an async JS operation
// (file I/O reachable from the engine — document(), xsl:include,
// unparsed-text(), collections, xsl:result-document — or, for transformTo,
// the chunk callback awaiting backpressure): Go's js/wasm scheduler can only
// suspend a goroutine and hand control back to Node's event loop when that
// goroutine isn't sitting on the JS call stack that invoked it synchronously.
// A synchronous js.FuncOf callback that itself blocks that way deadlocks; a
// `go func` started from inside it does not.
func runAsPromise(work func() string) js.Value {
	executor := js.FuncOf(func(this js.Value, promArgs []js.Value) any {
		resolve := promArgs[0]
		go func() {
			resolve.Invoke(work())
		}()
		return nil
	})
	promise := js.Global().Get("Promise").New(executor)
	executor.Release()
	return promise
}

// asyncJSONFunc adapts a typed (request-JSON -> response-JSON) function to a
// js.Func callback taking a single JSON request-string argument.
//
// fn itself never returns a Go error: malformed input is reported as an
// engine.Diagnostic, so every call gets the same {diagnostics: [...]}-shaped
// JSON on both good and bad input, and the returned Promise always resolves
// (never rejects).
func asyncJSONFunc(fn func(reqJSON string) string) func(this js.Value, args []js.Value) any {
	return func(this js.Value, args []js.Value) any {
		reqJSON := ""
		if len(args) > 0 {
			reqJSON = args[0].String()
		}
		return runAsPromise(func() string { return fn(reqJSON) })
	}
}

func runTransform(reqJSON string) string {
	var req engine.Request
	if err := json.Unmarshal([]byte(reqJSON), &req); err != nil {
		return errorJSON("parse", "invalid request JSON: "+err.Error())
	}
	return mustMarshal(engine.Transform(req))
}

func runValidate(reqJSON string) string {
	var req engine.ValidateRequest
	if err := json.Unmarshal([]byte(reqJSON), &req); err != nil {
		return errorValidateJSON("invalid request JSON: " + err.Error())
	}
	return mustMarshal(engine.Validate(req))
}

func runEvalXPath(reqJSON string) string {
	var req engine.XPathRequest
	if err := json.Unmarshal([]byte(reqJSON), &req); err != nil {
		return errorJSON("parse", "invalid request JSON: "+err.Error())
	}
	return mustMarshal(engine.EvalXPath(req))
}

// transformToEntry implements __goXslt.transformTo(reqJSON, onChunk). onChunk
// is called once per internal write with a Uint8Array (a copy, safe for the
// JS side to retain); it may return nothing (fire-and-forget) or a Promise,
// in which case jsChunkWriter blocks the transform until it settles — giving
// a slow consumer (e.g. a Node Readable a caller is piping to disk) real
// backpressure all the way back into the Go serializer.
func transformToEntry(this js.Value, args []js.Value) any {
	reqJSON := ""
	var onChunk js.Value
	if len(args) > 0 {
		reqJSON = args[0].String()
	}
	if len(args) > 1 {
		onChunk = args[1]
	}
	return runAsPromise(func() string { return runTransformTo(reqJSON, onChunk) })
}

func runTransformTo(reqJSON string, onChunk js.Value) string {
	var req engine.Request
	if err := json.Unmarshal([]byte(reqJSON), &req); err != nil {
		return errorJSON("parse", "invalid request JSON: "+err.Error())
	}
	if onChunk.Type() != js.TypeFunction {
		return errorJSON("parse", "transformTo requires an onChunk callback function")
	}
	w := &jsChunkWriter{onChunk: onChunk}
	return mustMarshal(engine.TransformTo(w, req))
}

// jsChunkWriter is an io.Writer that forwards each write to a JS callback as
// a Uint8Array (raw bytes, not a per-call string conversion — a chunk
// boundary is not guaranteed to fall on a UTF-8 character boundary, so
// decoding per chunk on the Go side could corrupt multi-byte characters
// split across two writes; the JS/Node side decodes the reassembled byte
// stream instead).
type jsChunkWriter struct {
	onChunk js.Value
}

func (w *jsChunkWriter) Write(p []byte) (int, error) {
	chunk := js.Global().Get("Uint8Array").New(len(p))
	js.CopyBytesToJS(chunk, p)
	ret := w.onChunk.Invoke(chunk)
	if ret.Type() != js.TypeObject || ret.Get("then").Type() != js.TypeFunction {
		return len(p), nil
	}

	done := make(chan error, 1)
	var onResolve, onReject js.Func
	onResolve = js.FuncOf(func(this js.Value, resolveArgs []js.Value) any {
		done <- nil
		onResolve.Release()
		onReject.Release()
		return nil
	})
	onReject = js.FuncOf(func(this js.Value, rejectArgs []js.Value) any {
		done <- errors.New(jsErrorMessage(rejectArgs))
		onResolve.Release()
		onReject.Release()
		return nil
	})
	ret.Call("then", onResolve, onReject)
	if err := <-done; err != nil {
		return 0, err
	}
	return len(p), nil
}

func jsErrorMessage(args []js.Value) string {
	if len(args) == 0 {
		return "chunk callback rejected"
	}
	v := args[0]
	if v.Type() == js.TypeString {
		return v.String()
	}
	if v.Type() == js.TypeObject {
		if msg := v.Get("message"); msg.Type() == js.TypeString {
			return msg.String()
		}
	}
	return "chunk callback rejected"
}

func errorJSON(phase, message string) string {
	return mustMarshal(engine.Result{Diagnostics: []engine.Diagnostic{{
		Severity: engine.SeverityError,
		Phase:    phase,
		Message:  message,
	}}})
}

func errorValidateJSON(message string) string {
	return mustMarshal(engine.ValidateResult{Diagnostics: []engine.Diagnostic{{
		Severity: engine.SeverityError,
		Phase:    "parse",
		Message:  message,
	}}})
}

func mustMarshal(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		// json.Marshal only fails here on programmer error (unsupported
		// types, cyclic values); the engine's result types are plain
		// JSON-tagged structs, so this path is unreachable in practice.
		return `{"diagnostics":[{"severity":"error","phase":"run","message":"internal marshal error"}]}`
	}
	return string(b)
}
