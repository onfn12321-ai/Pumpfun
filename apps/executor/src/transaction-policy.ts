import { createHash } from "node:crypto";

import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";

import { ExecutionSafetyError } from "./errors.js";

export interface TransactionPolicy {
  expectedSigner: string;
  allowedProgramIds: ReadonlySet<string>;
  allowedWritableAccounts: ReadonlySet<string>;
  maximumTransactions: number;
}

export interface InspectedTransaction {
  digest: string;
  signers: string[];
  programs: string[];
  writableAccounts: string[];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function sha256Digest(serialized: Uint8Array): string {
  return createHash("sha256").update(serialized).digest("hex");
}

export function inspectSerializedTransaction(serialized: Uint8Array): InspectedTransaction {
  try {
    const versioned = VersionedTransaction.deserialize(serialized);
    const keys = versioned.message.staticAccountKeys.map((key) => key.toBase58());
    const header = versioned.message.header;
    const signers = keys.slice(0, header.numRequiredSignatures);
    const writableSigned = header.numRequiredSignatures - header.numReadonlySignedAccounts;
    const unsignedCount = keys.length - header.numRequiredSignatures;
    const writableUnsigned = unsignedCount - header.numReadonlyUnsignedAccounts;
    const writableAccounts = [
      ...keys.slice(0, writableSigned),
      ...keys.slice(header.numRequiredSignatures, header.numRequiredSignatures + writableUnsigned),
    ];
    const programs = versioned.message.compiledInstructions.map((instruction) => keys[instruction.programIdIndex]).filter((value): value is string => value !== undefined);
    return { digest: sha256Digest(serialized), signers: unique(signers), programs: unique(programs), writableAccounts: unique(writableAccounts) };
  } catch {
    try {
      const legacy = Transaction.from(serialized);
      const message = legacy.compileMessage();
      const keys = message.accountKeys.map((key) => key.toBase58());
      const signers = keys.slice(0, message.header.numRequiredSignatures);
      const writableAccounts = keys.filter((_, index) => message.isAccountWritable(index));
      const programs = message.instructions.map((instruction) => keys[instruction.programIdIndex]).filter((value): value is string => value !== undefined);
      return { digest: sha256Digest(serialized), signers: unique(signers), programs: unique(programs), writableAccounts: unique(writableAccounts) };
    } catch {
      throw new ExecutionSafetyError("Wallet request is not a supported Solana transaction", "TRANSACTION_DECODE_FAILED");
    }
  }
}

export function enforceTransactionPolicy(serializedTransactions: readonly Uint8Array[], policy: TransactionPolicy): InspectedTransaction[] {
  if (serializedTransactions.length === 0 || serializedTransactions.length > policy.maximumTransactions) {
    throw new ExecutionSafetyError("Unexpected transaction count", "TRANSACTION_POLICY_REJECTED");
  }
  // Validate configuration early. PublicKey rejects malformed identities.
  new PublicKey(policy.expectedSigner);

  return serializedTransactions.map((serialized) => {
    const inspected = inspectSerializedTransaction(serialized);
    if (!inspected.signers.includes(policy.expectedSigner) || inspected.signers[0] !== policy.expectedSigner) {
      throw new ExecutionSafetyError("Unexpected signer or fee payer", "TRANSACTION_POLICY_REJECTED");
    }
    const unknownProgram = inspected.programs.find((program) => !policy.allowedProgramIds.has(program));
    if (unknownProgram) throw new ExecutionSafetyError(`Unknown program ${unknownProgram}`, "TRANSACTION_POLICY_REJECTED");
    const unknownWritable = inspected.writableAccounts.find(
      (account) => account !== policy.expectedSigner && !policy.allowedWritableAccounts.has(account),
    );
    if (unknownWritable) throw new ExecutionSafetyError(`Unexpected writable account ${unknownWritable}`, "TRANSACTION_POLICY_REJECTED");
    return inspected;
  });
}
