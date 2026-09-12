// One camera capture -> marker measurement, with every runtime dependency
// injected so the pipeline can be unit-tested without a device.
//
// Device pipeline (same as the official scanner sample):
//   wx.media.createCameraContext().takePhoto()  -> { data: ArrayBuffer, mimeType }
//   decodeWebP(data, { output: 'gray' })       -> { gray, width, height }
//   new BarcodeDetector({ formats: ['qr_code'] }).detect({ data, width, height })

import { markerSideNormalized, selectMarker } from './distance.js';

function isWebP(mimeType) {
  return String(mimeType || '').toLowerCase().includes('webp');
}

export async function captureMarkerSample(deps) {
  const startedAt = deps.now();
  const timings = { photoMs: 0, decodeMs: 0, detectMs: 0 };

  const photo = await deps.takePhoto();
  timings.photoMs = deps.now() - startedAt;
  if (!photo || !photo.data) {
    throw new Error('camera-no-data');
  }
  if (!isWebP(photo.mimeType)) {
    throw new Error('camera-unsupported-format:' + (photo.mimeType || 'unknown'));
  }

  const decodeStart = deps.now();
  const decoded = await deps.decodeWebP(photo.data, { output: 'gray' });
  timings.decodeMs = deps.now() - decodeStart;
  if (!decoded || !decoded.gray || !(decoded.width > 0) || !(decoded.height > 0)) {
    throw new Error('decode-invalid');
  }

  const detectStart = deps.now();
  const barcodes = await deps.detect({
    data: decoded.gray,
    width: decoded.width,
    height: decoded.height
  });
  timings.detectMs = deps.now() - detectStart;

  const marker = selectMarker(barcodes);
  if (!marker) {
    return {
      found: false,
      imageWidth: decoded.width,
      imageHeight: decoded.height,
      barcodeCount: Array.isArray(barcodes) ? barcodes.length : 0,
      timings
    };
  }
  const sideNorm = markerSideNormalized(marker.barcode, decoded.width);
  return {
    found: sideNorm !== null,
    sideNorm,
    markerMm: marker.markerMm,
    rawValue: marker.barcode.rawValue,
    imageWidth: decoded.width,
    imageHeight: decoded.height,
    barcodeCount: barcodes.length,
    timings
  };
}

// Classifies capture errors into a short user-facing reason code.
export function captureErrorCode(error) {
  const message = String((error && error.message) || error || '').toLowerCase();
  if (message.includes('permission') || message.includes('denied')) return 'denied';
  if (message.includes('interaction') || message.includes('gesture') || message.includes('focus')) {
    return 'needs-tap';
  }
  if (message.startsWith('camera-')) return 'camera';
  if (message.startsWith('decode') || message.includes('webp')) return 'decode';
  return 'unknown';
}
