import { MsgpackReader, MsgpackWriter } from "../assembly/msgpack";

export function roundTripsStr32(): bool {
  const input = "x".repeat(65536);
  const writer = new MsgpackWriter();
  writer.writeStr(input);
  const packed = writer.toArrayBuffer();
  const reader = new MsgpackReader(changetype<usize>(packed), packed.byteLength);
  const output = reader.readStr();

  return output.length == input.length
    && output.charCodeAt(0) == 120
    && output.charCodeAt(output.length - 1) == 120;
}
