#!/usr/bin/env node
/**
 * One-shot setup: connects this TradingView MCP server to Claude Code and
 * checks that it works. Safe to run more than once.
 *
 *   node scripts/setup.js
 *
 * 1. Writes .mcp.json in this folder (project-scoped server — Claude Code picks
 *    it up when you open a session in this folder).
 * 2. Also registers it user-wide with `claude mcp add --scope user` when the
 *    claude CLI is on PATH (so it works from any folder).
 * 3. Starts the server once and confirms it lists its tools.
 * 4. Installs the skills (skills/*) and agents (agents/*) into ~/.claude so
 *    Claude Code can use them from any folder.
 * 5. Checks whether TradingView is reachable on the debug port.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, cpSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';
import http from 'http';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, 'src', 'server.js');
const PORT = Number(process.env.TV_CDP_PORT) || 9222;
const ok = (m) => console.log(`  [OK]  ${m}`);
const warn = (m) => console.log(`  [!!]  ${m}`);
const info = (m) => console.log(`        ${m}`);

console.log('\n=== TradingView MCP - configuracion ===\n');

// 1. Project-scoped .mcp.json (merge, don't clobber other servers)
const mcpPath = join(ROOT, '.mcp.json');
let cfg = { mcpServers: {} };
if (existsSync(mcpPath)) {
  try { cfg = JSON.parse(readFileSync(mcpPath, 'utf8')); cfg.mcpServers ||= {}; } catch { /* rewrite a broken file */ }
}
cfg.mcpServers.tradingview = { command: 'node', args: [SERVER] };
writeFileSync(mcpPath, JSON.stringify(cfg, null, 2) + '\n');
ok(`Servidor guardado en ${mcpPath}`);

// 2. User-scoped registration via the claude CLI (best effort)
const shell = process.platform === 'win32';
const which = spawnSync(shell ? 'where' : 'which', ['claude'], { encoding: 'utf8', shell });
if (which.status === 0) {
  spawnSync('claude', ['mcp', 'remove', '--scope', 'user', 'tradingview'], { stdio: 'ignore', shell });
  const add = spawnSync('claude', ['mcp', 'add', '--scope', 'user', 'tradingview', '--', 'node', SERVER], { encoding: 'utf8', shell });
  if (add.status === 0) ok('Registrado en Claude Code para todas las carpetas');
  else warn(`No se pudo registrar con el comando claude (no pasa nada, .mcp.json alcanza): ${(add.stderr || '').trim().split('\n')[0]}`);
} else {
  info('Comando "claude" no encontrado: se usa .mcp.json (abre Claude Code en esta carpeta).');
}

// 2b. Skills + agents → ~/.claude (user scope: available in every folder)
const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
try {
  const skillsSrc = join(ROOT, 'skills');
  const skills = readdirSync(skillsSrc, { withFileTypes: true }).filter(d => d.isDirectory() && existsSync(join(skillsSrc, d.name, 'SKILL.md'))).map(d => d.name);
  mkdirSync(join(claudeHome, 'skills'), { recursive: true });
  for (const name of skills) cpSync(join(skillsSrc, name), join(claudeHome, 'skills', name), { recursive: true, force: true });
  ok(`${skills.length} skills instalados en ${join(claudeHome, 'skills')}`);
  info(skills.map(n => '/' + n).join('  '));
  const agentsSrc = join(ROOT, 'agents');
  if (existsSync(agentsSrc)) {
    const agents = readdirSync(agentsSrc).filter(f => f.endsWith('.md'));
    mkdirSync(join(claudeHome, 'agents'), { recursive: true });
    for (const f of agents) cpSync(join(agentsSrc, f), join(claudeHome, 'agents', f), { force: true });
    ok(`${agents.length} agente(s) instalado(s) en ${join(claudeHome, 'agents')}`);
  }
} catch (err) {
  warn(`No se pudieron instalar los skills: ${err.message}`);
}

// 3. Start the server and list tools over MCP stdio
async function checkServer() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], { cwd: ROOT, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    const done = (v) => { clearTimeout(t); child.kill(); resolve(v); };
    const t = setTimeout(() => done(null), 15000);
    child.stdout.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n')) {
        try { const m = JSON.parse(line); if (m.id === 2) return done(m.result?.tools?.length ?? null); } catch { /* partial line */ }
      }
    });
    child.on('error', () => done(null));
    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'setup', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  });
}
const tools = await checkServer();
if (tools) ok(`El servidor funciona: ${tools} herramientas disponibles`);
else { warn('El servidor no respondio. Ejecuta "npm install" en esta carpeta y vuelve a intentar.'); process.exitCode = 1; }

// 4. TradingView reachable?
const cdp = await new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/version', timeout: 2000 }, (res) => {
    let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
  });
  req.on('error', () => resolve(null));
  req.on('timeout', () => { req.destroy(); resolve(null); });
});
if (cdp) ok(`TradingView conectado en el puerto ${PORT}`);
else info(`TradingView todavia no esta abierto en modo conexion (puerto ${PORT}). El instalador lo abre a continuacion.`);

console.log(`
=== Listo ===
  1. Abre Claude Desktop > pestana "Code"
  2. Elige "Local" y la carpeta:
       ${ROOT}
  3. Si te pregunta si confias en el servidor "tradingview", acepta.
  4. Escribe:  verifica la conexion con TradingView
  5. Prueba los skills:  /precision-entry   /trade-plan   /strategy-lab
`);
