# solana-tx-simulator

Simulate any Solana transaction from a Solana Explorer Inspector URL. Skips signature verification, replaces the blockhash, and prints a formatted breakdown of accounts, logs, token transfers, and CPI call flow.

## Install

```bash
npm install
```

## Usage

```bash
# Interactive — prompts for URL
npx tsx simulate_tx.ts

# Pass URL as argument
npx tsx simulate_tx.ts 'https://explorer.solana.com/tx/inspector?signatures=...&message=...'

# Save output to file
npx tsx simulate_tx.ts 'URL' > output.txt
```

## What it does

1. **Parses** the base64-encoded transaction message from an Explorer Inspector URL (handles double/triple percent-encoding)
2. **Resolves** Address Lookup Tables (v0 transactions) to show all accounts
3. **Simulates** the transaction on mainnet with `sigVerify: false` and `replaceRecentBlockhash: true`
4. **Prints** a formatted report:
   - Account keys with signer/writable annotations
   - ALT-resolved accounts
   - Full program logs (categorized by type)
   - Token transfers (SOL and SPL)
   - CPI instruction flow with depth indentation

## Example output

```
╔══════════════════════════════════════╗
║       TRANSACTION DETAILS            ║
╚══════════════════════════════════════╝

Static Account Keys:
  0: 9auLG3T8oU6u6bDymqFWCLwA6uTdvVg9uDUByJ3FYrP5 [SIGNER] [WRITABLE]
  1: 55VUchVexE3ujeCu8zB6qPhmyo1Lhg9ahAdHqn32P7W [SIGNER] [WRITABLE]
  ...

╔══════════════════════════════════════╗
║       SIMULATION RESULTS             ║
╚══════════════════════════════════════╝

✅ Simulation SUCCESS

Compute units consumed: 38426

┌─── INSTRUCTION FLOW ───────────────────┐

  → magnaSHyv8zzKJJmr8NSz5JXmtdGDTTFPEADmvNAwbj (depth 1)
    → 11111111111111111111111111111111 (depth 2)
    → ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL (depth 2)
      → TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA (depth 3)

└────────────────────────────────────────┘
```

## Requirements

- Node.js 18+
- Access to a Solana RPC endpoint (defaults to `https://api.mainnet-beta.solana.com`)
