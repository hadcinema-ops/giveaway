import "dotenv/config";
import express from "express";
import morgan from "morgan";
import bs58 from "bs58";
import fetch from "cross-fetch";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, getOrCreateAssociatedTokenAccount, createTransferInstruction } from "@solana/spl-token";
import { jupQuote, jupSwap } from "./services/jupiter.js";
import { claimCreatorFees } from "./services/pumpfun.js";
import { weightedRandomIndex, getHoldersWeighted } from "./services/holders.js";

// ---- Basic server ----
const app = express();
app.use(morgan("tiny"));
const PORT = process.env.PORT || 8080;
const ENTRY_MODE = (process.env.ENTRY_MODE || 'holders').toLowerCase();
const ORIGIN = process.env.PUBLIC_FRONTEND_ORIGIN || "*";
app.use((req,res,next)=>{
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-key");
  next();
});

// ---- Chain setup ----
const connection = new Connection(process.env.RPC_URL, "confirmed");
const MINT = new PublicKey(process.env.MINT_ADDRESS);
const DEV_PUBLIC_KEY = new PublicKey(process.env.DEV_PUBLIC_KEY);
let devKeypair = null;
try {
  const raw = (process.env.DEV_SECRET_KEY || "").trim();
  if (raw.startsWith("[")) {
    devKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } else if (raw) {
    devKeypair = Keypair.fromSecretKey(bs58.decode(raw));
  }
} catch (e) {
  console.warn("DEV_SECRET_KEY not provided or invalid. Backend will still serve stats but won't sign swaps/airdrops.");
}

const RESERVE_BPS = Number(process.env.RESERVE_RATE_BPS || 1000);
const CYCLE_SECONDS = Number(process.env.CYCLE_SECONDS || 1200);
const MIN_SOL = Number(process.env.MIN_SOL_TO_RUN || 0.02);
const JUP_BASE = process.env.JUPITER_BASE_URL || "https://quote-api.jup.ag";
const ADMIN_KEY = process.env.ADMIN_KEY || "";

// ---- State ----
let currentKeyword = null; let entrants = new Set();
const stateFile = "./state.json";
let state = {
  cycles: 0,
  totalLamportsBought: 0,
  totalTokensAirdropped: "0",
  totalUsdGiven: 0,
  lastCycles: [] // keep last 20
};
try { state = Object.assign(state, JSON.parse(await (await import("fs/promises")).readFile(stateFile, "utf8"))); } catch {}
const fs = (await import("fs/promises")).default;

function saveState() {
  return fs.writeFile(stateFile, JSON.stringify(state, null, 2));
}

