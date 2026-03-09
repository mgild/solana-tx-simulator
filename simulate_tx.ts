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
  owner?: string;
  account?: string;
  decimals?: number;
  programId: string;
}

interface ParsedInnerIx {
  program: string;
  programId: string;
  stackHeight: number;
  parsed?: {
    type: string;
    info: Record<string, unknown>;
  };
  // Fallback for unparsed instructions
  accounts?: number[];
  data?: string;
  programIdIndex?: number;
}

interface InnerInstruction {
  index: number;
  instructions: ParsedInnerIx[];
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

function bs58Encode(bytes: Uint8Array): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let result = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    result += "1";
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    result += ALPHABET[digits[i]];
  }
  return result;
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

  // InitializeAccount: [1], accounts: [account, mint, owner, rent]
  if (ixType === 1 && accountIndexes.length >= 3) {
    return {
      type: "InitializeAccount",
      account: resolve(accountIndexes[0]),
      mint: resolve(accountIndexes[1]),
      owner: resolve(accountIndexes[2]),
      programId,
    };
  }

  // InitializeAccount2: [16] + Pubkey owner, accounts: [account, mint]
  if (ixType === 16 && accountIndexes.length >= 2) {
    let owner: string | undefined;
    if (bytes.length >= 33) {
      const ownerBytes = bytes.slice(1, 33);
      owner = bs58Encode(ownerBytes);
    }
    return {
      type: "InitializeAccount2",
      account: resolve(accountIndexes[0]),
      mint: resolve(accountIndexes[1]),
      owner,
      programId,
    };
  }

  // InitializeAccount3: [18] + Pubkey owner, accounts: [account, mint]
  if (ixType === 18 && accountIndexes.length >= 2) {
    let owner: string | undefined;
    if (bytes.length >= 33) {
      const ownerBytes = bytes.slice(1, 33);
      owner = bs58Encode(ownerBytes);
    }
    return {
      type: "InitializeAccount3",
      account: resolve(accountIndexes[0]),
      mint: resolve(accountIndexes[1]),
      owner,
      programId,
    };
  }

  // CloseAccount: [9], accounts: [account, dest, owner]
  if (ixType === 9 && accountIndexes.length >= 3) {
    return {
      type: "CloseAccount",
      account: resolve(accountIndexes[0]),
      destination: resolve(accountIndexes[1]),
      owner: resolve(accountIndexes[2]),
      programId,
    };
  }

  // For other token instructions, still report them
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
        },
      ],
    }),
  });

  const rpcData = (await rpcResponse.json()) as {
    result: {
      value: {
        err: unknown;
        logs: string[];
        unitsConsumed: number;
        innerInstructions?: InnerInstruction[];
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

  // Inner instructions from simulation (parsed format)
  const innerIxs = simResult.innerInstructions ?? [];
  for (const group of innerIxs) {
    for (const ix of group.instructions) {
      if (!ix.parsed) continue;
      const { type, info } = ix.parsed;

      // SPL Token instructions
      if (ix.program === "spl-token" || ix.programId === TOKEN_PROGRAM || ix.programId === TOKEN_2022_PROGRAM) {
        if (type === "transfer") {
          allActivity.push({
            type: "Transfer",
            source: info.source as string,
            destination: info.destination as string,
            amount: String(info.amount),
            programId: ix.programId,
          });
        } else if (type === "transferChecked") {
          const tokenAmount = info.tokenAmount as { amount: string; decimals: number } | undefined;
          allActivity.push({
            type: "TransferChecked",
            source: info.source as string,
            destination: info.destination as string,
            mint: info.mint as string,
            amount: tokenAmount?.amount ?? String(info.amount),
            decimals: tokenAmount?.decimals ?? (info.decimals as number | undefined),
            programId: ix.programId,
          });
        } else if (type === "mintTo") {
          allActivity.push({
            type: "MintTo",
            mint: info.mint as string,
            destination: info.account as string,
            amount: String(info.amount),
            programId: ix.programId,
          });
        } else if (type === "mintToChecked") {
          const tokenAmount = info.tokenAmount as { amount: string; decimals: number } | undefined;
          allActivity.push({
            type: "MintToChecked",
            mint: info.mint as string,
            destination: info.account as string,
            amount: tokenAmount?.amount ?? String(info.amount),
            decimals: tokenAmount?.decimals ?? (info.decimals as number | undefined),
            programId: ix.programId,
          });
        } else if (type === "burn") {
          allActivity.push({
            type: "Burn",
            source: info.account as string,
            mint: info.mint as string,
            amount: String(info.amount),
            programId: ix.programId,
          });
        } else if (type === "burnChecked") {
          const tokenAmount = info.tokenAmount as { amount: string; decimals: number } | undefined;
          allActivity.push({
            type: "BurnChecked",
            source: info.account as string,
            mint: info.mint as string,
            amount: tokenAmount?.amount ?? String(info.amount),
            decimals: tokenAmount?.decimals ?? (info.decimals as number | undefined),
            programId: ix.programId,
          });
        } else if (type === "initializeAccount" || type === "initializeAccount2" || type === "initializeAccount3") {
          allActivity.push({
            type: type.charAt(0).toUpperCase() + type.slice(1),
            account: info.account as string,
            mint: info.mint as string,
            owner: info.owner as string | undefined,
            programId: ix.programId,
          });
        } else if (type === "closeAccount") {
          allActivity.push({
            type: "CloseAccount",
            account: info.account as string,
            destination: info.destination as string,
            owner: info.owner as string | undefined,
            programId: ix.programId,
          });
        } else {
          allActivity.push({ type, programId: ix.programId });
        }
      }

      // System program
      if (ix.program === "system" || ix.programId === SYSTEM_PROGRAM) {
        if (type === "transfer") {
          allActivity.push({
            type: "SOL Transfer",
            source: info.source as string,
            destination: info.destination as string,
            amount: String(info.lamports),
            programId: ix.programId,
          });
        } else if (type === "createAccount") {
          allActivity.push({
            type: "CreateAccount",
            source: info.source as string,
            account: info.newAccount as string,
            owner: info.owner as string | undefined,
            amount: String(info.lamports),
            programId: ix.programId,
          });
        }
      }
    }
  }

  if (allActivity.length === 0) {
    console.log("  No token/SOL activity in this transaction.");
  } else {
    // Separate transfers from non-transfer activity
    const TRANSFER_TYPES = ["Transfer", "TransferChecked", "MintTo", "MintToChecked", "Burn", "BurnChecked", "SOL Transfer"];
    const ACCOUNT_TYPES = ["InitializeAccount", "InitializeAccount2", "InitializeAccount3", "CloseAccount", "CreateAccount"];
    const transfers = allActivity.filter((a) => TRANSFER_TYPES.includes(a.type));
    const other = allActivity.filter((a) => !TRANSFER_TYPES.includes(a.type) && !ACCOUNT_TYPES.includes(a.type));

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

    const accountOps = allActivity.filter((a) => ACCOUNT_TYPES.includes(a.type));

    if (accountOps.length > 0) {
      console.log(
        transfers.length > 0 ? "\n  Account Operations:" : "  Account Operations:",
      );
      for (const a of accountOps) {
        const prog = a.programId === TOKEN_2022_PROGRAM ? " (Token-2022)" : "";
        if (a.type.startsWith("InitializeAccount")) {
          console.log(`    INIT  account: ${a.account}${prog}`);
          console.log(`          mint:    ${a.mint}`);
          if (a.owner) {
            console.log(`          owner:   ${a.owner}`);
          }
        } else if (a.type === "CloseAccount") {
          console.log(`    CLOSE account: ${a.account}${prog}`);
          console.log(`          rent -> ${a.destination}`);
          if (a.owner) {
            console.log(`          owner:   ${a.owner}`);
          }
        } else if (a.type === "CreateAccount") {
          const sol = Number(BigInt(a.amount!) * 1000n / 1000000000n) / 1000;
          console.log(`    CREATE account: ${a.account}`);
          console.log(`           owner:   ${a.owner}`);
          console.log(`           funded:  ${sol} SOL (${a.amount} lamports)`);
          console.log(`           payer:   ${a.source}`);
        }
      }
    }

    if (other.length > 0) {
      console.log(
        (transfers.length > 0 || accountOps.length > 0) ? "\n  Other Token Activity:" : "  Token Activity:",
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

  // InitializeAccount: [1], accounts: [account, mint, owner, rent]
  if (ixType === 1 && accountIndexes.length >= 3) {
    return {
      type: "InitializeAccount",
      account: resolve(accountIndexes[0]),
      mint: resolve(accountIndexes[1]),
      owner: resolve(accountIndexes[2]),
      programId,
    };
  }

  // InitializeAccount2: [16] + Pubkey owner, accounts: [account, mint]
  if (ixType === 16 && accountIndexes.length >= 2) {
    let owner: string | undefined;
    if (data.length >= 33) {
      owner = bs58Encode(data.slice(1, 33));
    }
    return {
      type: "InitializeAccount2",
      account: resolve(accountIndexes[0]),
      mint: resolve(accountIndexes[1]),
      owner,
      programId,
    };
  }

  // InitializeAccount3: [18] + Pubkey owner, accounts: [account, mint]
  if (ixType === 18 && accountIndexes.length >= 2) {
    let owner: string | undefined;
    if (data.length >= 33) {
      owner = bs58Encode(data.slice(1, 33));
    }
    return {
      type: "InitializeAccount3",
      account: resolve(accountIndexes[0]),
      mint: resolve(accountIndexes[1]),
      owner,
      programId,
    };
  }

  // CloseAccount: [9], accounts: [account, dest, owner]
  if (ixType === 9 && accountIndexes.length >= 3) {
    return {
      type: "CloseAccount",
      account: resolve(accountIndexes[0]),
      destination: resolve(accountIndexes[1]),
      owner: resolve(accountIndexes[2]),
      programId,
    };
  }

  return { type: ixName, programId };
}

main().catch(console.error);
