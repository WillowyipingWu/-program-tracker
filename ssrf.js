// Blocks requests to private/internal addresses so a public deployment
// can't be used to probe the server's own network.
import dns from 'node:dns/promises';
import net from 'node:net';

function ipv4Private(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function ipPrivate(ip) {
  if (net.isIPv4(ip)) return ipv4Private(ip);
  const v6 = ip.toLowerCase();
  if (v6 === '::1' || v6 === '::') return true;
  if (v6.startsWith('::ffff:')) {
    const tail = v6.slice(7);
    return net.isIPv4(tail) ? ipv4Private(tail) : true;
  }
  return v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') ||
         v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb');
}

export async function assertPublicUrl(raw, { allowPrivate = false } = {}) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('链接格式不正确'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('只支持 http/https 链接');
  if (u.username || u.password) throw new Error('链接中不能包含账号密码');
  if (allowPrivate) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => ipPrivate(a.address))) {
    throw new Error('不允许访问内网地址');
  }
  return u;
}
