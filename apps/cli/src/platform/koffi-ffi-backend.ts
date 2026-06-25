// koffi FFI adapter for @opentui/core.
//
// opentui's FFI layer (see @opentui/core platform/ffi) exposes a runtime-agnostic
// `FfiBackend` interface with two reference factories shipped in the box:
// `createBunBackend` (bun:ffi) and `createNodeBackend` (node:ffi). This module adds
// a third, `createKoffiBackend`, that loads native shared libraries through koffi
// (https://koffi.dev/) instead. It is a drop-in candidate for T2's renderer wiring.
//
// The `FfiBackend` interface itself is not re-exported by @opentui/core's package
// entry, so the types below are local structural mirrors of the real contract
// (verified against @opentui/core/platform/ffi.d.ts). They are type-only and erased
// at compile time; the runtime object shape matches what opentui consumes.
//
// Struct audit (for T2, not implemented here):
// opentui also depends on `bun-ffi-structs` for ~25 packed struct definitions
// (StyledChunkStruct, HighlightStruct, CursorStateStruct, NativeSpanFeedOptionsStruct,
// AudioStatsStruct, etc.). Those structs are declared through a separate `defineStruct`
// API that does NOT flow through `FfiBackend.dlopen`/`createCallback`; they are an
// orthogonal concern handled by opentui's NativeSpanFeed / audio paths. Mapping them to
// `koffi.struct()` is feasible (field name + koffi type spec per member) and is T2 work.

import { fileURLToPath } from 'node:url';

/**
 * Minimal structural view of the koffi module surface this adapter relies on.
 * Bound to the koffi default export's type so callers can `import koffi from 'koffi'`
 * and pass it directly while the adapter stays injectable.
 */
type KoffiModule = typeof import('koffi')['default'];

declare const pointerBrand: unique symbol;

/** Branded pointer value (number | bigint) matching opentui's `Pointer`. */
export type Pointer = (number | bigint) & { readonly [pointerBrand]: 'Pointer' };

/** FFI type vocabulary, mirroring @opentui/core FFIType. */
export type FFIType =
    | 'char'
    | 'int8_t'
    | 'i8'
    | 'uint8_t'
    | 'u8'
    | 'int16_t'
    | 'i16'
    | 'uint16_t'
    | 'u16'
    | 'int32_t'
    | 'i32'
    | 'int'
    | 'uint32_t'
    | 'u32'
    | 'int64_t'
    | 'i64'
    | 'uint64_t'
    | 'u64'
    | 'double'
    | 'f64'
    | 'float'
    | 'f32'
    | 'bool'
    | 'ptr'
    | 'pointer'
    | 'void'
    | 'cstring'
    | 'function'
    | 'usize'
    | 'callback'
    | 'napi_env'
    | 'napi_value'
    | 'buffer';

/** Function declaration consumed by dlopen/createCallback. Mirrors opentui FFIFunction. */
export interface FFIFunction {
    readonly args?: readonly FFIType[];
    readonly returns?: FFIType;
    readonly ptr?: Pointer;
    readonly threadsafe?: boolean;
}

/** Callable FFI symbol. Args are open (FFI boundary); return is narrowed by the caller. */
export type FfiSymbol = (...args: readonly unknown[]) => unknown;

export interface FFICallbackInstance {
    readonly ptr: Pointer | null;
    readonly threadsafe: boolean;
    close(): void;
}

export interface KoffiLibrary<Fns extends Record<string, FFIFunction>> {
    readonly symbols: { readonly [K in keyof Fns]: FfiSymbol };
    createCallback(callback: (...args: readonly unknown[]) => unknown, definition: FFIFunction): FFICallbackInstance;
    close(): void;
}

export interface KoffiFfiBackend {
    dlopen<Fns extends Record<string, FFIFunction>>(path: string | URL, symbols: Fns): KoffiLibrary<Fns>;
    ptr(value: ArrayBufferLike | ArrayBufferView): Pointer;
    readonly suffix: string;
    toArrayBuffer(pointer: Pointer, offset: number | undefined, length: number): ArrayBuffer;
}

const LIBRARY_CLOSED = 'Cannot create FFI callback after library.close() has been called';
const KOFFI_PTR_VALUE = 'koffi ptr() only supports ArrayBuffer and ArrayBufferView values';
const KOFFI_USIZE_UNSUPPORTED = 'koffi FFI backend does not support usize yet';
const KOFFI_NAPI_UNSUPPORTED = 'koffi FFI backend does not support Bun N-API FFI types';
const POINTER_NEGATIVE = 'Pointer must be non-negative';

/**
 * Map an opentui FFIType to a koffi type spec. koffi accepts the primitive names
 * directly; `cstring` maps to koffi's `str` (the canonical C-string type that
 * auto-decodes for both parameters and return values), and pointer-like types map
 * to `void *`. `usize`, `napi_env`, and `napi_value` are rejected to match the
 * opentui Node backend restrictions.
 */
