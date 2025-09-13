// swap.js v7.2 — robust buy measurement (meta + dual-ATA)
import axios from 'axios';
import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  getAssociatedTokenAddress,
  getAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { getStats } from './stats.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

function keypairFromEnv() {
  const secret = process.env.SIGNER_SECRET_KEY;
  if (!secret) throw new Error('SIGNER_SECRET_KEY missing');
  return Keypair.fromSecretKey(bs58.decode(secret));
}
function rpc() { const url = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'; return new Connection(url, 'confirmed'); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getAllTokenBalances(conn, mintPk, ownerPk) {
  const ataClassic = await getAssociatedTokenAddress(mintPk, ownerPk, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  let accClassic = null;
  try { accClassic = await getAccount(conn, ataClassic, undefined, TOKEN_PROGRAM_ID); } catch {}
  const ataT22 = await getAssociatedTokenAddress(mintPk, ownerPk, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  let accT22 = null;
  try { accT22 = await getAccount(conn, ataT22, undefined, TOKEN_2022_PROGRAM_ID); } catch {}
  const amtClassic = accClassic ? Number(accClassic.amount) : 0;
  const amtT22 = accT22 ? Number(accT22.amount) : 0;
  return { classic: { ata: ataClassic, amount: amtClassic }, t22: { ata: ataT22, amount: amtT22 }, total: amtClassic + amtT22 };
}

async function measureOutRawViaMeta(conn, sig, mint, owner) {
  for (let i = 0; i < 8; i++) {
    const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
    if (tx?.meta) {
      const pre = (tx.meta.preTokenBalances || []).filter(b => b.mint === mint && b.owner === owner.toBase58());
      const post = (tx.meta.postTokenBalances || []).filter(b => b.mint === mint && b.owner === owner.toBase58());
      const preAmt = pre.reduce((s,b) => s + Number(b.uiTokenAmount.amount), 0);
      const postAmt = post.reduce((s,b) => s + Number(b.uiTokenAmount.amount), 0);
      const delta = Math.max(0, postAmt - preAmt);
      if (delta > 0) return delta;
    }
    await sleep(500);
  }
  return 0;
}

export async function marketBuy() {
  const conn = rpc();
  const kp = keypairFromEnv();
  const outputMint = (await getStats()).config.mint;
  if (!outputMint) throw new Error('MINT_ADDRESS not set');
  const mintPk = new PublicKey(outputMint);

  const before = await getAllTokenBalances(conn, mintPk, kp.publicKey);

  const reserveLamports = BigInt(Math.floor(Number(process.env.SOL_RESERVE || '0.02') * 1e9));
  const balance = BigInt(await conn.getBalance(kp.publicKey, { commitment: 'confirmed' }));
  const spendable = balance > reserveLamports ? (balance - reserveLamports) : 0n;
  const minLamports = BigInt(Math.floor(Number(process.env.MIN_SWAP_SOL || '0.001') * 1e9));
  if (spendable < minLamports) { console.log('[swap] not enough SOL'); return null; }

  // Try Jupiter
  try {
    const slippageBps = Number(process.env.SLIPPAGE_BPS || 300);
    const quoteResp = await axios.get('https://quote-api.jup.ag/v6/quote', {
      params: { inputMint: SOL_MINT, outputMint, amount: Number(spendable), slippageBps }
    });
    const quote = quoteResp.data;
    if (quote?.routes?.length) {
      const { data: swapTx } = await axios.post('https://quote-api.jup.ag/v6/swap', {
        quoteResponse: quote,
        userPublicKey: kp.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        prioritizationFeeLamports: Number(process.env.PRIORITIZATION_FEE_LAMPORTS || 0)
      }, { headers: { 'Content-Type': 'application/json' } });
      const tx = VersionedTransaction.deserialize(Buffer.from(swapTx.swapTransaction, 'base64'));
      tx.sign([kp]);
      const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
      console.log('[buy:jup] sent', sig);
      let outRaw = await measureOutRawViaMeta(conn, sig, outputMint, kp.publicKey);
      if (outRaw === 0) {
        for (let i=0;i<10 && outRaw===0;i++) {
          const after = await getAllTokenBalances(conn, mintPk, kp.publicKey);
          outRaw = Math.max(0, after.total - before.total);
          await sleep(400);
        }
      }
      return { signature: sig, amountInSol: Number(spendable) / 1e9, tokensOut: outRaw };
    }
  } catch {}

  // Fall back to PumpPortal Local buy
  try {
    const minSol = Number(process.env.MIN_PUMP_SOL || '0.01');
    const targetSol = Number(process.env.TARGET_PUMP_SOL || '0');
    const spendableSol = Number(spendable) / 1e9;
    let amountSol = spendableSol;
    if (targetSol > 0) amountSol = Math.min(amountSol, targetSol);
    if (amountSol + 0.0005 < minSol) { console.log('[swap] spendable below MIN_PUMP_SOL; skipping'); return null; }
    amountSol = Math.max(minSol, amountSol - 0.0005);
    amountSol = Math.max(0, Math.min(amountSol, spendableSol));
    amountSol = Number(amountSol.toFixed(6));

    const { data, status } = await axios.post('https://pumpportal.fun/api/trade-local', {
      publicKey: kp.publicKey.toBase58(),
      action: 'buy',
      mint: outputMint,
      amount: amountSol.toFixed(6),
      denominatedInSol: true,
      slippage: Number(process.env.PUMP_SLIPPAGE_PCT || '3'),
      priorityFee: Number(process.env.PRIORITY_FEE_SOL || '0')
    }, { responseType: 'arraybuffer' });

    if (status !== 200) return null;
    const tx = VersionedTransaction.deserialize(new Uint8Array(data));
    tx.sign([kp]);
    const sig = await conn.sendTransaction(tx, { maxRetries: 3 });
    console.log('[buy:pump] sent', sig);

    let outRaw = await measureOutRawViaMeta(conn, sig, outputMint, kp.publicKey);
    if (outRaw === 0) {
      for (let i=0;i<10 && outRaw===0;i++) {
        const after = await getAllTokenBalances(conn, mintPk, kp.publicKey);
        outRaw = Math.max(0, after.total - before.total);
        await sleep(400);
      }
    }
    return { signature: sig, amountInSol: amountSol, tokensOut: outRaw };
  } catch (e) {
    const msg = e?.response?.data ? Buffer.from(e.response.data).toString('utf8') : (e.message || String(e));
    console.error('[swap] error', msg);
    return null;
  }
}
