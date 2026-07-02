#!/usr/bin/env node
// CLI da skill qrcode-otp.
// Gera o codigo TOTP (RFC 6238) a partir de uma URI otpauth://, de um secret
// base32, ou de uma imagem contendo o QRCode de setup.
//
// Uso:
//   node otp.mjs "otpauth://totp/Acme:alice?secret=JBSWY3DPEHPK3PXP&issuer=Acme"
//   node otp.mjs --secret JBSWY3DPEHPK3PXP [--digits 6] [--period 30] [--algorithm SHA1]
//   node otp.mjs --image /caminho/qr.png
//   node otp.mjs --uri "otpauth://..." --json
//
// Saida padrao: o codigo de 6 digitos. Com --json, um objeto com metadados.
// Codigo de saida !=0 em erro, com mensagem no stderr.

import { createHmac } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEFAULTS = { digits: 6, period: 30, algorithm: 'SHA1' };
const ALGO_MAP = { SHA1: 'sha1', SHA256: 'sha256', SHA512: 'sha512' };

// --- Cofre local de secrets (plaintext, chmod 600) ---------------------------
// Guarda os secrets fora do repositorio versionado, em ~/.local/share (XDG),
// para reuso entre sessoes. O arquivo NUNCA deve ser commitado.
function vaultDir() {
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'qrcode-otp');
}
function vaultPath() {
  return join(vaultDir(), 'vault.json');
}
function loadVault() {
  const path = vaultPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`cofre corrompido em ${path}: ${err.message}`);
  }
}
function saveVault(vault) {
  const dir = vaultDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = vaultPath();
  writeFileSync(path, JSON.stringify(vault, null, 2) + '\n', { mode: 0o600 });
  // writeFileSync so aplica mode na criacao; forca 600 mesmo se ja existia.
  chmodSync(path, 0o600);
  return path;
}
function normalizeName(name) {
  const clean = String(name ?? '').trim();
  if (!clean) throw new Error('nome da conta vazio (use --save <nome> ou --use <nome>)');
  return clean;
}

// --- Base32 (RFC 4648) -> Buffer ---------------------------------------------
function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  if (!clean) throw new Error('secret vazio');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`caractere invalido no secret base32: "${char}"`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

// --- TOTP (RFC 6238) ---------------------------------------------------------
function generateTotp({ secret, digits, period, algorithm, forTime }) {
  const key = base32Decode(secret);
  const algo = ALGO_MAP[String(algorithm).toUpperCase()];
  if (!algo) throw new Error(`algoritmo nao suportado: ${algorithm} (use SHA1, SHA256 ou SHA512)`);

  const seconds = Math.floor((forTime ?? Date.now()) / 1000);
  const counter = Math.floor(seconds / period);

  const counterBuf = Buffer.alloc(8);
  // big-endian 64 bits (a metade alta cabe em 32 bits para timestamps reais)
  counterBuf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac(algo, key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const code = (binary % 10 ** digits).toString().padStart(digits, '0');
  const remaining = period - (seconds % period);
  return { code, remaining, seconds };
}

// --- Parse de otpauth:// -----------------------------------------------------
function parseOtpauth(uri) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    throw new Error('URI otpauth invalida');
  }
  if (url.protocol !== 'otpauth:') throw new Error('URI nao comeca com otpauth://');
  const type = url.hostname.toLowerCase();
  if (type !== 'totp') {
    throw new Error(`tipo "${type}" nao suportado (esta skill trata apenas TOTP, nao HOTP)`);
  }
  const params = url.searchParams;
  const secret = params.get('secret');
  if (!secret) throw new Error('URI otpauth sem parametro "secret"');

  const label = decodeURIComponent(url.pathname.replace(/^\//, ''));
  return {
    secret,
    label: label || null,
    issuer: params.get('issuer') || null,
    digits: params.get('digits') ? Number(params.get('digits')) : DEFAULTS.digits,
    period: params.get('period') ? Number(params.get('period')) : DEFAULTS.period,
    algorithm: params.get('algorithm') || DEFAULTS.algorithm,
  };
}

// --- Leitura de QRCode em imagem (deps opcionais: jimp + jsqr) ----------------
async function readQrFromImage(imagePath) {
  let Jimp, jsQR;
  try {
    ({ Jimp } = await import('jimp'));
    jsQR = (await import('jsqr')).default;
  } catch {
    throw new Error(
      'para ler imagens instale as dependencias: rode "npm install" dentro de scripts/'
    );
  }
  let image;
  try {
    image = await Jimp.read(imagePath);
  } catch (err) {
    throw new Error(`nao consegui abrir a imagem "${imagePath}": ${err.message}`);
  }
  const { data, width, height } = image.bitmap;
  const result = jsQR(new Uint8ClampedArray(data), width, height);
  if (!result || !result.data) {
    throw new Error('nenhum QRCode legivel encontrado na imagem');
  }
  return result.data;
}

// --- Parse de argumentos -----------------------------------------------------
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--list') args.list = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
    else args._.push(a);
  }
  return args;
}

