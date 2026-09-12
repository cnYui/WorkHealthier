import test from 'node:test';
import assert from 'node:assert/strict';
import { captureErrorCode, captureMarkerSample } from '../agent/lib/capture.js';

function clock() {
  let t = 0;
  return () => (t += 10);
}

const decoded = { gray: new Uint8Array(4), width: 640, height: 480 };

test('a found marker yields a normalized side and timings', async () => {
  const sample = await captureMarkerSample({
    now: clock(),
    takePhoto: async () => ({ data: new ArrayBuffer(8), mimeType: 'image/webp' }),
    decodeWebP: async (data, options) => {
      assert.equal(options.output, 'gray');
      return decoded;
    },
    detect: async (image) => {
      assert.equal(image.width, 640);
      assert.equal(image.data, decoded.gray);
      return [{ rawValue: 'WH:50', format: 'qr_code', boundingBox: { width: 64, height: 64 } }];
    }
  });
  assert.equal(sample.found, true);
  assert.equal(sample.markerMm, 50);
  assert.equal(sample.sideNorm, 0.1);
  assert.equal(sample.imageWidth, 640);
  assert.equal(sample.barcodeCount, 1);
  assert.ok(sample.timings.photoMs > 0 && sample.timings.decodeMs > 0 && sample.timings.detectMs > 0);
});

test('no marker in frame is a normal result, not an error', async () => {
  const sample = await captureMarkerSample({
    now: clock(),
    takePhoto: async () => ({ data: new ArrayBuffer(8), mimeType: 'image/webp' }),
    decodeWebP: async () => decoded,
    detect: async () => [{ rawValue: 'https://example.com' }]
  });
  assert.equal(sample.found, false);
  assert.equal(sample.barcodeCount, 1);
});

test('unsupported photo formats and bad decodes reject with classified codes', async () => {
  await assert.rejects(
    captureMarkerSample({
      now: clock(),
      takePhoto: async () => ({ data: new ArrayBuffer(8), mimeType: 'image/jpeg' }),
      decodeWebP: async () => decoded,
      detect: async () => []
    }),
    /camera-unsupported-format/
  );
  await assert.rejects(
    captureMarkerSample({
      now: clock(),
      takePhoto: async () => null,
      decodeWebP: async () => decoded,
      detect: async () => []
    }),
    /camera-no-data/
  );
  await assert.rejects(
    captureMarkerSample({
      now: clock(),
      takePhoto: async () => ({ data: new ArrayBuffer(8), mimeType: 'image/webp' }),
      decodeWebP: async () => ({ width: 0 }),
      detect: async () => []
    }),
    /decode-invalid/
  );
});

test('captureErrorCode classifies runtime messages', () => {
  assert.equal(captureErrorCode(new Error('Permission denied')), 'denied');
  assert.equal(captureErrorCode(new Error('requires a user interaction')), 'needs-tap');
  assert.equal(captureErrorCode(new Error('camera-no-data')), 'camera');
  assert.equal(captureErrorCode(new Error('Failed to decode WebP image')), 'decode');
  assert.equal(captureErrorCode('???'), 'unknown');
  assert.equal(captureErrorCode(null), 'unknown');
});
