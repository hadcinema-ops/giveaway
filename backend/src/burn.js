// burn.js v7.2 — true burn only (auto-detect Token-2022 vs SPL) + robust send
import {
  Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getMint,
  getAccount,
  createBurnCheckedInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';

function rpc() {
  const url = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
  return new Connection(url, 'confirmed');
}
function keypairFromEnv() {
  const secret = process.env.SIGNER_SECRET_KEY;
  if (!secret) throw new Error('SIGNER_SECRET_KEY missing');
  return Keypair.fromSecretKey(bs58.decode(secret));
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function probeBalanceAndMint(conn, mintPk, ownerPk) {
  async function probe(programId) {
    const ata = await getAssociatedTokenAddress(mintPk, ownerPk, false, programId, ASSOCIATED_TOKEN_PROGRAM_ID);
    try {
      const acc = await getAccount(conn, ata, undefined, programId);
      const mint = await getMint(conn, mintPk, undefined, programId);
      return { programId, ata, acc, mint, amount: Number(acc.amount), decimals: mint.decimals };
    } catch {
      return { programId, ata, acc: null, mint: null, amount: 0, decimals: 0 };
    }
  }
  const t22 = await probe(TOKEN_2022_PROGRAM_ID);
  const spl = await probe(TOKEN_PROGRAM_ID);
  return (t22.amount > 0) ? t22 : (spl.amount > 0 ? spl : null);
}

export async function burnPurchased() {
  const conn = rpc();
  const kp = keypairFromEnv();
  const mintPk = new PublicKey(process.env.MINT_ADDRESS);

  for (let i = 0; i < 10; i++) await wait(500);

  const target = await probeBalanceAndMint(conn, mintPk, kp.publicKey);
  if (!target || target.amount <= 0) {
    console.log('[burn] nothing to burn (no positive balance found)');
    return null;
  }

  const { programId, ata, amount, decimals } = target;

  const burnIx = createBurnCheckedInstruction(
    ata, mintPk, kp.publicKey, BigInt(amount), decimals, [], programId
  );

  const pri = Number(process.env.PRIORITY_FEE_MICROLAMPORTS || '2000');
  const cuIx = pri ? ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.max(0, pri) }) : null;

  const tx = new Transaction();
  if (cuIx) tx.add(cuIx);
  tx.add(burnIx);
  tx.feePayer = kp.publicKey;

  try {
    const sim = await conn.simulateTransaction(tx, [kp]);
    if (sim?.value?.err) {
      console.error('[burn] simulate err:', sim.value.err);
      if (sim?.value?.logs) console.error('[burn] logs:', sim.value.logs);
      throw new Error('Simulation failed');
    }
  } catch (e) {}

  // robust send: set recent blockhash & confirm
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('finalized');
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.sign(kp);

  const sig = await sendAndConfirmTransaction(conn, tx, [kp], {
    commitment: 'confirmed',
    skipPreflight: false,
    maxRetries: 3,
  });

  return { signature: sig, amountTokensRaw: amount, amountTokensUi: amount / (10 ** decimals) };
}