function toKoffiType(type: FFIType): string {
    switch (type) {
        case 'char':
            return 'char';
        case 'int8_t':
        case 'i8':
            return 'int8';
        case 'uint8_t':
        case 'u8':
            return 'uint8';
        case 'int16_t':
        case 'i16':
            return 'int16';
        case 'uint16_t':
        case 'u16':
            return 'uint16';
        case 'int32_t':
        case 'i32':
        case 'int':
            return 'int32';
        case 'uint32_t':
        case 'u32':
            return 'uint32';
        case 'int64_t':
        case 'i64':
            return 'int64';
        case 'uint64_t':
        case 'u64':
            return 'uint64';
        case 'double':
        case 'f64':
            return 'double';
        case 'float':
        case 'f32':
            return 'float';
        case 'bool':
            return 'bool';
        case 'ptr':
        case 'pointer':
        case 'function':
        case 'callback':
        case 'buffer':
            return 'void *';
        case 'cstring':
            return 'str';
        case 'void':
            return 'void';
        case 'usize':
            throw new Error(KOFFI_USIZE_UNSUPPORTED);
        case 'napi_env':
        case 'napi_value':
            throw new Error(KOFFI_NAPI_UNSUPPORTED);
        default: {
            const exhausted: never = type;
            throw new Error(`Unsupported FFIType for koffi: ${String(exhausted)}`);
        }
    }
}

function toBigIntPointer(pointer: Pointer): bigint {
    const value = typeof pointer === 'bigint' ? pointer : BigInt(pointer);
    if (value < 0n) {
        throw new Error(POINTER_NEGATIVE);
    }
    return value;
}

interface RawCallback {
    readonly ptr: Pointer;
    readonly threadsafe: boolean;
    close(): void;
}

function createManagedCallback(raw: RawCallback, callbacks: Set<FFICallbackInstance>): FFICallbackInstance {
    let ptr: Pointer | null = raw.ptr;
    let closed = false;
    const instance: FFICallbackInstance = {
        get ptr() {
            return ptr;
        },
        get threadsafe() {
            return raw.threadsafe;
        },
        close() {
            if (closed) {
                return;
            }
            closed = true;
            callbacks.delete(instance);
            try {
                raw.close();
            } finally {
                ptr = null;
            }
        },
    };
    callbacks.add(instance);
    return instance;
}

/**
 * Build an opentui-compatible `FfiBackend` backed by koffi. The `koffi` module is
 * injected (mirroring opentui's `createBunBackend(bun)` / `createNodeBackend(nodeFfi)`)
 * so the adapter never imports koffi at module top level and stays test-friendly.
 */
export function createKoffiBackend(koffi: KoffiModule): KoffiFfiBackend {
    return {
        dlopen<Fns extends Record<string, FFIFunction>>(path: string | URL, symbols: Fns): KoffiLibrary<Fns> {
            const libraryPath = path instanceof URL ? fileURLToPath(path) : path;
            const library = koffi.load(libraryPath);
            const callbacks = new Set<FFICallbackInstance>();
            let closed = false;
            let libraryUnloaded = false;

            const symbolsResult: Record<string, FfiSymbol> = {};
            for (const [name, definition] of Object.entries(symbols)) {
                const resultType = toKoffiType(definition.returns ?? 'void');
                const argumentTypes = (definition.args ?? []).map((type) => toKoffiType(type));
                symbolsResult[name] = library.func(name, resultType, argumentTypes);
            }

            return {
                symbols: symbolsResult as { [K in keyof Fns]: FfiSymbol },
                createCallback(callback, definition) {
                    if (closed) {
                        throw new Error(LIBRARY_CLOSED);
                    }
                    const resultType = toKoffiType(definition.returns ?? 'void');
                    const argumentTypes = (definition.args ?? []).map((type) => toKoffiType(type));
                    const prototype = koffi.proto(resultType, argumentTypes);
                    const callbackPointer = koffi.register(callback, koffi.pointer(prototype));
                    const threadsafe = definition.threadsafe ?? false;
                    const raw: RawCallback = {
                        ptr: callbackPointer as Pointer,
                        threadsafe,
                        close() {
                            if (!libraryUnloaded) {
                                koffi.unregister(callbackPointer);
                            }
                        },
                    };
                    return createManagedCallback(raw, callbacks);
                },
                close() {
                    if (closed) {
                        return;
                    }
                    closed = true;
                    try {
                        libraryUnloaded = true;
                        library.unload();
                    } finally {
                        for (const callback of [...callbacks]) {
                            callback.close();
                        }
                    }
                },
            };
        },
        ptr(value) {
            if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
                return koffi.address(value) as Pointer;
            }
            throw new TypeError(KOFFI_PTR_VALUE);
        },
        suffix: koffi.extension,
        toArrayBuffer(pointer, offset, length) {
            return koffi.view(toBigIntPointer(pointer) + BigInt(offset ?? 0), length);
        },
    };
}
