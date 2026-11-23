/**
 * `uqr` in the test build (vite.config.ts aliases it there): the real encoder,
 * plus the last encoded text on `window`, standing in for the phone camera
 * that reads the QR in real use.
 */
import { encode as realEncode } from "../../node_modules/uqr/dist/index.mjs";

export * from "../../node_modules/uqr/dist/index.mjs";

export const encode: typeof realEncode = (text, options) => {
  (window as unknown as { scannedQr?: unknown }).scannedQr = text;
  return realEncode(text, options);
};
