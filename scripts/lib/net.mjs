import dns from 'node:dns';

// Some networks fail to resolve the creditcoin hostnames through the local
// resolver. Opt in with RECOURSE_DOH_FALLBACK=1 to fall back to DNS-over-HTTPS
// (1.1.1.1 is an IP literal, so it needs no resolver itself).
export function installDohFallback() {
  if (process.env.RECOURSE_DOH_FALLBACK !== '1') return;

  const cache = new Map();
  const resolveViaDoh = async (hostname) => {
    if (cache.has(hostname)) return cache.get(hostname);
    const res = await fetch(`https://1.1.1.1/dns-query?name=${hostname}&type=A`, {
      headers: { accept: 'application/dns-json' },
    });
    const body = await res.json();
    const record = (body.Answer || []).find((entry) => entry.type === 1);
    if (!record) throw new Error(`DoH: no A record for ${hostname}`);
    cache.set(hostname, record.data);
    return record.data;
  };

  const systemLookup = dns.lookup.bind(dns);
  dns.lookup = (hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    systemLookup(hostname, options, (err, address, family) => {
      if (!err) return callback(null, address, family);
      resolveViaDoh(hostname)
        .then((ip) =>
          options?.all
            ? callback(null, [{ address: ip, family: 4 }])
            : callback(null, ip, 4)
        )
        .catch(() => callback(err, address, family));
    });
  };
}