function usage() {
  return [
    'Uso:',
    '  node otp.mjs "otpauth://totp/...?secret=XXX"',
    '  node otp.mjs --secret JBSWY3DPEHPK3PXP [--digits 6] [--period 30] [--algorithm SHA1]',
    '  node otp.mjs --image /caminho/qr.png',
    '  (adicione --json para saida estruturada)',
    '',
    'Cofre (reuso entre sessoes, ~/.local/share/qrcode-otp/vault.json, chmod 600):',
    '  node otp.mjs --image qr.png --save github   salva o secret com o nome "github"',
    '  node otp.mjs --use github                   gera o codigo da conta salva',
    '  node otp.mjs --list                         lista as contas salvas (sem o secret)',
    '  node otp.mjs --remove github                remove uma conta do cofre',
  ].join('\n');
}

// --- Main --------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  // --- Operacoes de cofre que nao geram codigo -------------------------------
  if (args.list) {
    const vault = loadVault();
    const names = Object.keys(vault).sort();
    if (names.length === 0) {
      console.error('(cofre vazio)');
      return;
    }
    for (const name of names) {
      const e = vault[name];
      const meta = [e.issuer, e.label].filter(Boolean).join(' / ') || '-';
      console.log(`${name}\t${meta}\t${e.algorithm} ${e.digits}dig ${e.period}s`);
    }
    return;
  }

  if ('remove' in args || 'delete' in args) {
    const name = normalizeName(args.remove ?? args.delete);
    const vault = loadVault();
    if (!(name in vault)) throw new Error(`conta "${name}" nao existe no cofre`);
    delete vault[name];
    const path = saveVault(vault);
    console.error(`conta "${name}" removida de ${path}`);
    return;
  }

  let config;
  const positional = args._[0];

  if ('use' in args) {
    const name = normalizeName(args.use);
    const vault = loadVault();
    const entry = vault[name];
    if (!entry) throw new Error(`conta "${name}" nao existe no cofre (use --list para ver as salvas)`);
    config = {
      secret: entry.secret,
      label: entry.label ?? null,
      issuer: entry.issuer ?? null,
      digits: entry.digits ?? DEFAULTS.digits,
      period: entry.period ?? DEFAULTS.period,
      algorithm: entry.algorithm ?? DEFAULTS.algorithm,
    };
  } else if (args.image) {
    const uri = await readQrFromImage(args.image);
    if (!uri.startsWith('otpauth://')) {
      throw new Error(`o QRCode nao contem um otpauth:// (conteudo lido: ${uri.slice(0, 80)})`);
    }
    config = parseOtpauth(uri);
  } else if (args.uri || (positional && positional.startsWith('otpauth://'))) {
    config = parseOtpauth(args.uri || positional);
  } else if (args.secret) {
    config = {
      secret: args.secret,
      label: null,
      issuer: null,
      digits: args.digits ? Number(args.digits) : DEFAULTS.digits,
      period: args.period ? Number(args.period) : DEFAULTS.period,
      algorithm: args.algorithm || DEFAULTS.algorithm,
    };
  } else {
    throw new Error(`nenhuma entrada valida.\n\n${usage()}`);
  }

  // --- Persistir no cofre, se pedido (--save) --------------------------------
  if ('save' in args) {
    const name = normalizeName(args.save);
    // valida o secret antes de gravar: falha aqui evita salvar lixo.
    generateTotp({ ...config, forTime: Date.now() });
    const vault = loadVault();
    vault[name] = {
      secret: config.secret,
      label: config.label ?? null,
      issuer: config.issuer ?? null,
      digits: config.digits,
      period: config.period,
      algorithm: config.algorithm,
      savedAt: new Date().toISOString(),
    };
    const path = saveVault(vault);
    console.error(`conta "${name}" salva em ${path} (chmod 600)`);
  }

  const { code, remaining, seconds } = generateTotp({ ...config, forTime: Date.now() });

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          code,
          remaining,
          digits: config.digits,
          period: config.period,
          algorithm: config.algorithm,
          issuer: config.issuer,
          label: config.label,
          generatedAt: new Date(seconds * 1000).toISOString(),
        },
        null,
        2
      )
    );
  } else {
    console.log(code);
    console.error(`(valido por mais ${remaining}s)`);
  }
}

main().catch((err) => {
  console.error(`erro: ${err.message}`);
  process.exit(1);
});
