import { isIP } from 'node:net';
export function rateLimitIp(headers:Headers,trustProxy=process.env.TRUST_PROXY){
 if(trustProxy==='0')return 'unknown';
 const ip=headers.get('x-forwarded-for')?.split(',').at(-1)?.trim();return ip&&isIP(ip)?ip:'unknown';
}
