export * from '@automattic/vip-edge-workers-sdk';

export function alloc(size: number): number;
export function on_client_request(
  meta_ptr: number,
  meta_len: number,
  body_ptr: number,
  body_len: number,
): bigint;
export function on_origin_request(
  meta_ptr: number,
  meta_len: number,
  body_ptr: number,
  body_len: number,
): bigint;
export function on_client_response(
  meta_ptr: number,
  meta_len: number,
  body_ptr: number,
  body_len: number,
): bigint;
export function on_origin_response(
  meta_ptr: number,
  meta_len: number,
  body_ptr: number,
  body_len: number,
): bigint;

export function client_request_body(): void;
export function origin_request_body(): void;
export function client_response_body(): void;
export function origin_response_body(): void;
