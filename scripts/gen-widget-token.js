#!/usr/bin/env node
'use strict';

const crypto = require('crypto');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function toInt(value, fallback = null) {
  if (value == null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function usage() {
  console.log(`Usage:
  node scripts/gen-widget-token.js --seed <seed> [--days 7] [--sub widget]
  node scripts/gen-widget-token.js --seed <seed> [--exp <unix>] [--nbf <unix>] [--sub widget]

Options:
  --seed   Required signing seed (same value as BM_TOKEN_SEED)
  --days   Expiration in days from now (default: 7)
  --exp    Explicit expiration unix timestamp (overrides --days)
  --nbf    Not-before unix timestamp (optional)
  --sub    Subject value (default: widget)
  --json   Print decoded payload JSON after token
`);
}

function main() {
  const args = parseArgs(process.argv);
  const seed = String(args.seed || '').trim();
  if (!seed) {
    usage();
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);
  const sub = String(args.sub || 'widget');
  const days = toInt(args.days, 7);
  const exp = toInt(args.exp, days != null ? now + days * 86400 : null);
  const nbf = toInt(args.nbf, null);

  const payload = { sub };
  if (nbf != null) payload.nbf = nbf;
  if (exp != null) payload.exp = exp;

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sigB64 = crypto.createHmac('sha256', seed).update(payloadB64).digest('base64url');
  const token = `${payloadB64}.${sigB64}`;

  console.log(token);
  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
  }
}

main();
