// Cryptographic primitives — thin wrappers around host-provided functions.
// All operations run in the host runtime; no hash or HMAC code lives in the WASM binary.

// @ts-ignore — @external is an AS-only decorator; TypeScript does not allow decorators on declare function
@external("crypto", "hmac_sha256")
declare function _hmac_sha256(keyPtr: i32, keyLen: i32, msgPtr: i32, msgLen: i32, outPtr: i32): i32;

// @ts-ignore
@external("crypto", "sha256")
declare function _sha256(msgPtr: i32, msgLen: i32, outPtr: i32): i32;


// @ts-ignore
@external("crypto", "constant_time_eq")
declare function _constant_time_eq(aPtr: i32, aLen: i32, bPtr: i32, bLen: i32): i32;

// @ts-ignore
@external("crypto", "jwt_verify_hs256")
declare function _jwt_verify_hs256(tokenPtr: i32, tokenLen: i32, secretPtr: i32, secretLen: i32): i64;

const DIGEST_SIZE = 32;

/**
 * Compute HMAC-SHA256 of `message` with `key`.
 *
 * @returns 32-byte digest.
 */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const out = new Uint8Array(DIGEST_SIZE);
  _hmac_sha256(
    <i32>key.dataStart,     key.byteLength,
    <i32>message.dataStart, message.byteLength,
    <i32>out.dataStart,
  );
  return out;
}

/**
 * Convenience overload: key and message as UTF-8 strings.
 *
 * @returns 32-byte digest.
 */
export function hmacSha256Str(key: string, message: string): Uint8Array {
  const keyBuf = Uint8Array.wrap(String.UTF8.encode(key));
  const msgBuf = Uint8Array.wrap(String.UTF8.encode(message));
  return hmacSha256(keyBuf, msgBuf);
}

/**
 * Compute the SHA-256 digest of `message`.
 *
 * @returns 32-byte digest.
 */
export function sha256(message: Uint8Array): Uint8Array {
  const out = new Uint8Array(DIGEST_SIZE);
  _sha256(<i32>message.dataStart, message.byteLength, <i32>out.dataStart);
  return out;
}

/**
 * Compare two byte slices in a way that is safe against timing attacks.
 * Delegates to the host. Execution time is O(max(len_a, len_b)) regardless
 * of content or whether lengths match.
 *
 * @returns `true` if both slices have the same length and the same content.
 */
export function secureCompare(a: Uint8Array, b: Uint8Array): bool {
  return _constant_time_eq(
    <i32>a.dataStart, a.byteLength,
    <i32>b.dataStart, b.byteLength,
  ) === 1;
}

/**
 * Verify an HS256 JWT. Checks the algorithm header, HMAC signature, and
 * `exp` claim against wall clock. `nbf` and `iat` are not enforced.
 *
 * The host validates `alg: "HS256"` strictly — RS256 / ES256 tokens return `null`.
 *
 * @param token - Raw JWT string (without `Bearer ` prefix).
 * @param secret - HMAC secret.
 * @returns Decoded claims as a UTF-8 JSON string, or `null` on any failure
 *   (bad signature, expired, wrong algorithm, malformed token).
 */
export function jwtVerifyHs256(token: string, secret: string): string | null {
  const tokenBuf  = Uint8Array.wrap(String.UTF8.encode(token));
  const secretBuf = Uint8Array.wrap(String.UTF8.encode(secret));
  const packed = _jwt_verify_hs256(
    <i32>tokenBuf.dataStart,  tokenBuf.byteLength,
    <i32>secretBuf.dataStart, secretBuf.byteLength,
  );
  if (packed < 0) return null;
  // @ts-ignore — i32() is an AS truncation cast; >>> is valid on i64 in AS
  const ptr = i32(packed >>> 32);
  // @ts-ignore
  const len = i32(packed & 0xffffffff);
  return String.UTF8.decodeUnsafe(ptr, len);
}

/**
 * Encode a byte array as a lowercase hex string (two characters per byte).
 */
export function hexEncode(bytes: Uint8Array): string {
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += hex.charAt((b >>> 4) & 0x0f);
    out += hex.charAt(b & 0x0f);
  }
  return out;
}
