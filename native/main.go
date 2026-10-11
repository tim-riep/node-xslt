// Command native builds a C shared library (-buildmode=c-shared) exposing
// github.com/tim-riep/go-xslt/engine to Node via a C ABI, loaded from the
// Node side with koffi (see src/loader.ts). Unlike the wasm build this
// replaced, this runs as an ordinary native Go program: goroutines get real
// OS threads, and the Go runtime's scavenger returns freed heap pages to the
// OS between calls — wasm's linear memory can only ever grow for the life of
// the process, which is what made repeated large transforms in one
// long-lived process an unbounded-memory (eventually crashing) proposition.
//
// Transform/Validate/EvalXPath are plain JSON-in/JSON-out calls: cross the
// boundary as a single malloc'd, NUL-terminated C string each way, freed by
// the caller via Free(). They're safe to build as ordinary C strings because
// encoding/json escapes every control character (including NUL) in a string
// value, so a marshaled Result/ValidateResult/XPathResult can never contain
// a raw NUL byte.
//
// TransformTo streams, so it needs a different shape: a pull-based handle
// protocol (Start/Next/Result/Free) rather than a push callback. That is a
// deliberate choice, not the obvious one — see the package doc comment on
// streamState for why.
package main

/*
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"encoding/json"
	"runtime/cgo"
	"sync"
	"unsafe"

	"github.com/tim-riep/go-xslt/engine"
)

func main() {}

// Free releases a buffer returned by any exported function below (a
// NUL-terminated string from Transform/Validate/EvalXPath/TransformToResult,
// or a raw byte buffer from TransformToNext). All of them are allocated with
// C.CString/C.CBytes, i.e. via the C library's own malloc, so one C.free
// covers every case.
//
//export Free
func Free(ptr unsafe.Pointer) {
	C.free(ptr)
}

//export Transform
func Transform(reqJSON *C.char) *C.char {
	var req engine.Request
	if err := json.Unmarshal([]byte(C.GoString(reqJSON)), &req); err != nil {
		return marshalC(errorResult("parse", "invalid request JSON: "+err.Error()))
	}
	return marshalC(engine.Transform(req))
}

//export Validate
func Validate(reqJSON *C.char) *C.char {
	var req engine.ValidateRequest
	if err := json.Unmarshal([]byte(C.GoString(reqJSON)), &req); err != nil {
		return marshalC(errorValidateResult("invalid request JSON: " + err.Error()))
	}
	return marshalC(engine.Validate(req))
}

//export EvalXPath
func EvalXPath(reqJSON *C.char) *C.char {
	var req engine.XPathRequest
	if err := json.Unmarshal([]byte(C.GoString(reqJSON)), &req); err != nil {
		return marshalC(errorResult("parse", "invalid request JSON: "+err.Error()))
	}
	return marshalC(engine.EvalXPath(req))
}

func errorResult(phase, message string) engine.Result {
	return engine.Result{Diagnostics: []engine.Diagnostic{{
		Severity: engine.SeverityError, Phase: phase, Message: message,
	}}}
}

func errorValidateResult(message string) engine.ValidateResult {
	return engine.ValidateResult{Diagnostics: []engine.Diagnostic{{
		Severity: engine.SeverityError, Phase: "parse", Message: message,
	}}}
}

func marshalC(v any) *C.char {
	b, err := json.Marshal(v)
	if err != nil {
		// Only reachable on programmer error (unsupported type, cycle); the
		// engine's result types are plain JSON-tagged structs.
		return C.CString(`{"diagnostics":[{"severity":"error","phase":"run","message":"internal marshal error"}]}`)
	}
	return C.CString(string(b))
}

// streamState bridges TransformTo's push-based io.Writer to a pull-based
// handle protocol (Start/Next/Result/Free).
//
// The obvious design — Go calls a JS callback per chunk, blocking on its
// return value for backpressure — does not work: a JS callback invoked from
// a background thread only synchronizes up to the point the JS function
// itself returns, which for an async function is its first await, not its
// eventual resolution. An await-based backpressure signal would hand the
// native side a not-yet-resolved value and carry on, exactly the class of
// bug this design avoids by never crossing that boundary at all. Instead,
// TransformTo runs on its own goroutine writing into a small buffered
// channel; Write blocks when that buffer is full exactly the way a
// goroutine-to-goroutine handoff normally would, and each TransformToNext
// call (made async from Node, so it doesn't block the JS main thread) pulls
// one chunk. Nothing here ever calls back into JS.
type streamState struct {
	chunks     chan []byte
	done       chan struct{} // closed once the goroutine has set result
	cancelOnce sync.Once
	cancel     chan struct{}
	result     engine.Result
}

func (s *streamState) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	buf := make([]byte, len(p))
	copy(buf, p)
	select {
	case s.chunks <- buf:
		return len(p), nil
	case <-s.cancel:
		return 0, context.Canceled
	}
}

//export TransformToStart
func TransformToStart(reqJSON *C.char) C.uintptr_t {
	st := &streamState{
		chunks: make(chan []byte, 4),
		done:   make(chan struct{}),
		cancel: make(chan struct{}),
	}

	var req engine.Request
	if err := json.Unmarshal([]byte(C.GoString(reqJSON)), &req); err != nil {
		st.result = errorResult("parse", "invalid request JSON: "+err.Error())
		close(st.chunks)
		close(st.done)
		return C.uintptr_t(cgo.NewHandle(st))
	}

	go func() {
		result := engine.TransformTo(st, req)
		st.result = result
		close(st.chunks)
		close(st.done)
	}()

	return C.uintptr_t(cgo.NewHandle(st))
}

//export TransformToNext
func TransformToNext(handle C.uintptr_t, outLen *C.int) (ptr *C.uchar) {
	st, ok := streamStateFor(handle)
	if !ok {
		*outLen = 0
		return nil
	}
	chunk, ok := <-st.chunks
	if !ok {
		*outLen = 0
		return nil
	}
	// Write() never forwards a zero-length buffer (see streamState.Write),
	// so a non-nil chunk here is always non-empty — nil unambiguously means
	// "done".
	*outLen = C.int(len(chunk))
	return (*C.uchar)(C.CBytes(chunk))
}

//export TransformToResult
func TransformToResult(handle C.uintptr_t) *C.char {
	st, ok := streamStateFor(handle)
	if !ok {
		return marshalC(errorResult("run", "invalid or already-freed stream handle"))
	}
	<-st.done
	return marshalC(st.result)
}

// TransformToFree cancels st (a no-op if it already finished) and releases
// the handle. Always call this exactly once per TransformToStart handle,
// whether the stream was read to completion or abandoned early — an
// abandoned stream's goroutine would otherwise block forever on Write,
// leaked for the life of the process.
//
//export TransformToFree
func TransformToFree(handle C.uintptr_t) {
	h := cgo.Handle(handle)
	defer func() { recover() }() //nolint:errcheck — guards a double-free/invalid handle
	st := h.Value().(*streamState)
	st.cancelOnce.Do(func() { close(st.cancel) })
	h.Delete()
}

func streamStateFor(handle C.uintptr_t) (st *streamState, ok bool) {
	defer func() {
		if recover() != nil {
			st, ok = nil, false
		}
	}()
	h := cgo.Handle(handle)
	st = h.Value().(*streamState)
	return st, true
}
