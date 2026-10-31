import { isIP } from 'node:net';

const INVALID_URL = 'baseUrl must be an HTTP(S) endpoint (WS(S) for Fish), without credentials, query or fragment.';
const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata.goog', 'instance-data', 'instance-data.ec2.internal']);
const METADATA_IPV4 = new Set(['100.100.100.200', '168.63.129.16', '192.0.0.192']);

function ipv4Policy(host) {
  const bytes = host.split('.').map(Number);
  const blocked = bytes[0] === 169 && bytes[1] === 254 || METADATA_IPV4.has(host);
  return { blocked, local: bytes[0] === 127 || bytes[0] === 10
    || bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31
    || bytes[0] === 192 && bytes[1] === 168 };
}

function hostPolicy(host) {
  if (isIP(host) === 4) return ipv4Policy(host);
  if (isIP(host) === 6) {
    // WHATWG URL canonicalizes dotted IPv4 tails to hexadecimal groups.
    const halves = host.split('::').map(half => half ? half.split(':').map(value => parseInt(value, 16)) : []);
    const words = halves.length === 2
      ? [...halves[0], ...Array(8 - halves[0].length - halves[1].length).fill(0), ...halves[1]] : halves[0];
    if (words.slice(0, 7).every(value => value === 0) && words[7] === 1) return { local: true, blocked: false };
    if (words.slice(0, 5).every(value => value === 0) && [0, 0xffff].includes(words[5])) {
      return ipv4Policy([words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join('.'));
    }
    const metadata = words[0] === 0xfd00 && words[1] === 0xec2
      && words.slice(2, 7).every(value => value === 0) && words[7] === 0x254;
    return { blocked: (words[0] & 0xffc0) === 0xfe80 || metadata, local: (words[0] & 0xfe00) === 0xfc00 };
  }
  return { blocked: METADATA_HOSTS.has(host), local: host === 'localhost' };
}

/** Pure validation for configuration/status and future settings APIs. Never echoes input. */
export function validateBaseUrl(value, { websocket = false } = {}) {
  let url;
  try {
    if (typeof value !== 'string' || !/^[a-z]+:\/\//i.test(value) || /[\s\\?#]/.test(value)) throw new Error();
    url = new URL(value);
    if (!(websocket ? ['ws:', 'wss:'] : ['http:', 'https:']).includes(url.protocol)
      || url.username || url.password || !url.hostname) throw new Error();
  } catch { throw new TypeError(INVALID_URL); }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const policy = hostPolicy(host);
  if (policy.blocked) throw new TypeError('baseUrl cannot target link-local or cloud-metadata addresses.');
  const insecureTransport = url.protocol === 'http:' || url.protocol === 'ws:';
  if (insecureTransport && !policy.local) {
    throw new TypeError('baseUrl requires HTTPS (WSS for Fish), except loopback or private-LAN IP addresses.');
  }
  return { url: url.href, origin: url.origin, insecureTransport };
}

export function validateRequestUrl(baseUrl, requestUrl, options) {
  const base = validateBaseUrl(baseUrl, options);
  const request = validateBaseUrl(requestUrl, options);
  if (base.origin !== request.origin) throw new TypeError('Provider request must remain on the configured baseUrl origin.');
  return request;
}

export function validateProviderHeaders(headers) {
  // These headers can override virtual-host routing independently of the URL.
  let names;
  try { names = [...new Headers(headers).keys()]; }
  catch { throw new TypeError('Provider headers must contain valid HTTP header names and values.'); }
  if (names.some(name => name === 'host' || name === ':authority')) {
    throw new TypeError('Provider headers cannot override the configured host.');
  }
}
