# Single-Wallet Mode

This backend is configured to use **one wallet** (the DEV wallet) for everything:

- Signs all transactions (claim, swap, airdrop)
- Receives the 10% marketing cut

## Required env

```
MINT=<TOKEN_MINT>
DEV_WALLET=<DEV_WALLET_PUBKEY>
DEV_SECRET_KEY_B58=<BASE58_PRIVKEY_OF_DEV_WALLET>
RPC_URL=https://<YOUR_RPC>
ENTRY_MODE=holders
```

> Remove OPS_SECRET_KEY_B58. It's no longer used.
