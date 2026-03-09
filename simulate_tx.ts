import {
  Connection,
  VersionedTransaction,
  VersionedMessage,
  MessageV0,
} from "@solana/web3.js";
import * as readline from "readline";

const RPC_URL = "https://api.mainnet-beta.solana.com";

function parseInspectorUrl(url: string): string {
  // URL may be double or triple percent-encoded from the explorer
  // Decode until we get a clean base64 string
  const parsed = new URL(url);
  let messageParam = parsed.searchParams.get("message");
  if (!messageParam) {
    throw new Error("No 'message' parameter found in URL");
  }

  // Keep decoding until stable (handles double/triple encoding)
  let prev = "";
  while (messageParam !== prev) {
    prev = messageParam;
    messageParam = decodeURIComponent(messageParam);
  }

  return messageParam;
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr, // use stderr so stdout stays clean for piping
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function isWritable(header: { numRequiredSignatures: number; numReadonlySignedAccounts: number; numReadonlyUnsignedAccounts: number }, totalStatic: number, index: number): boolean {
  const { numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts } = header;
  const numWritableSigners = numRequiredSignatures - numReadonlySignedAccounts;
  if (index < numWritableSigners) return true;
  if (index < numRequiredSignatures) return false;
  const numUnsigned = totalStatic - numRequiredSignatures;
  const numWritableUnsigned = numUnsigned - numReadonlyUnsignedAccounts;
  if (index < numRequiredSignatures + numWritableUnsigned) return true;
  return false;
}

async function main(): Promise<void> {
  const urlArg = process.argv[2];
  const url = urlArg || await prompt("Paste Solana Explorer Inspector URL: ");

  if (!url) {
    console.error("No URL provided.");
    process.exit(1);
  }

  const messageB64 = parseInspectorUrl(url);
  const connection = new Connection(RPC_URL, "confirmed");

  // Decode the versioned message
  const messageBytes = Buffer.from(messageB64, "base64");
  const message = VersionedMessage.deserialize(messageBytes);

  // Build a transaction with dummy signatures (all zeros)
  const tx = new VersionedTransaction(message);

  console.log("╔══════════════════════════════════════╗");
  console.log("║       TRANSACTION DETAILS            ║");
  console.log("╚══════════════════════════════════════╝\n");

  // Print account keys
  const staticKeys = message.staticAccountKeys;
  console.log("Static Account Keys:");
  for (let i = 0; i < staticKeys.length; i++) {
    const signer = i < message.header.numRequiredSignatures ? " [SIGNER]" : "";
    const writable = isWritable(message.header, staticKeys.length, i) ? " [WRITABLE]" : "";
    console.log(`  ${i}: ${staticKeys[i].toBase58()}${signer}${writable}`);
  }

  // Resolve address lookup tables
  const resolvedKeys: string[] = staticKeys.map((k) => k.toBase58());
  const altWritableKeys: string[] = [];
  const altReadonlyKeys: string[] = [];

  if (message.version === 0) {
    const msg = message as MessageV0;
    if (msg.addressTableLookups.length > 0) {
      console.log("\nAddress Lookup Tables:");
      for (const lookup of msg.addressTableLookups) {
        console.log(`  Table: ${lookup.accountKey.toBase58()}`);
        console.log(`    Writable indexes: [${lookup.writableIndexes.join(", ")}]`);
        console.log(`    Readonly indexes: [${lookup.readonlyIndexes.join(", ")}]`);

        try {
          const altResult = await connection.getAddressLookupTable(lookup.accountKey);
          if (altResult.value) {
            const addresses = altResult.value.state.addresses;
            for (const idx of lookup.writableIndexes) {
              const addr = addresses[idx].toBase58();
              altWritableKeys.push(addr);
              resolvedKeys.push(addr);
            }
            for (const idx of lookup.readonlyIndexes) {
              const addr = addresses[idx].toBase58();
              altReadonlyKeys.push(addr);
              resolvedKeys.push(addr);
            }
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          console.log(`    ⚠ Could not resolve ALT: ${msg}`);
        }
      }

      if (altWritableKeys.length > 0 || altReadonlyKeys.length > 0) {
        console.log("\n  Resolved ALT Accounts:");
        let idx = staticKeys.length;
        for (const addr of altWritableKeys) {
          console.log(`    ${idx}: ${addr} [WRITABLE via ALT]`);
          idx++;
        }
        for (const addr of altReadonlyKeys) {
          console.log(`    ${idx}: ${addr} [READONLY via ALT]`);
          idx++;
        }
      }
    }
  }

  console.log("\n╔══════════════════════════════════════╗");
  console.log("║       SIMULATION RESULTS             ║");
  console.log("╚══════════════════════════════════════╝\n");

  // Simulate
  const result = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });

  if (result.value.err) {
    console.log("❌ Simulation ERROR:", JSON.stringify(result.value.err, null, 2));
  } else {
    console.log("✅ Simulation SUCCESS");
  }

  console.log(`\nCompute units consumed: ${result.value.unitsConsumed ?? "N/A"}`);

  // Logs
  const logs = result.value.logs ?? [];
  if (logs.length > 0) {
    console.log("\n┌─── PROGRAM LOGS ───────────────────────┐\n");
    for (const log of logs) {
      // Color-code by type
      if (log.includes("invoke")) {
        console.log(`  🔹 ${log}`);
      } else if (log.includes("success")) {
        console.log(`  ✅ ${log}`);
      } else if (log.includes("failed") || log.includes("error") || log.includes("Error")) {
        console.log(`  ❌ ${log}`);
      } else if (log.includes("Program log:")) {
        console.log(`  📝 ${log}`);
      } else if (log.includes("Program data:")) {
        console.log(`  📦 ${log}`);
      } else {
        console.log(`     ${log}`);
      }
    }
    console.log("\n└────────────────────────────────────────┘");
  }

  // Parse token transfers from logs
  console.log("\n┌─── TOKEN TRANSFERS ────────────────────┐\n");

  const transfers = parseTransfersFromLogs(logs, resolvedKeys);
  if (transfers.length > 0) {
    for (const t of transfers) {
      console.log(`  ${t}`);
    }
  } else {
    console.log("  (Parsing transfers from logs - checking for SPL Token activity)");
    // Show any transfer-related logs
    const transferLogs = logs.filter(
      (l) =>
        l.toLowerCase().includes("transfer") ||
        l.toLowerCase().includes("amount") ||
        l.toLowerCase().includes("mint") ||
        l.toLowerCase().includes("burn")
    );
    if (transferLogs.length > 0) {
      for (const tl of transferLogs) {
        console.log(`  💰 ${tl.trim()}`);
      }
    } else {
      console.log("  No token transfer activity detected in logs.");
    }
  }

  console.log("\n└────────────────────────────────────────┘");

  // Instruction flow summary
  console.log("\n┌─── INSTRUCTION FLOW ───────────────────┐\n");
  let depth = 0;
  for (const log of logs) {
    const invokeMatch = log.match(/Program (\w+) invoke \[(\d+)\]/);
    if (invokeMatch) {
      depth = parseInt(invokeMatch[2]) - 1;
      const indent = "  ".repeat(depth);
      console.log(`  ${indent}→ ${invokeMatch[1]} (depth ${invokeMatch[2]})`);
    }
    const successMatch = log.match(/Program (\w+) success/);
    if (successMatch) {
      const indent = "  ".repeat(Math.max(0, depth - 1));
      console.log(`  ${indent}✓ ${successMatch[1]} completed`);
    }
  }
  console.log("\n└────────────────────────────────────────┘");
}

function parseTransfersFromLogs(logs: string[], accountKeys: string[]): string[] {
  const transfers: string[] = [];

  for (const log of logs) {
    // Match "Transfer <amount> lamports" pattern
    const lamportMatch = log.match(/Transfer (\d+) lamports/i);
    if (lamportMatch) {
      const amount = parseInt(lamportMatch[1]);
      const sol = amount / 1e9;
      transfers.push(`SOL Transfer: ${sol.toFixed(9)} SOL (${amount} lamports)`);
    }

    // Match SPL token instruction logs
    const splMatch = log.match(/Program log: Instruction: (Transfer|TransferChecked)/);
    if (splMatch) {
      transfers.push(`SPL Token ${splMatch[1]} detected`);
    }
  }

  return transfers;
}

main().catch(console.error);
