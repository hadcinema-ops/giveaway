import { PublicKey } from "@solana/web3.js";

// naive LP/burn filters; extend as needed
const DENYLIST = new Set([
  // add LP vaults, burn, program-owned, etc…
]);

export function weightedRandomIndex(weights) {
  const total = weights.reduce((a,b)=>a+b,0);
  let r = Math.random()*total;
  for (let i=0;i<weights.length;i++) { r -= weights[i]; if (r<=0) return i; }
  return weights.length-1;
}

// Returns [{ owner: base58, amount: number(ui) }]
export async function getHoldersWeighted({ connection, mint }) {
  const largest = await connection.getTokenLargestAccounts(mint);
  const accounts = largest.value || [];
  const out = [];
  for (const acc of accounts) {
    try {
      const info = await connection.getParsedAccountInfo(new PublicKey(acc.address));
      const owner = info.value?.data?.parsed?.info?.owner;
      const amount = Number(info.value?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
      if (!owner || amount <= 0) continue;
      if (DENYLIST.has(owner)) continue;
      out.push({ owner, amount });
    } catch {}
  }
  // Fallback: if empty (brand new token), use dev wallet so animation still runs
  return out.length ? out : [{ owner: (await (await import("dotenv")).config(), process.env.DEV_PUBLIC_KEY), amount: 1 }];
}
