// Nezha probe launcher: downloads nezha-agent and runs it.
// Env: NZ_SERVER (host:port), NZ_CLIENT_SECRET, NZ_TLS (true/false)
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

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

async function ensureAgent() {
  if (fs.existsSync(AGENT_BIN)) return;
  console.log('[nezha] downloading agent...');
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const zipPath = path.join(BIN_DIR, 'agent.zip');
  await download(DOWNLOAD_URL, zipPath);
  execSync(`cd "${BIN_DIR}" && unzip -o agent.zip && chmod +x nezha-agent`, { stdio: 'inherit' });
  fs.unlinkSync(zipPath);
  console.log('[nezha] agent ready');
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
  const args = ['-s', server, '-p', secret];
  if (useTls) args.push('--tls');
  args.push('--disable-auto-update');
  console.log(`[nezha] starting agent -> ${server} (tls=${useTls})`);
  const child = spawn(AGENT_BIN, args, { stdio: 'inherit' });
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
