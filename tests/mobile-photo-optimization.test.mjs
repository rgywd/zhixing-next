import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { safeDownloadName } from '../src/api.ts';

const KiB = 1024, MiB = 1024 * KiB;
const jpeg = Buffer.from([255, 216, 255, 224]);
const photo = (name = 'IMG.jpg', extra = {}) => ({ uri: `file:///draft/${name}`, name, width: 6000, height: 4000, ...extra });
function chunk(kind, data = Buffer.alloc(0)) {
  const value = Buffer.alloc(data.length + 12); value.writeUInt32BE(data.length); value.write(kind, 4); data.copy(value, 8); return value;
}
function png({ width = 1440, height = 3200, bitDepth = 8, chunks = [] } = {}) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = bitDepth; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...chunks, chunk('IDAT')]);
}
function harness({ size = 8 * MiB, outputSize = 2 * MiB, outputSizes, header = jpeg, os = 'android', version = 36, renderError, saveError, copyError, dimensions = [6000, 4000] } = {}) {
  const transforms = [], deleted = [], copies = [], reads = [];
  let closed = 0;
  const files = new Map();
  class File {
    constructor(...parts) { this.uri = parts.map(p => typeof p === 'string' ? p : p.uri).join('/'); }
    get parentDirectory() { return { uri: this.uri.slice(0, this.uri.lastIndexOf('/')) }; }
    get size() { return files.get(this.uri)?.size ?? size; }
    get exists() { return files.has(this.uri); }
    open() {
      return { offset: 0, readBytes(length) { reads.push(length); const result = new Uint8Array(header.subarray(this.offset, this.offset + length)); this.offset += result.length; return result; }, close() { closed++; } };
    }
    delete() { deleted.push(this.uri); files.delete(this.uri); }
    async copy(destination) {
      copies.push({ from: this.uri, to: destination.uri });
      await new Promise(resolve => setImmediate(resolve));
      if (copyError) throw copyError;
      files.set(destination.uri, { size: this.size });
    }
    bytes() { assert.fail('optimization must not read the entire original into JavaScript'); }
  }
  const dependencies = {
    'react-native': { Platform: { OS: os, Version: version } }, './api': { safeDownloadName }, 'expo-file-system': { File },
    'expo-image-manipulator': { SaveFormat: { JPEG: 'jpeg', WEBP: 'webp' }, ImageManipulator: { manipulate(uri) {
      const entry = { uri, released: 0, saves: [] }; transforms.push(entry);
      return { release() { entry.released++; }, resize() { assert.fail('keep original resolution'); }, async renderAsync() {
        if (renderError) throw renderError;
        return { width: dimensions[0], height: dimensions[1], release() { entry.released++; }, async saveAsync(options) {
          entry.options = options; entry.saves.push(options); if (saveError) throw saveError;
          const uri = `file:///cache/result.${options.format === 'jpeg' ? 'jpg' : options.format}`;
          files.set(uri, { size: outputSizes?.[entry.saves.length - 1] ?? outputSize }); return { uri, width: dimensions[0], height: dimensions[1] };
        } };
      } };
    } } },
  };
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../src/photoOptimization.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: name => dependencies[name] });
  return { ...exports, transforms, files, deleted, copies, reads, get closed() { return closed; } };
}

test('large JPEGs are optimized below the old 20 MiB trigger without changing resolution', async () => {
  const app = harness(); const result = await app.optimizePhoto(photo());
  assert.equal(result.size, 2 * MiB); assert.equal(result.name, 'IMG.jpg'); assert.equal(result.uri, 'file:///cache/result.jpg');
  assert.equal(app.transforms[0].options.compress, 0.9); assert.equal(app.transforms[0].released, 2);
  assert.equal(app.closed, 1); assert.ok(app.reads.reduce((a, b) => a + b, 0) < 1024);
});

test('PNG screenshots and alpha images use lossless WebP at full resolution on Android 29+', async () => {
  const app = harness({ header: png(), dimensions: [1440, 3200] });
  const result = await app.optimizePhoto(photo('screen.png'));
  assert.equal(result.name, 'screen.webp'); assert.equal(app.transforms[0].options.format, 'webp'); assert.equal(app.transforms[0].options.compress, 1);
  assert.equal(app.closed, 1); assert.equal(app.transforms[0].released, 2);
});

test('when lossless PNG conversion saves too little, one high-quality WebP is encoded from the original pixels', async () => {
  const app = harness({ header: png(), outputSizes: [7.8 * MiB, 3 * MiB] });
  const result = await app.optimizePhoto(photo('screenshot.png'));
  assert.equal(result.name, 'screenshot.webp'); assert.equal(result.size, 3 * MiB); assert.equal(app.transforms.length, 1);
  assert.deepEqual(app.transforms[0].saves.map(s => s.compress), [1, 0.98]);
  assert.ok(app.transforms[0].saves.every(s => s.format === 'webp'), 'never flatten transparency onto JPEG');
  assert.deepEqual(app.deleted, ['file:///cache/result.webp']);
  const ineffective = harness({ header: png(), outputSizes: [9 * MiB, 8 * MiB] }), input = photo('screen.png');
  assert.equal((await ineffective.optimizePhoto(input)).uri, input.uri);
  assert.equal(ineffective.transforms[0].saves.length, 2, 'no repeated quality degradation');
});

