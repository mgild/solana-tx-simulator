import {
  Connection,
  VersionedTransaction,
  VersionedMessage,
  MessageV0,
} from "@solana/web3.js";
import * as readline from "readline";

const RPC_URL = "https://api.mainnet-beta.solana.com";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

// SPL Token instruction discriminators (first byte of instruction data)
const SPL_TOKEN_IX: Record<number, string> = {
  0: "InitializeMint",
  1: "InitializeAccount",
  2: "InitializeMultisig",
  3: "Transfer",
  4: "Approve",
  5: "Revoke",
  6: "SetAuthority",
  7: "MintTo",
  8: "Burn",
  9: "CloseAccount",
  10: "FreezeAccount",
  11: "ThawAccount",
  12: "TransferChecked",
  13: "ApproveChecked",
  14: "MintToChecked",
  15: "BurnChecked",
  16: "InitializeAccount2",
  17: "SyncNative",
  18: "InitializeAccount3",
  19: "InitializeMultisig2",
  20: "InitializeMint2",
  21: "GetAccountDataSize",
  22: "InitializeImmutableOwner",
  23: "AmountToUiAmount",
  24: "UiAmountToAmount",
};

interface TokenActivity {
  type: string;
  source?: string;
  destination?: string;
  amount?: string;
  mint?: string;
  decimals?: number;
  programId: string;
}

interface InnerInstruction {
  index: number;
  instructions: Array<{
    programIdIndex: number;
    accounts: number[];
    data: string;
  }>;
}

