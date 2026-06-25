import koffi from 'koffi';
import { describe, expect, it } from 'vitest';
import { createKoffiBackend, type Pointer } from './koffi-ffi-backend.js';

// These tests load the platform C runtime through koffi and exercise real native
// calls. They run on Linux (libc.so.6), macOS (libSystem.B.dylib), and Windows
// (msvcrt.dll). getpid is `_getpid` on Windows.

const backend = createKoffiBackend(koffi);

function libcPath(): string {
    switch (process.platform) {
        case 'linux':
            return 'libc.so.6';
        case 'darwin':
            return 'libSystem.B.dylib';
        case 'win32':
            return 'msvcrt.dll';
        default:
            return 'libc.so.6';
    }
}

function getpidSymbol(): string {
    return process.platform === 'win32' ? '_getpid' : 'getpid';
}

function expectedSuffix(): string {
    switch (process.platform) {
        case 'darwin':
            return '.dylib';
        case 'win32':
            return '.dll';
        default:
            return '.so';
    }
}

describe('createKoffiBackend', () => {
    it('loads libc and calls getpid', () => {
        const lib = backend.dlopen(libcPath(), {
            [getpidSymbol()]: { args: [], returns: 'i32' },
        });
        const getpid = lib.symbols[getpidSymbol()] as () => number;
        try {
            const pid = getpid();
            expect(pid).toBeGreaterThan(0);
            expect(pid).toBe(process.pid);
        } finally {
            lib.close();
        }
    });

    it('registers and invokes a callback via qsort', () => {
        const lib = backend.dlopen(libcPath(), {
            qsort: { args: ['ptr', 'u64', 'u64', 'callback'], returns: 'void' },
        });
        try {
            const qsort = lib.symbols.qsort as (base: Pointer, nmemb: number, size: number, cb: Pointer) => void;

            let invoked = false;
            const callback = lib.createCallback(
                (first: unknown, second: unknown) => {
                    invoked = true;
                    const left = koffi.decode(first as bigint, 'int32') as number;
                    const right = koffi.decode(second as bigint, 'int32') as number;
                    return left - right;
                },
                { args: ['ptr', 'ptr'], returns: 'i32' },
            );

            const array = new Int32Array([5, 2, 8, 1, 4]);
            const basePointer = backend.ptr(array);
            const callbackPointer = callback.ptr;
            if (callbackPointer === null) {
                throw new Error('callback pointer was null');
            }

            qsort(basePointer, array.length, Int32Array.BYTES_PER_ELEMENT, callbackPointer);

            expect(invoked).toBe(true);
            expect(Array.from(array)).toEqual([1, 2, 4, 5, 8]);
        } finally {
            lib.close();
        }
    });

    it('round-trips a typed array through ptr and toArrayBuffer', () => {
        const array = new Int32Array([10, 20, 30]);
        const pointer = backend.ptr(array);
        const buffer = backend.toArrayBuffer(pointer, 0, array.byteLength);
        expect(Array.from(new Int32Array(buffer))).toEqual([10, 20, 30]);
    });

    it('honors a non-zero offset in toArrayBuffer', () => {
        const array = new Int32Array([7, 8, 9]);
        const pointer = backend.ptr(array);
        const buffer = backend.toArrayBuffer(pointer, Int32Array.BYTES_PER_ELEMENT, Int32Array.BYTES_PER_ELEMENT);
        expect(new Int32Array(buffer)[0]).toBe(8);
    });

    it('exposes the platform shared-library suffix', () => {
        expect(backend.suffix).toBe(expectedSuffix());
    });

    it('throws when loading a nonexistent library', () => {
        expect(() =>
            backend.dlopen('/nonexistent/mission-control-nope.so.999', {
                missing: { args: [], returns: 'void' },
            }),
        ).toThrow();
    });

    it('rejects createCallback after the library is closed', () => {
        const lib = backend.dlopen(libcPath(), {
            [getpidSymbol()]: { args: [], returns: 'i32' },
        });
        lib.close();
        expect(() => lib.createCallback(() => 0, { args: ['ptr', 'ptr'], returns: 'i32' })).toThrow(
            /Cannot create FFI callback/,
        );
    });

    it('makes library.close idempotent', () => {
        const lib = backend.dlopen(libcPath(), {
            [getpidSymbol()]: { args: [], returns: 'i32' },
        });
        lib.close();
        expect(() => lib.close()).not.toThrow();
    });

    it('cleans up a registered callback when its library closes', () => {
        const lib = backend.dlopen(libcPath(), {
            qsort: { args: ['ptr', 'u64', 'u64', 'callback'], returns: 'void' },
        });
        const callback = lib.createCallback(() => 0, { args: ['ptr', 'ptr'], returns: 'i32' });
        expect(callback.ptr).not.toBeNull();
        lib.close();
        expect(callback.ptr).toBeNull();
    });

    it('rejects ptr() on unsupported values', () => {
        expect(() => backend.ptr('not-a-buffer' as unknown as ArrayBuffer)).toThrow(TypeError);
    });
});
