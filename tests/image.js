import { crc32, deflateSync } from "node:zlib";
import { randomBytes } from "node:crypto";

// A real RGB PNG. Noise keeps transfer sizes representative of compressed media.
export function png(width, height) {
  const uint = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    return Buffer.concat([uint(data.length), body, uint(crc32(body))]);
  };
  const pixels = randomBytes(height * (1 + 3 * width));
  for (let row = 0; row < height; row++) pixels[row * (1 + 3 * width)] = 0;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk(
      "IHDR",
      Buffer.concat([uint(width), uint(height), Buffer.from([8, 2, 0, 0, 0])]),
    ),
    chunk("tEXt", Buffer.from("Description\0image-marker-8695")),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
