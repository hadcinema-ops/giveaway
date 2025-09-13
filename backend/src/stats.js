import { promises as fs } from 'fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

const DB_PATH = process.env.DB_PATH || './db.json';
const conn = new Connection(process.env.RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');

const defaultStats = {
  config: {
    mint: process.env.MINT_ADDRESS || '',
    dev: process.env.DEV_PUBLIC_KEY || '',
    network: (process.env.RPC_URL || '').includes('devnet') ? 'devnet' : 'mainnet',
    decimals: null
  },
  totals: { claims: 0, solSpent: 0, tokensBought: 0, tokensBurned: 0 },
  history: []
};

export async function initStats() {
  try { await fs.access(DB_PATH); } catch { await fs.writeFile(DB_PATH, JSON.stringify(defaultStats, null, 2)); }
  try { await ensureDecimals(); } catch {}
}
export async function getStats() {
  try { const raw = await fs.readFile(DB_PATH, 'utf8'); return JSON.parse(raw); }
  catch { return defaultStats; }
}
export async function saveStats(obj) { await fs.writeFile(DB_PATH, JSON.stringify(obj, null, 2)); }

export function toUi(rawAmount, decimals) {
  const d = Math.max(0, Math.min(12, Number(decimals) || 0));
  return Number(rawAmount) / Math.pow(10, d);
}

export async function ensureDecimals() {
  const stats = await getStats();
  if (stats.config.decimals != null) return stats.config.decimals;
  const mint = stats.config.mint;
  if (!mint) return null;
  const mintPk = new PublicKey(mint);
  let info = null;
  try { info = await getMint(conn, mintPk, undefined, TOKEN_PROGRAM_ID); } catch {}
  if (!info) { try { info = await getMint(conn, mintPk, undefined, TOKEN_2022_PROGRAM_ID); } catch {} }
  if (info) {
    stats.config.decimals = info.decimals;
    await saveStats(stats);
    console.log('[decimals] discovered', info.decimals);
    return info.decimals;
  } else {
    console.log('[decimals] could not fetch; defaulting to 6');
    stats.config.decimals = 6;
    await saveStats(stats);
    return 6;
  }
}

export async function getConfigPublic() {
  const s = await getStats();
  return s.config;
}
