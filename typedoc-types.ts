// Type aliases for AssemblyScript primitive types.
// Used only by TypeDoc and the editor — never seen by asc.
// No imports/exports: these declarations are ambient (globally visible).

type i32 = number;
type i64 = bigint;
type u8 = number;
type u16 = number;
type u32 = number;
type u64 = bigint;
type f32 = number;
type f64 = number;
type bool = boolean;
type usize = number;

// i64 namespace constants used in host return sentinel checks (i64.MIN_VALUE).
// type alias and namespace can coexist because they occupy different declaration spaces.
declare namespace i64 {
  const MIN_VALUE: bigint;
  const MAX_VALUE: bigint;
}

// AS-specific intrinsic functions
declare function changetype<T>(value: unknown): T;
declare function load<T>(ptr: number, offset?: number): T;
declare function store<T>(ptr: number, value: T, offset?: number): void;

// AS memory namespace
declare namespace memory {
  function copy(dest: number, src: number, n: number): void;
}

// String.UTF8 — AS extension for UTF-8 encode/decode without TextEncoder
interface StringConstructor {
  UTF8: {
    encode(str: string, nullTerminated?: boolean): ArrayBuffer;
    decode(buf: ArrayBuffer, nullTerminated?: boolean): string;
    decodeUnsafe(ptr: number, len: number, nullTerminated?: boolean): string;
  };
}

// Uint8Array extensions added by the AS runtime
interface Uint8Array {
  readonly dataStart: number;
}
interface Uint8ArrayConstructor {
  wrap(buf: ArrayBuffer, byteOffset?: number, length?: number): Uint8Array;
}

// @json is injected as a global by the json-as transformer at compile time.
// Declare it here so TypeScript accepts it as a class decorator without an explicit import.
declare function json(target: Function): void;
