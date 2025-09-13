import fetch from "cross-fetch";
import { VersionedTransaction } from "@solana/web3.js";

export async function jupQuote({ inputMint, outputMint, amount, slippageBps, baseUrl }) {
  const url = `${baseUrl}/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Jupiter quote failed: ${await res.text()}`);
  return res.json();
}

export async function jupSwap({ connection, user, quoteResponse, baseUrl }) {
  const res = await fetch(`${baseUrl}/v6/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: user.publicKey.toBase58(),
      wrapAndUnwrapSol: true
    })
  });
  if (!res.ok) throw new Error(`Jupiter swap failed: ${await res.text()}`);
  const { swapTransaction } = await res.json();
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([user]);
  const sig = await connection.sendTransaction(tx, { skipPreflight: true });
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}
