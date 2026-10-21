// ---------------------------------------------------------------------------
// log.js  (server-side, modul selfie / pap)
// ---------------------------------------------------------------------------
export function selfieLog(msg, ...rest) {
  console.log(`[selfie] ${msg}`, ...rest);
}
export function selfieWarn(msg, ...rest) {
  console.warn(`[selfie] ${msg}`, ...rest);
}
export function logSelfie(msg, level = 'info', ...rest) {
  if (level === 'warn') {
    selfieWarn(msg, ...rest);
  } else {
    selfieLog(msg, ...rest);
  }
}