// ---- SSE ----
const clients = new Set();
app.get("/events", (req,res)=>{
  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  res.flushHeaders();
  res.write(`event: hello\n`);
  res.write(`data: {"ok":true}\n\n`);
  clients.add(res);
  req.on("close", ()=>clients.delete(res));
});
function broadcast(event) {
  const payload = `event: cycle\ndata: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) { try { c.write(payload); } catch {} }
}

// ---- Public stats ----
app.get("/public/stats", async (req,res)=>{
  const balLamports = await connection.getBalance(DEV_PUBLIC_KEY);
  res.json({
    dev: DEV_PUBLIC_KEY.toBase58(),
    mint: MINT.toBase58(),
    sol: balLamports / LAMPORTS_PER_SOL,
    cycleSeconds: CYCLE_SECONDS,
    reserveRateBps: RESERVE_BPS,
    totals: state
  });
});

// ---- Admin: fire a test cycle ----
app.post("/admin/test", async (req,res)=>{
  if ((req.headers["x-admin-key"]||"") !== ADMIN_KEY) return res.status(401).json({error:"unauthorized"});
  try { await runCycle(); res.json({ok:true}); } catch(e){ res.status(500).json({error:String(e)}) }
});


// ---- Join endpoint: chat-relay or manual can call this to register an entrant ----
app.post("/join", express.json(), async (req,res)=>{
  try{
    const { owner, message } = req.body || {};
    if (!owner || !message) return res.status(400).json({error:"owner and message required"});
    if (!currentKeyword) return res.status(409).json({error:"no active keyword"});
    if (!message.toLowerCase().includes(String(currentKeyword).toLowerCase())) return res.status(403).json({error:"keyword not found"});
    // Verify owner holds the token
    const ata = await connection.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: MINT });
    const total = ata.value.reduce((acc,accInfo)=>{
      const ui = Number(accInfo.account.data.parsed.info.tokenAmount.uiAmount || 0);
      return acc + ui;
    }, 0);
    if (total <= 0) return res.status(403).json({error:"must hold token"});
    entrants.add(owner);
    res.json({ok:true, entrants: entrants.size});
  }catch(e){
    res.status(500).json({error:String(e)});
  }
});


app.listen(PORT, ()=>console.log("Flywheel backend on :" + PORT));

// ---- Helpers ----
async function airdropAll({ mint, fromKeypair, toOwner, amountRaw }) {
  const mintPk = new PublicKey(mint);
  const fromAta = await getOrCreateAssociatedTokenAccount(connection, fromKeypair, mintPk, fromKeypair.publicKey);
  const toAta = await getOrCreateAssociatedTokenAccount(connection, fromKeypair, mintPk, new PublicKey(toOwner));
  const { Transaction } = await import("@solana/web3.js");
  const ix = createTransferInstruction(fromAta.address, toAta.address, fromKeypair.publicKey, amountRaw);
  const tx = new Transaction().add(ix);
  tx.feePayer = fromKeypair.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(fromKeypair);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

// ---- Main cycle ----
async function runCycle() {
  if (ENTRY_MODE === 'keyword') { currentKeyword = Math.random().toString(36).slice(2,6).toUpperCase(); entrants = new Set(); } else { currentKeyword = null; entrants = new Set(); }
  try {
    // 1) Claim creator fees (user plugs real claim function)
    let lamportsClaimed = 0n;
    try {
      const res = await claimCreatorFees({ connection, devKeypair, mint: MINT });
      lamportsClaimed = BigInt(res?.lamportsClaimed || 0);
    } catch (e) {
      console.warn("claimCreatorFees skipped/failed:", e?.message || e);
    }

    // 2) Determine available SOL (balance or claimed amount; choose larger)
    const bal = await connection.getBalance(devKeypair?.publicKey || DEV_PUBLIC_KEY);
    const usable = Number((lamportsClaimed > 0n ? lamportsClaimed : BigInt(bal)));
    if (usable < MIN_SOL * LAMPORTS_PER_SOL) return;

    // 3) Split: reserve 10% (marketing), 90% buy
    const reserve = Math.floor(usable * RESERVE_BPS / 10_000);
    const toBuyLamports = usable - reserve;

    // 4) Jupiter quote + swap (SOL -> MINT)
    const quote = await jupQuote({
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: MINT.toBase58(),
      amount: toBuyLamports,
      slippageBps: 200,
      baseUrl: JUP_BASE
    });
    const swapSig = await jupSwap({ connection, user: devKeypair, quoteResponse: quote, baseUrl: JUP_BASE });
    const purchasedRaw = Number(quote.outAmount || quote.otherAmountThreshold || 0);

    // 5) Get holders (weighted by balance) and pick winner
    let holders = await getHoldersWeighted({ connection, mint: MINT });
    // Equal chance when ENTRY_MODE=holders: flatten weights
    if ((process.env.ENTRY_MODE||'holders').toLowerCase()==='holders') {
      holders = holders.map(h => ({ owner: h.owner, amount: 1 }));
    }
    if (ENTRY_MODE === 'keyword' && entrants.size>0) {
      const allow = new Set(Array.from(entrants));
      const filtered = holders.filter(h => allow.has(h.owner));
      if (filtered.length) holders = filtered;
    }
    if (!holders.length) throw new Error("No holders found");
    const weights = holders.map(h => h.amount);
    const idx = weightedRandomIndex(weights);
    const winner = holders[idx];

    // 6) Airdrop 100% of purchased tokens
    const dropSig = await airdropAll({ mint: MINT, fromKeypair: devKeypair, toOwner: winner.owner, amountRaw: purchasedRaw });

    // 7) Update state + broadcast
    state.cycles += 1;
    state.totalLamportsBought += toBuyLamports;
    // NOTE: we don't know token decimals here; treat purchasedRaw as raw w/ same decimals used by quote
    // You can fetch mint info & convert to ui amount for display (left simple for toddler-setup).
    state.totalTokensAirdropped = String(BigInt(state.totalTokensAirdropped) + BigInt(purchasedRaw));
    const entry = {
      ...(currentKeyword ? { keyword: currentKeyword } : {}),
      t: Date.now(),
      claimSig: claimRes?.signature || undefined,
      holders: holders,
      claimSig: res?.signature || undefined,
      reserveLamports: reserve,
      buyLamports: toBuyLamports,
      swapSig,
      dropSig,
      winner: winner.owner,
      purchasedRaw
    };
    state.lastCycles.unshift(entry);
    if (state.lastCycles.length > 20) state.lastCycles.pop();
    await saveState();

    broadcast({ ...entry, holdersCount: holders.length });
  } catch (e) {
    console.error("Cycle error", e);
    broadcast({ t: Date.now(), error: e.message || String(e) });
  }
}

// Timer
setInterval(runCycle, CYCLE_SECONDS * 1000);