function parseInspectorUrl(url: string): string {
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
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function isWritable(
  header: {
    numRequiredSignatures: number;
    numReadonlySignedAccounts: number;
    numReadonlyUnsignedAccounts: number;
  },
  totalStatic: number,
  index: number,
): boolean {
  const {
    numRequiredSignatures,
    numReadonlySignedAccounts,
    numReadonlyUnsignedAccounts,
  } = header;
  const numWritableSigners = numRequiredSignatures - numReadonlySignedAccounts;
  if (index < numWritableSigners) return true;
  if (index < numRequiredSignatures) return false;
  const numUnsigned = totalStatic - numRequiredSignatures;
  const numWritableUnsigned = numUnsigned - numReadonlyUnsignedAccounts;
  if (index < numRequiredSignatures + numWritableUnsigned) return true;
  return false;
}

function bs58Decode(str: string): Uint8Array {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const ALPHABET_MAP = new Map<string, number>();
  for (let i = 0; i < ALPHABET.length; i++) {
    ALPHABET_MAP.set(ALPHABET[i], i);
  }

  const bytes: number[] = [0];
  for (const char of str) {
    const value = ALPHABET_MAP.get(char);
    if (value === undefined) throw new Error(`Invalid base58 character: ${char}`);
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Leading zeros
  for (const char of str) {
    if (char !== "1") break;
    bytes.push(0);
  }

  return new Uint8Array(bytes.reverse());
}

function decodeTokenInstruction(
  data: string,
  accountIndexes: number[],
  allKeys: string[],
  programId: string,
): TokenActivity | null {
  const bytes = bs58Decode(data);
  if (bytes.length === 0) return null;

  const ixType = bytes[0];
  const ixName = SPL_TOKEN_IX[ixType];
  if (!ixName) return null;

  const resolve = (idx: number): string =>
    idx < allKeys.length ? allKeys[idx] : `unknown(${idx})`;

  // Transfer: [3] + u64 amount, accounts: [source, dest, owner]
  if (ixType === 3 && bytes.length >= 9 && accountIndexes.length >= 3) {
    const amount = readU64(bytes, 1);
    return {
      type: "Transfer",
      source: resolve(accountIndexes[0]),
      destination: resolve(accountIndexes[1]),
      amount: amount.toString(),
      programId,
    };
  }

  // TransferChecked: [12] + u64 amount + u8 decimals, accounts: [source, mint, dest, owner]
  if (ixType === 12 && bytes.length >= 10 && accountIndexes.length >= 4) {
    const amount = readU64(bytes, 1);
    const decimals = bytes[9];
    return {
      type: "TransferChecked",
      source: resolve(accountIndexes[0]),
      mint: resolve(accountIndexes[1]),
      destination: resolve(accountIndexes[2]),
      amount: amount.toString(),
      decimals,
      programId,
    };
  }

  // MintTo: [7] + u64 amount, accounts: [mint, dest, authority]
  if (ixType === 7 && bytes.length >= 9 && accountIndexes.length >= 3) {
    const amount = readU64(bytes, 1);
    return {
      type: "MintTo",
      mint: resolve(accountIndexes[0]),
      destination: resolve(accountIndexes[1]),
      amount: amount.toString(),
      programId,
    };
  }

  // MintToChecked: [14] + u64 amount + u8 decimals, accounts: [mint, dest, authority]
  if (ixType === 14 && bytes.length >= 10 && accountIndexes.length >= 3) {
    const amount = readU64(bytes, 1);
    const decimals = bytes[9];
    return {
      type: "MintToChecked",
      mint: resolve(accountIndexes[0]),
      destination: resolve(accountIndexes[1]),
      amount: amount.toString(),
      decimals,
      programId,
    };
  }

  // Burn: [8] + u64 amount, accounts: [source, mint, owner]
  if (ixType === 8 && bytes.length >= 9 && accountIndexes.length >= 3) {
    const amount = readU64(bytes, 1);
    return {
      type: "Burn",
      source: resolve(accountIndexes[0]),
      mint: resolve(accountIndexes[1]),
      amount: amount.toString(),
      programId,
    };
  }

  // BurnChecked: [15] + u64 amount + u8 decimals, accounts: [source, mint, owner]
  if (ixType === 15 && bytes.length >= 10 && accountIndexes.length >= 3) {
    const amount = readU64(bytes, 1);
    const decimals = bytes[9];
    return {
      type: "BurnChecked",
      source: resolve(accountIndexes[0]),
      mint: resolve(accountIndexes[1]),
      amount: amount.toString(),
      decimals,
      programId,
    };
  }

  // For non-transfer token instructions, still report them
  return {
    type: ixName,
    programId,
  };
}

function readU64(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    value |= BigInt(bytes[offset + i]) << BigInt(i * 8);
  }
  return value;
}

function formatAmount(amount: string, decimals?: number): string {
  if (decimals === undefined) return amount;
  const raw = BigInt(amount);
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

function shortenAddr(addr: string): string {
  if (addr.length <= 11) return addr;
  return `${addr.slice(0, 4)}..${addr.slice(-4)}`;
}

async function main(): Promise<void> {
  const urlArg = process.argv[2];
  const url = urlArg || (await prompt("Paste Solana Explorer Inspector URL: "));

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
    const signer =
      i < message.header.numRequiredSignatures ? " [SIGNER]" : "";
    const writable = isWritable(message.header, staticKeys.length, i)
      ? " [WRITABLE]"
      : "";
    console.log(
      `  ${i}: ${staticKeys[i].toBase58()}${signer}${writable}`,
    );
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
        console.log(
          `    Writable indexes: [${lookup.writableIndexes.join(", ")}]`,
        );
        console.log(
          `    Readonly indexes: [${lookup.readonlyIndexes.join(", ")}]`,
        );

        try {
          const altResult = await connection.getAddressLookupTable(
            lookup.accountKey,
          );
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
          const errMsg = e instanceof Error ? e.message : String(e);
          console.log(`    Could not resolve ALT: ${errMsg}`);
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

  // Simulate with innerInstructions enabled
  // Use raw RPC call to get innerInstructions (web3.js doesn't expose this option)
  const serialized = Buffer.from(tx.serialize());
  const b64Tx = serialized.toString("base64");

  // Collect all account addresses for balance tracking
  const allAccountAddresses = [...resolvedKeys];

  const rpcResponse = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "simulateTransaction",
      params: [
        b64Tx,
        {
          sigVerify: false,
          replaceRecentBlockhash: true,
          encoding: "base64",
          innerInstructions: true,
          accounts: {
            encoding: "jsonParsed",
            addresses: allAccountAddresses,
          },
        },
      ],
    }),
  });

  interface TokenBalanceEntry {
    accountIndex: number;
    mint: string;
    owner?: string;
    programId?: string;
    uiTokenAmount: {
      amount: string;
      decimals: number;
      uiAmount: number | null;
      uiAmountString: string;
    };
  }

  interface AccountInfo {
    lamports: number;
    owner: string;
    data: unknown;
    executable: boolean;
    rentEpoch: number;
    space: number;
  }

  const rpcData = (await rpcResponse.json()) as {
    result: {
      value: {
        err: unknown;
        logs: string[];
        unitsConsumed: number;
        innerInstructions?: InnerInstruction[];
        preBalances: number[];
        postBalances: number[];
        preTokenBalances: TokenBalanceEntry[];
        postTokenBalances: TokenBalanceEntry[];
        accounts: (AccountInfo | null)[];
      };
    };
  };
  const simResult = rpcData.result.value;

  if (simResult.err) {
    console.log(
      "Simulation ERROR:",
      JSON.stringify(simResult.err, null, 2),
    );
  } else {
    console.log("Simulation SUCCESS");
  }

  console.log(
    `\nCompute units consumed: ${simResult.unitsConsumed ?? "N/A"}`,
  );

  // SOL Balance Changes
  const preBalances = simResult.preBalances ?? [];
  const postBalances = simResult.postBalances ?? [];

  if (preBalances.length > 0 && postBalances.length > 0) {
    console.log("\n┌─── SOL BALANCE CHANGES ─────────────────┐\n");

    const solChanges: Array<{
      address: string;
      index: number;
      pre: number;
      post: number;
      diff: number;
    }> = [];

    for (let i = 0; i < Math.min(preBalances.length, postBalances.length); i++) {
      const diff = postBalances[i] - preBalances[i];
      if (diff !== 0) {
        solChanges.push({
          address: allAccountAddresses[i] ?? `account_${i}`,
          index: i,
          pre: preBalances[i],
          post: postBalances[i],
          diff,
        });
      }
    }

    if (solChanges.length === 0) {
      console.log("  No SOL balance changes.");
    } else {
      for (const change of solChanges) {
        const sign = change.diff > 0 ? "+" : "";
        const diffSol = change.diff / 1e9;
        const preSol = change.pre / 1e9;
        const postSol = change.post / 1e9;
        console.log(
          `  ${shortenAddr(change.address)} (account ${change.index})`,
        );
        console.log(
          `    ${preSol.toFixed(9)} -> ${postSol.toFixed(9)} SOL  (${sign}${diffSol.toFixed(9)} SOL / ${sign}${change.diff} lamports)`,
        );
      }
    }

    console.log("\n└────────────────────────────────────────┘");
  }

  // Token Balance Changes
  const preTokenBalances = simResult.preTokenBalances ?? [];
  const postTokenBalances = simResult.postTokenBalances ?? [];

  if (preTokenBalances.length > 0 || postTokenBalances.length > 0) {
    console.log("\n┌─── TOKEN BALANCE CHANGES ───────────────┐\n");

    // Build a map keyed by accountIndex+mint for diffing
    const preMap = new Map<string, TokenBalanceEntry>();
    for (const entry of preTokenBalances) {
      preMap.set(`${entry.accountIndex}:${entry.mint}`, entry);
    }
    const postMap = new Map<string, TokenBalanceEntry>();
    for (const entry of postTokenBalances) {
      postMap.set(`${entry.accountIndex}:${entry.mint}`, entry);
    }

    const allTokenKeys = new Set([...preMap.keys(), ...postMap.keys()]);

    let hasChanges = false;
    for (const key of allTokenKeys) {
      const pre = preMap.get(key);
      const post = postMap.get(key);

      const preAmount = BigInt(pre?.uiTokenAmount.amount ?? "0");
      const postAmount = BigInt(post?.uiTokenAmount.amount ?? "0");
      const diff = postAmount - preAmount;

      if (diff === 0n) continue;
      hasChanges = true;

      const entry = post ?? pre!;
      const decimals = entry.uiTokenAmount.decimals;
      const mint = entry.mint;
      const owner = entry.owner ?? "unknown";
      const accountAddr = allAccountAddresses[entry.accountIndex] ?? `account_${entry.accountIndex}`;

      const sign = diff > 0n ? "+" : "";
      const diffFormatted = formatAmount(
        (diff < 0n ? -diff : diff).toString(),
        decimals,
      );
      const preFormatted = formatAmount(preAmount.toString(), decimals);
      const postFormatted = formatAmount(postAmount.toString(), decimals);

      console.log(
        `  ${shortenAddr(accountAddr)} (owner: ${shortenAddr(owner)})`,
      );
      console.log(
        `    Mint: ${mint}`,
      );
      console.log(
        `    ${preFormatted} -> ${postFormatted}  (${sign}${diffFormatted})`,
      );
    }

    if (!hasChanges) {
      console.log("  No token balance changes.");
    }

    console.log("\n└────────────────────────────────────────┘");
  }

  // Logs
  const logs = simResult.logs ?? [];
  if (logs.length > 0) {
    console.log("\n┌─── PROGRAM LOGS ───────────────────────┐\n");
    for (const log of logs) {
      if (log.includes("invoke")) {
        console.log(`  >> ${log}`);
      } else if (log.includes("success")) {
        console.log(`  << ${log}`);
      } else if (
        log.includes("failed") ||
        log.includes("error") ||
        log.includes("Error")
      ) {
        console.log(`  !! ${log}`);
      } else if (log.includes("Program log:")) {
        console.log(`  -- ${log}`);
      } else if (log.includes("Program data:")) {
        console.log(`  .. ${log}`);
      } else {
        console.log(`     ${log}`);
      }
    }
    console.log("\n└────────────────────────────────────────┘");
  }

  // Decode all token activity from top-level + inner instructions
  console.log("\n┌─── TOKEN ACTIVITY ─────────────────────┐\n");

  const allActivity: TokenActivity[] = [];

  // Top-level instructions
  const compiledIxs =
    message.version === 0
      ? (message as MessageV0).compiledInstructions
      : (message as MessageV0).compiledInstructions;

  for (const ix of compiledIxs) {
    const programId = resolvedKeys[ix.programIdIndex] ?? `idx(${ix.programIdIndex})`;
    if (programId === TOKEN_PROGRAM || programId === TOKEN_2022_PROGRAM) {
      // Encode data back to base58 for our decoder
      const dataBytes = ix.data;
      const activity = decodeTokenInstructionFromBytes(
        dataBytes,
        Array.from(ix.accountKeyIndexes),
        resolvedKeys,
        programId,
      );
      if (activity) allActivity.push(activity);
    }
  }

  // Inner instructions from simulation
  const innerIxs = simResult.innerInstructions ?? [];
  for (const group of innerIxs) {
    for (const ix of group.instructions) {
      const programId = resolvedKeys[ix.programIdIndex] ?? `idx(${ix.programIdIndex})`;
      if (programId === TOKEN_PROGRAM || programId === TOKEN_2022_PROGRAM) {
        const activity = decodeTokenInstruction(
          ix.data,
          ix.accounts,
          resolvedKeys,
          programId,
        );
        if (activity) allActivity.push(activity);
      }

      // System program transfers
      if (programId === SYSTEM_PROGRAM) {
        const bytes = bs58Decode(ix.data);
        // SystemProgram.Transfer = discriminator 2 (u32 LE) + u64 lamports
        if (bytes.length >= 12 && bytes[0] === 2 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0) {
          const lamports = readU64(bytes, 4);
          const source = ix.accounts.length > 0 ? resolvedKeys[ix.accounts[0]] : "unknown";
          const dest = ix.accounts.length > 1 ? resolvedKeys[ix.accounts[1]] : "unknown";
          allActivity.push({
            type: "SOL Transfer",
            source,
            destination: dest,
            amount: lamports.toString(),
            programId,
          });
        }
      }
    }
  }

  if (allActivity.length === 0) {
    console.log("  No token/SOL transfers in this transaction.");
    console.log("  (Token Program invocations were for account setup only)");
  } else {
    // Separate transfers from non-transfer activity
    const transfers = allActivity.filter((a) =>
      ["Transfer", "TransferChecked", "MintTo", "MintToChecked", "Burn", "BurnChecked", "SOL Transfer"].includes(a.type),
    );
    const other = allActivity.filter((a) =>
      !["Transfer", "TransferChecked", "MintTo", "MintToChecked", "Burn", "BurnChecked", "SOL Transfer"].includes(a.type),
    );

    if (transfers.length > 0) {
      console.log("  Transfers:");
      for (const t of transfers) {
        if (t.type === "SOL Transfer") {
          const sol = Number(BigInt(t.amount!) * 1000n / 1000000000n) / 1000;
          console.log(
            `    SOL  ${shortenAddr(t.source!)} -> ${shortenAddr(t.destination!)}  ${sol} SOL (${t.amount} lamports)`,
          );
        } else if (t.type === "Transfer") {
          console.log(
            `    SPL  ${shortenAddr(t.source!)} -> ${shortenAddr(t.destination!)}  amount: ${t.amount} (raw)`,
          );
        } else if (t.type === "TransferChecked") {
          const formatted = formatAmount(t.amount!, t.decimals);
          console.log(
            `    SPL  ${shortenAddr(t.source!)} -> ${shortenAddr(t.destination!)}  ${formatted} (mint: ${shortenAddr(t.mint!)}, decimals: ${t.decimals})`,
          );
        } else if (t.type === "MintTo" || t.type === "MintToChecked") {
          const formatted = t.decimals !== undefined ? formatAmount(t.amount!, t.decimals) : t.amount;
          console.log(
            `    MINT ${shortenAddr(t.mint!)} -> ${shortenAddr(t.destination!)}  +${formatted}`,
          );
        } else if (t.type === "Burn" || t.type === "BurnChecked") {
          const formatted = t.decimals !== undefined ? formatAmount(t.amount!, t.decimals) : t.amount;
          console.log(
            `    BURN ${shortenAddr(t.source!)}  mint: ${shortenAddr(t.mint!)}  -${formatted}`,
          );
        }
      }
    }

    if (other.length > 0) {
      console.log(
        transfers.length > 0 ? "\n  Other Token Activity:" : "  Token Activity:",
      );
      for (const a of other) {
        const prog = a.programId === TOKEN_2022_PROGRAM ? " (Token-2022)" : "";
        console.log(`    ${a.type}${prog}`);
      }
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
      // Extract instruction name from next log if available
      console.log(
        `  ${indent}-> ${invokeMatch[1]} (depth ${invokeMatch[2]})`,
      );
    }
    // Show instruction names inline
    const ixMatch = log.match(/Program log: Instruction: (.+)/);
    if (ixMatch) {
      const indent = "  ".repeat(depth);
      console.log(`  ${indent}   ix: ${ixMatch[1]}`);
    }
    const successMatch = log.match(/Program (\w+) success/);
    if (successMatch) {
      const indent = "  ".repeat(Math.max(0, depth - 1));
      console.log(`  ${indent}<- ${successMatch[1]} ok`);
    }
  }
  console.log("\n└────────────────────────────────────────┘");
}

function decodeTokenInstructionFromBytes(
  data: Uint8Array,
  accountIndexes: number[],
  allKeys: string[],
  programId: string,
): TokenActivity | null {
  if (data.length === 0) return null;

  const ixType = data[0];
  const ixName = SPL_TOKEN_IX[ixType];
  if (!ixName) return null;

  const resolve = (idx: number): string =>
    idx < allKeys.length ? allKeys[idx] : `unknown(${idx})`;

  if (ixType === 3 && data.length >= 9 && accountIndexes.length >= 3) {
    const amount = readU64(data, 1);
    return {
      type: "Transfer",
      source: resolve(accountIndexes[0]),
      destination: resolve(accountIndexes[1]),
      amount: amount.toString(),
      programId,
    };
  }

  if (ixType === 12 && data.length >= 10 && accountIndexes.length >= 4) {
    const amount = readU64(data, 1);
    const decimals = data[9];
    return {
      type: "TransferChecked",
      source: resolve(accountIndexes[0]),
      mint: resolve(accountIndexes[1]),
      destination: resolve(accountIndexes[2]),
      amount: amount.toString(),
      decimals,
      programId,
    };
  }

  return { type: ixName, programId };
}

main().catch(console.error);
