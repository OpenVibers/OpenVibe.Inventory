'use strict';

/**
 * A Workshop badge image (ADR-054 §6): PNG or WebP, square, 64 to 512 pixels on a side, at most 200 KB. The type and
 * the size are read from the file's own header bytes, never from its name or the browser's word for it.
 *
 *   inspect(buffer) → { type: 'image/png' | 'image/webp', width, height } | { error }
 */
const MAX_BYTES = 200 * 1024;
const MIN_SIDE = 64;
const MAX_SIDE = 512;

function pngSize(b) {
    // 8-byte signature, then the IHDR chunk: length (4), "IHDR" (4), width (4), height (4).
    if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a || b.toString('latin1', 12, 16) !== 'IHDR') return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function webpSize(b) {
    if (b.length < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8 ') {
        // Lossy: a 3-byte frame tag, the start code 9d 01 2a, then 14-bit width and height.
        if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
        return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L') {
        // Lossless: signature 0x2f, then 14 bits of width-1 and 14 bits of height-1.
        if (b[20] !== 0x2f) return null;
        const bits = b.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
        // Extended: 24-bit canvas width-1 and height-1 after 4 bytes of flags.
        return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
    }
    return null;
}

function inspect(buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) return { error: 'Choose an image file.' };
    if (buffer.length > MAX_BYTES) return { error: `The image is ${Math.ceil(buffer.length / 1024)} KB; a badge is at most ${MAX_BYTES / 1024} KB.` };
    let type = null;
    let size = pngSize(buffer);
    if (size) type = 'image/png';
    else if ((size = webpSize(buffer))) type = 'image/webp';
    if (!type) return { error: 'A badge is a PNG or WebP image.' };
    if (size.width !== size.height) return { error: `A badge is square; this image is ${size.width}×${size.height}.` };
    if (size.width < MIN_SIDE || size.width > MAX_SIDE) return { error: `A badge is ${MIN_SIDE} to ${MAX_SIDE} pixels on a side; this one is ${size.width}.` };
    return { type, width: size.width, height: size.height };
}

module.exports = { inspect, MAX_BYTES, MIN_SIDE, MAX_SIDE };
