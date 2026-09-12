# Third-party notices

## webpjs (agent/lib/vendor/webpjs)

`agent/lib/vendor/webpjs/webpjs.source.js` and `agent/lib/webp.js` are copied
unchanged from the official AIUI `samples/scanner` project at commit
`88e70bb0382525c1a93ef077c2401dcc31a273ce` of
https://github.com/yodaos-project/AIUI. The decoder is the `webpjs` library
created by Dominik Homberger (https://webpjs.appspot.com/), which is licensed
under the same terms as WebM:

- Software License Agreement: http://www.webmproject.org/license/software/
- Additional IP Rights Grant: http://www.webmproject.org/license/additional/

It is used to decode the WebP photo returned by `CameraContext.takePhoto()`
into grayscale pixels for `BarcodeDetector.detect()` on runtimes that do not
expose `Blob` or `ImageData`.

## QR marker assets (docs/marker)

Generated with the `qrcode` npm package (MIT) at build time; the resulting
images carry no license of their own.
