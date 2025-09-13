import axios from 'axios';
import { Connection, VersionedTransaction, Keypair } from '@solana/web3.js';
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

// Claim Pump.fun creator fees using the Local Transaction API (no API key)
export async function claimCreatorFees() {
  try {
    const kp = keypairFromEnv();
    const conn = rpc();

    const { data, status } = await axios.post(
      'https://pumpportal.fun/api/trade-local',
      { publicKey: kp.publicKey.toBase58(), action: 'collectCreatorFee' },
      { responseType: 'arraybuffer' }
    );
    if (status !== 200) throw new Error('trade-local failed');

    const tx = VersionedTransaction.deserialize(new Uint8Array(data));
    tx.sign([kp]);

    const sig = await conn.sendTransaction(tx, { maxRetries: 3 });
    console.log('[pump-local] claimed creator fees:', sig);
    return sig;
  } catch (e) {
    const msg = e?.response?.data ? Buffer.from(e.response.data).toString('utf8') : (e.message || String(e));
    console.error('[pump-local] claim error', msg);
    return null;
  }
}
