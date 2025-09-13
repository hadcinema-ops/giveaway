import { claimCreatorFees } from './pump.js';
import { marketBuy } from './swap.js';
import { burnPurchased } from './burn.js';
import { getStats, saveStats, ensureDecimals, toUi } from './stats.js';

let inFlight = false;
let lastRun = { startedAt: 0, steps: [] };
export function getLastRun() { return lastRun; }
function step(name, data) { lastRun.steps.push({ t: Date.now(), name, data }); console.log(`[cycle] ${name}`, data ?? ''); }

export async function flywheelCycle() {
  if (inFlight) { console.log('[cycle] already running, skipping'); return { skipped: true }; }
  inFlight = true;
  lastRun = { startedAt: Date.now(), steps: [] };
  try {
    const stats = await getStats();
    await ensureDecimals();
    const decimals = stats.config.decimals ?? 6;
    step('begin', { totals: stats.totals, decimals });

    const claimSig = await claimCreatorFees();
    step('claim', { claimSig });
    if (claimSig) {
      stats.history.unshift({ ts: Date.now(), type: 'claim', signature: claimSig, link: `https://solscan.io/tx/${claimSig}` });
      stats.totals.claims += 1;
    }

    const buy = await marketBuy();
    step('buy', buy);
    if (buy?.signature) {
      const outRaw = Math.max(0, Math.floor(Number(buy.tokensOut || 0)));
      const outUi = toUi(outRaw, decimals);
      stats.history.unshift({ ts: Date.now(), type: 'buy', signature: buy.signature, link: `https://solscan.io/tx/${buy.signature}`, amountInSol: buy.amountInSol, estTokensOut: outUi, tokensOutRaw: outRaw });
      stats.totals.solSpent += buy.amountInSol || 0;
      stats.totals.tokensBought += outUi;
      await saveStats(stats);
      step('saved-buy', { outRaw, outUi });
    }

    let burn = null;
    try {
      burn = await burnPurchased();
      step('burn', burn);
      if (burn?.signature) {
        stats.history.unshift({ ts: Date.now(), type: 'burn', signature: burn.signature, link: `https://solscan.io/tx/${burn.signature}`, amountTokens: burn.amountTokensUi, amountTokensRaw: burn.amountTokensRaw });
        stats.totals.tokensBurned += burn.amountTokensUi || 0;
      }
    } catch (e) {
      step('burn-error', { error: String(e) });
    }

    stats.history = stats.history.slice(0, 200);
    await saveStats(stats);
    step('done', { totals: stats.totals });

    return { claimSig, buy, burn };
  } catch (e) {
    step('error', { error: String(e) });
    throw e;
  } finally {
    inFlight = false;
  }
}

export async function forceSync() {
  lastRun = { startedAt: Date.now(), steps: [] };
  const stats = await getStats();
  await ensureDecimals();
  step('force-sync-start');
  let burn = null;
  try {
    burn = await burnPurchased();
    step('force-sync-burn', burn);
    if (burn?.signature) {
      stats.history.unshift({ ts: Date.now(), type: 'burn', signature: burn.signature, link: `https://solscan.io/tx/${burn.signature}`, amountTokens: burn.amountTokensUi, amountTokensRaw: burn.amountTokensRaw });
      stats.totals.tokensBurned += burn.amountTokensUi || 0;
    }
  } catch (e) {
    step('force-sync-error', { error: String(e) });
  }
  await saveStats(stats);
  step('force-sync-done');
  return { burn };
}
