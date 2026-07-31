/**
 * Minimal PNG encoder for pipeline previews.
 *
 * The world pipeline is a long chain of geometric transforms where a bug
 * produces plausible-looking numbers and wrong-looking geography. Dumping a
 * top-down PNG at each stage turns "the array has 1.5M entries" into "that is
 * unmistakably the downtown peninsula", which is the only verification that
 * actually catches projection and winding errors.
 *
 * Uses only node:zlib — no image dependency.
 */
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

/** colorType 0 = grayscale (1 byte/px), 2 = RGB (3 bytes/px). */
function encode(width: number, height: number, pixels: Uint8Array, colorType: 0 | 2): Buffer {
  const channels = colorType === 0 ? 1 : 3;
  const stride = width * channels;

  // Each scanline is prefixed with a filter-type byte; 0 = no filtering.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;         // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0;        // compression: deflate
  ihdr[11] = 0;        // filter method
  ihdr[12] = 0;        // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function grayscalePng(width: number, height: number, pixels: Uint8Array): Buffer {
  return encode(width, height, pixels, 0);
}

export function rgbPng(width: number, height: number, pixels: Uint8Array): Buffer {
  return encode(width, height, pixels, 2);
}

/**
 * Renders a float field to a PNG, scaling to the given range.
 * Values below `min` clamp to black, above `max` to white.
 */
export function heightPng(
  width: number,
  height: number,
  values: Float32Array,
  min: number,
  max: number,
): Buffer {
  const px = new Uint8Array(width * height);
  const span = max - min || 1;
  for (let i = 0; i < values.length; i++) {
    const t = (values[i]! - min) / span;
    px[i] = Math.max(0, Math.min(255, Math.round(t * 255)));
  }
  return grayscalePng(width, height, px);
}

/**
 * Downsamples a large field before encoding, so previews of multi-million-cell
 * grids stay a sensible size to look at.
 */
export function downsampleField(
  values: Float32Array,
  width: number,
  height: number,
  maxDim: number,
): { values: Float32Array; width: number; height: number } {
  const factor = Math.max(1, Math.ceil(Math.max(width, height) / maxDim));
  if (factor === 1) return { values, width, height };

  const w = Math.floor(width / factor);
  const h = Math.floor(height / factor);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const sx = x * factor + dx;
          const sy = y * factor + dy;
          if (sx < width && sy < height) {
            sum += values[sy * width + sx]!;
            n++;
          }
        }
      }
      out[y * w + x] = n > 0 ? sum / n : 0;
    }
  }
  return { values: out, width: w, height: h };
}
