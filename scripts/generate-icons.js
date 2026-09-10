'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const outputDir = path.join(__dirname, '..', 'icons');
const background = [79, 126, 248];
const white = [255, 255, 255];

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pixelIsText(x, y, size) {
  const scale = size / 192;
  const left = Math.round(59 * scale);
  const top = Math.round(70 * scale);
  const unit = Math.max(1, Math.round(6 * scale));
  const width = Math.round(74 * scale);
  const height = Math.round(52 * scale);
  if (x < left || x >= left + width || y < top || y >= top + height) return false;

  const col = Math.floor((x - left) / unit);
  const row = Math.floor((y - top) / unit);
  const maxCol = Math.ceil(width / unit);
  const maxRow = Math.ceil(height / unit);
  const p = [
    '1111000 1000100 1000100 1111000 1000000 1000000 1000000',
    '1000100 1100100 1010100 1001100 1000100 1000100 1000100',
  ];
  if (row >= maxRow || col >= maxCol) return false;
  const glyph = col < 5 * 1 ? p[0] : p[1];
  const glyphCol = col < 5 ? col : col - 5;
  const glyphRow = row;
  const rows = glyph.split(' ');
  return glyphRow < rows.length && rows[glyphRow][glyphCol] === '1';
}

function createPng(size) {
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x += 1) {
      const colour = pixelIsText(x, y, size) ? white : background;
      const offset = 1 + x * 3;
      row[offset] = colour[0];
      row[offset + 1] = colour[1];
      row[offset + 2] = colour[2];
    }
    rows.push(row);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(outputDir, { recursive: true });
for (const [filename, size] of [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
  ['favicon.ico', 32],
]) {
  fs.writeFileSync(path.join(outputDir, filename), createPng(size));
  console.log(`Created ${filename} (${size}x${size})`);
}
