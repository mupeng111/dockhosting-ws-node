// Nezha probe launcher: downloads nezha-agent and runs it.
// Env: NZ_SERVER (host:port), NZ_CLIENT_SECRET, NZ_TLS (true/false)
// No system unzip needed: minimal ZIP extractor using built-in zlib.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const BIN_DIR = path.join(__dirname, 'bin');
const AGENT_BIN = path.join(BIN_DIR, 'nezha-agent');
const DOWNLOAD_URL = 'https://github.com/nezhahq/agent/releases/latest/download/nezha-agent_linux_amd64.zip';

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const f = fs.createWriteStream(dest);
      res.pipe(f);
      f.on('finish', () => f.close(resolve));
      f.on('error', reject);
    }).on('error', reject);
  });
}

// Minimal ZIP extractor: finds entry named `wanted` (or first file) and writes it out.
function extractZip(zipPath, wanted, outPath) {
  const buf = fs.readFileSync(zipPath);
  let off = 0;
  while (off + 30 < buf.length) {
    if (buf.readUInt32LE(off) !== 0x04034b50) break;
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.toString('utf8', off + 30, off + 30 + nameLen);
    const dataOff = off + 30 + nameLen + extraLen;
    const comp = buf.subarray(dataOff, dataOff + compSize);
    if (name === wanted || (wanted === null && !name.endsWith('/'))) {
      const raw = method === 8 ? zlib.inflateRawSync(comp) : method === 0 ? comp
        : (() => { throw new Error('unsupported zip method ' + method); })();
      fs.writeFileSync(outPath, raw, { mode: 0o755 });
      return name;
    }
    off = dataOff + compSize;
  }
  throw new Error('entry not found in zip: ' + wanted);
}

async function ensureAgent() {
  if (fs.existsSync(AGENT_BIN)) return;
  console.log('[nezha] downloading agent...');
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const zipPath = path.join(BIN_DIR, 'agent.zip');
  await download(DOWNLOAD_URL, zipPath);
  const entry = extractZip(zipPath, 'nezha-agent', AGENT_BIN);
  fs.chmodSync(AGENT_BIN, 0o755);
  fs.unlinkSync(zipPath);
  console.log('[nezha] agent ready (' + entry + ')');
}

async function main() {
  const server = process.env.NZ_SERVER;
  const secret = process.env.NZ_CLIENT_SECRET;
  const useTls = String(process.env.NZ_TLS).toLowerCase() === 'true';
  if (!server || !secret) {
    console.error('[nezha] missing NZ_SERVER or NZ_CLIENT_SECRET');
    process.exit(1);
  }
  await ensureAgent();
  // nezha-agent v2 uses a YAML config file (no -s/-p flags)
  const crypto = require('crypto');
  const uuid = crypto.randomUUID();
  const cfg = [
    `client_secret: ${secret}`,
    `server: ${server}`,
    `tls: ${useTls}`,
    `uuid: ${uuid}`,
    `debug: false`,
    `disable_auto_update: true`,
    `report_delay: 3`,
  ].join('\n') + '\n';
  const cfgPath = path.join(BIN_DIR, 'config.yml');
  fs.writeFileSync(cfgPath, cfg);
  console.log(`[nezha] starting agent -> ${server} (tls=${useTls})`);
  const child = spawn(AGENT_BIN, ['-c', cfgPath], { stdio: 'inherit' });
  child.on('exit', (code) => {
    console.log(`[nezha] agent exited (${code}), restarting in 10s...`);
    setTimeout(main, 10000);
  });
  child.on('error', (e) => {
    console.error('[nezha] spawn error:', e.message);
    setTimeout(main, 10000);
  });
}

main().catch((e) => { console.error('[nezha] fatal:', e.message); process.exit(1); });

// Keep HTTP port open so the platform health check passes
require('http').createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
}).listen(parseInt(process.env.PORT || '8080', 10));
