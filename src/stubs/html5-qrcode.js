/* A stand-in for html5-qrcode, which we never run.
 *
 * The barcode plugin lazily imports a web implementation built on this library.
 * That path is dead here: in the native builds the Swift and Kotlin plugins do
 * the scanning, and on the web the app uses the browser's own BarcodeDetector
 * with its own camera view, falling back to typing the number.
 *
 * Bundled anyway it added about 370KB — more than doubling the app — for code
 * that cannot be reached. If anything ever does reach it, it says so loudly
 * rather than failing in a way that looks like a broken camera.
 */
const unreachable = () => {
  throw new Error(
    "html5-qrcode is stubbed out: scanning goes through the native plugin, " +
    "or the browser's BarcodeDetector. See src/stubs/html5-qrcode.js."
  );
};

export class Html5Qrcode {
  constructor() { unreachable(); }
}
export class Html5QrcodeScanner {
  constructor() { unreachable(); }
}
export const Html5QrcodeSupportedFormats = {};
export default { Html5Qrcode, Html5QrcodeScanner, Html5QrcodeSupportedFormats };
