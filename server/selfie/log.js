// ---------------------------------------------------------------------------
// log.js  (server-side, modul selfie / pap)
// ---------------------------------------------------------------------------
export function selfieLog(msg, ...rest) {
  console.log(`[selfie] ${msg}`, ...rest);
}
export function selfieWarn(msg, ...rest) {
  console.warn(`[selfie] ${msg}`, ...rest);
}
