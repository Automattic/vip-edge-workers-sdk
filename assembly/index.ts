// WASM ABI layer — imports from api.ts and re-exports the public SDK surface.
// The host calls on_client_request / on_origin_request / on_client_response /
// on_origin_response and reads the output struct written by writeOutputStruct.

import {
  Headers, Request, Response, RequestInit, ResponseInit,
  RequestHandler, ResponseHandler,
  onClientRequest, onOriginRequest, onClientResponse, onOriginResponse,
  KV, RateLimit, fetch, getenv,
  _onClientRequest, _onOriginRequest, _onClientResponse, _onOriginResponse,
  packRequest, packResponse, unpackRequest, unpackResponse,
  _isResponseSent, _resetResponseSent,
} from './api';

export {
  Headers, Request, Response, RequestInit, ResponseInit,
  RequestHandler, ResponseHandler,
  onClientRequest, onOriginRequest, onClientResponse, onOriginResponse,
  KV, RateLimit, fetch, getenv,
};

export {
  hmacSha256, hmacSha256Str, sha256, secureCompare, jwtVerifyHs256,
  getRandomValues, hexEncode,
} from './crypto';

export { HtmlRules } from './html';

// Body-buffering markers. Re-export the one(s) matching the phases your worker
// needs body access in. Omitting a marker means the host streams that body
// without buffering it — req.body / resp.body will be null for that phase.
export function client_request_body(): void {}
export function origin_request_body(): void {}
export function client_response_body(): void {}
export function origin_response_body(): void {}

// --- WASM ABI exports ---

export function alloc(size: i32): i32 {
  return changetype<i32>(new ArrayBuffer(size));
}

// Writes a 20-byte output struct and returns its address as i64.
// offset  0  u32  flags     — reserved; always 0 in this ABI
// offset  4  u32  meta_ptr
// offset  8  u32  meta_len
// offset 12  u32  body_ptr  — 0 if no body
// offset 16  u32  body_len  — 0 if no body
function writeOutputStruct(metaPtr: i32, metaLen: i32, bodyPtr: i32, bodyLen: i32): i64 {
  const buf = new ArrayBuffer(20);
  const p = changetype<usize>(buf);
  store<u32>(p,      0);
  store<u32>(p + 4,  <u32>metaPtr);
  store<u32>(p + 8,  <u32>metaLen);
  store<u32>(p + 12, <u32>bodyPtr);
  store<u32>(p + 16, <u32>bodyLen);
  // @ts-ignore — widening i32 ptr to i64 return; valid in AS, TypeScript doesn't allow number→bigint cast
  return <i64>changetype<i32>(buf);
}

// All-zero output struct used when the guest committed via response.respond.
// The runtime reads the 20 bytes but ignores meta/body when the response was sent.
function zeroOutputStruct(): i64 {
  const buf = new ArrayBuffer(20);
  // @ts-ignore — widening i32 ptr to i64 return
  return <i64>changetype<i32>(buf);
}

function dispatchRequest(handler: RequestHandler | null, metaPtr: i32, metaLen: i32, bodyPtr: i32, bodyLen: i32): i64 {
  if (handler === null) {
    return writeOutputStruct(metaPtr, metaLen, bodyPtr, bodyLen);
  }

  _resetResponseSent();

  const req = unpackRequest(<usize>metaPtr, <usize>metaLen);
  if (bodyLen > 0) {
    const inBody = new Uint8Array(bodyLen);
    memory.copy(inBody.dataStart, <usize>bodyPtr, <usize>bodyLen);
    req.body = inBody;
  }

  handler(req);

  if (_isResponseSent()) return zeroOutputStruct();

  const meta = packRequest(req);
  const outBody = req.body;
  return writeOutputStruct(
    changetype<i32>(meta), meta.byteLength,
    outBody !== null ? <i32>outBody.dataStart : 0,
    outBody !== null ? outBody.byteLength : 0,
  );
}

function dispatchResponse(handler: ResponseHandler | null, metaPtr: i32, metaLen: i32, bodyPtr: i32, bodyLen: i32): i64 {
  if (handler === null) {
    return writeOutputStruct(metaPtr, metaLen, bodyPtr, bodyLen);
  }

  _resetResponseSent();

  const resp = unpackResponse(<usize>metaPtr, <usize>metaLen);
  if (bodyLen > 0) {
    const inBody = new Uint8Array(bodyLen);
    memory.copy(inBody.dataStart, <usize>bodyPtr, <usize>bodyLen);
    resp.body = inBody;
  }

  handler(resp);

  if (_isResponseSent()) return zeroOutputStruct();

  const meta = packResponse(resp);
  const outBody = resp.body;
  return writeOutputStruct(
    changetype<i32>(meta), meta.byteLength,
    outBody !== null ? <i32>outBody.dataStart : 0,
    outBody !== null ? outBody.byteLength : 0,
  );
}

export function on_client_request(meta_ptr: i32, meta_len: i32, body_ptr: i32, body_len: i32): i64 {
  return dispatchRequest(_onClientRequest, meta_ptr, meta_len, body_ptr, body_len);
}

export function on_origin_request(meta_ptr: i32, meta_len: i32, body_ptr: i32, body_len: i32): i64 {
  return dispatchRequest(_onOriginRequest, meta_ptr, meta_len, body_ptr, body_len);
}

export function on_client_response(meta_ptr: i32, meta_len: i32, body_ptr: i32, body_len: i32): i64 {
  return dispatchResponse(_onClientResponse, meta_ptr, meta_len, body_ptr, body_len);
}

export function on_origin_response(meta_ptr: i32, meta_len: i32, body_ptr: i32, body_len: i32): i64 {
  return dispatchResponse(_onOriginResponse, meta_ptr, meta_len, body_ptr, body_len);
}
