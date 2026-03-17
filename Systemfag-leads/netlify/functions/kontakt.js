const https = require('https');
const http  = require('http');
const url   = require('url');

function hent(targetUrl) {
  return new Promise((resolve, reject) => {
    const opts = {
      ...url.parse(targetUrl),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'no,nb;q=0.9,nn;q=0.8',
      },
      timeout: 8000,
    };
    const lib = targetUrl.startsWith('https') ? https : http;
    const req = lib.get(opts, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        return hent(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', d => data += d);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function rensNummer(raw) {
  const bare = raw.replace(/[\s\-\(\)\.]/g, '').replace(/^(\+47|0047)/, '');
  if (bare.length === 8 && /^[2-9]/.test(bare)) return bare;
  return null;
}

function trekkUtNumre(html, kilde) {
  const funnet = [];
  // Telefonnumre i ulike formater
  const re = /(?:telefon|phone|tlf|tel)[^0-9+]{0,20}(\+?47[\s\-]?)?(\d[\d\s\-]{6,9}\d)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const nr = rensNummer((m[1]||'') + m[2]);
    if (nr && !funnet.find(f => f.nummer === nr)) {
      const erMobil = /^[49]/.test(nr);
      funnet.push({ nummer: nr, kilde, type: erMobil ? 'mobil' : 'telefon', score: erMobil ? 80 : 60 });
    }
  }
  // Backup: alle 8-sifrede tall
  const re2 = /\b(\d{2}[\s\-]?\d{2}[\s\-]?\d{2}[\s\-]?\d{2})\b/g;
  while ((m = re2.exec(html)) !== null) {
    const nr = rensNummer(m[1]);
    if (nr && !funnet.find(f => f.nummer === nr)) {
      const erMobil = /^[49]/.test(nr);
      funnet.push({ nummer: nr, kilde, type: erMobil ? 'mobil' : 'telefon', score: erMobil ? 70 : 50 });
    }
  }
  return funnet;
}

function trekkUtKontaktpersoner(html) {
  const personer = [];
  // Daglig leder / styreleder
  const re = /(?:Daglig leder|Styreleder|CEO|Kontaktperson)[^<]{0,30}<[^>]+>([A-ZÆØÅ][a-zæøå]+(?: [A-ZÆØÅ][a-zæøå]+)+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const n = m[1].trim();
    if (n && !personer.includes(n)) personer.push(n);
  }
  return personer.slice(0, 3);
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin' : '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type'                : 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const { orgnr, navn } = event.queryStringParameters || {};
  if (!orgnr || !navn) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'orgnr og navn er påkrevd' }) };
  }

  const navnEnc = encodeURIComponent(navn.split(' ').slice(0, 3).join(' '));
  const alleNumre = [];
  const kontaktpersoner = [];
  const errors = [];

  await Promise.allSettled([
    // Proff.no via orgnr
    hent(`https://www.proff.no/selskap/-/-/${orgnr}/`)
      .then(html => {
        alleNumre.push(...trekkUtNumre(html, 'proff.no').map(n => ({...n, score: n.score + 20})));
        kontaktpersoner.push(...trekkUtKontaktpersoner(html));
      })
      .catch(e => errors.push('proff: ' + e.message)),

    // 1881.no
    hent(`https://www.1881.no/?query=${navnEnc}&type=company`)
      .then(html => {
        alleNumre.push(...trekkUtNumre(html, '1881.no'));
      })
      .catch(e => errors.push('1881: ' + e.message)),
  ]);

  // Dedupliser og sorter
  const sett = new Set();
  const unik = alleNumre.filter(n => {
    if (sett.has(n.nummer)) return false;
    sett.add(n.nummer); return true;
  }).sort((a, b) => b.score - a.score).slice(0, 5);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      numre: unik,
      kontaktpersoner: [...new Set(kontaktpersoner)].slice(0, 3),
      errors: errors.length ? errors : undefined,
    }),
  };
};