test('iOS and older Android preserve PNG because Expo does not expose a guaranteed lossless encoder there', async () => {
  for (const platform of [{ os: 'ios', version: '18.0' }, { os: 'android', version: 28 }]) {
    const app = harness({ ...platform, header: png() }); const input = photo('screen.png');
    assert.equal((await app.optimizePhoto(input)).uri, input.uri); assert.equal(app.transforms.length, 0);
  }
});

test('animated, high bit depth, color-profile PNGs and images beyond WebP dimensions remain intact', async () => {
  for (const header of [png({ chunks: [chunk('acTL', Buffer.alloc(8))] }), png({ chunks: [chunk('iCCP', Buffer.alloc(8))] }), png({ bitDepth: 16 }), png({ height: 28000 })]) {
    const app = harness({ header }); const input = photo('long.png');
    assert.equal((await app.optimizePhoto(input)).uri, input.uri); assert.equal(app.transforms.length, 0); assert.equal(app.closed, 1);
  }
});

test('small images and animated GIF/WebP bypass encoding regardless of misleading filename', async () => {
  for (const options of [{ size: 67 * KiB }, { header: Buffer.from('GIF89a') }, { header: Buffer.from('RIFFxxxxWEBP') }]) {
    const app = harness(options); const input = photo();
    assert.equal((await app.optimizePhoto(input)).uri, input.uri); assert.equal(app.transforms.length, 0);
  }
});

test('re-encoding must save at least 10 percent and 64 KiB; larger and near-equal candidates are deleted', async () => {
  for (const options of [{ outputSize: 9 * MiB }, { outputSize: 7.5 * MiB }, { size: 520 * KiB, outputSize: 460 * KiB }]) {
    const app = harness(options); const input = photo();
    assert.equal((await app.optimizePhoto(input)).uri, input.uri); assert.deepEqual(app.deleted, ['file:///cache/result.jpg']);
  }
});

test('screenshots and long JPEGs use the higher quality setting without downscaling', async () => {
  for (const [name, dimensions] of [['Screenshot_01.jpg', [1440, 2560]], ['分享.jpg', [1080, 18000]]]) {
    const app = harness({ dimensions }); await app.optimizePhoto(photo(name)); assert.equal(app.transforms[0].options.compress, 0.95);
  }
});

test('actual bytes fix HEIC names and extensionless DSH drafts; unsupported HEIC is converted even when small', async () => {
  const app = harness(); const renamed = await app.optimizePhoto(photo('IMG.HEIC', { uri: 'file:///draft/attachment' }));
  assert.equal(renamed.name, 'IMG.jpg');
  const small = harness({ size: 100 * KiB, outputSize: 150 * KiB, header: Buffer.from('0000ftypheic') });
  assert.equal((await small.optimizePhoto(photo('IMG.heic'))).name, 'IMG.jpg'); assert.equal(small.transforms.length, 1);
});

test('failed optional encoding falls back to the original; corrupt originals and mandatory conversion errors remain retryable', async () => {
  for (const options of [{ renderError: new Error('decode failed') }, { saveError: new Error('encode failed') }, { outputSize: 0 }]) {
    const app = harness(options), input = photo(); assert.equal((await app.optimizePhoto(input)).uri, input.uri);
    assert.equal(app.transforms[0].released, options.renderError ? 1 : 2);
  }
  await assert.rejects(harness({ size: 0 }).optimizePhoto(photo()), /无法读取/);
  await assert.rejects(harness({ header: Buffer.from('0000ftypheic'), renderError: new Error('decode failed') }).optimizePhoto(photo('IMG.heic')), /decode failed/);
});

test('the prepared copy keeps its real format, waits for durable bytes, and cleans only generated cache files', async () => {
  const app = harness({ header: png() }); const input = photo('screenshot.png');
  const result = await app.preparePhotoCopy(input);
  assert.equal(result.uri, 'file:///draft/prepared.webp'); assert.ok(app.files.has(result.uri)); assert.equal(result.size, 2 * MiB);
  assert.deepEqual(app.deleted, ['file:///cache/result.webp']); assert.equal(app.copies.length, 1);
  const failed = harness({ copyError: new Error('disk full') });
  await assert.rejects(failed.preparePhotoCopy(photo()), /disk full/); assert.deepEqual(failed.deleted, ['file:///cache/result.jpg']);
  const small = harness({ size: 67 * KiB }); assert.equal((await small.preparePhotoCopy(input)).uri, input.uri); assert.equal(small.copies.length, 0);
});
