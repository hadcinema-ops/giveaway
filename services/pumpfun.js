import axios from "axios";
import { VersionedTransaction } from "@solana/web3.js";

/**
 * Claims Pump.fun creator fees into the dev wallet using Pump Portal Local TX API.
 * Returns { lamportsClaimed: BigInt } (best-effort, net of tx fee).
 * Requires DEV_SECRET_KEY loaded in the parent process (already used by backend/index.js).
 */
export async function claimCreatorFees({ connection, devKeypair, mint }) {
  try {
    const before = await connection.getBalance(devKeypair.publicKey);
    const { data, status } = await axios.post("https://pumpportal.fun/api/trade-local", {
      publicKey: devKeypair.publicKey.toBase58(),
      action: "collectCreatorFee"
    }, { responseType: "arraybuffer" });
    if (status !== 200) throw new Error("trade-local failed");
    const tx = VersionedTransaction.deserialize(new Uint8Array(data));
    tx.sign([devKeypair]);
    const sig = await connection.sendTransaction(tx, { maxRetries: 3, skipPreflight: true });
    await connection.confirmTransaction(sig, "confirmed");
    const after = await connection.getBalance(devKeypair.publicKey);
    const delta = Math.max(0, after - before);
    return { lamportsClaimed: BigInt(delta), signature: sig };
  } catch (e) {
    const msg = e?.response?.data ? Buffer.from(e.response.data).toString("utf8") : (e.message || String(e));
    console.error("[claimCreatorFees] error", msg);
    return { lamportsClaimed: 0n, error: msg };
  }
}
