import { createHmac } from 'node:crypto';

function toBase64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function signToken(payload: object, secret: string): string {
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = createHmac('sha256', secret).update(payloadBytes).digest();
  return `${toBase64Url(payloadBytes)}.${toBase64Url(sig)}`;
}
