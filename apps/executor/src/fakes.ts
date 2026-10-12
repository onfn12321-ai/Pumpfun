import type {
  ExecutionAttempt,
  ExecutionRepository,
  PumpUiAdapter,
  TermsAuthorization,
  TradeRequest,
  TransitionRequest,
  UiTradeSnapshot,
  WalletAdapter,
  WalletApproval,
  WalletCapabilities,
  WalletTransactionRequest,
} from "./types.js";

export class InMemoryExecutionRepository implements ExecutionRepository {
  readonly transitions: TransitionRequest[] = [];
  readonly haltedWallets: Array<{ wallet: string; reason: string }> = [];
  private readonly attempts = new Map<string, ExecutionAttempt>();

  seed(attempt: ExecutionAttempt): void {
    this.attempts.set(`${attempt.intentId}:${attempt.id}`, { ...attempt });
  }

  async getAttempt(intentId: string, attemptId: string): Promise<ExecutionAttempt | null> {
    return this.attempts.get(`${intentId}:${attemptId}`) ?? null;
  }

  async transition(request: TransitionRequest): Promise<ExecutionAttempt> {
    const key = `${request.intentId}:${request.attemptId}`;
    const current = this.attempts.get(key);
    if (current === undefined || current.state !== request.from) {
      throw new Error("stale execution transition");
    }
    const next: ExecutionAttempt = {
      ...current,
      state: request.to,
      ...(request.messageDigest === undefined ? {} : { messageDigest: request.messageDigest }),
      ...(request.signature === undefined ? {} : { signature: request.signature }),
      ...(request.blockhash === undefined ? {} : { blockhash: request.blockhash }),
      ...(request.reason === undefined ? {} : { error: request.reason }),
    };
    this.attempts.set(key, next);
    this.transitions.push(request);
    return next;
  }

  async haltWallet(wallet: string, reason: string): Promise<void> {
    this.haltedWallets.push({ wallet, reason });
  }
}

export class FakePumpUiAdapter implements PumpUiAdapter {
  constructor(private readonly snapshot: UiTradeSnapshot) {}
  async inspectTrade(_request: TradeRequest): Promise<UiTradeSnapshot> {
    return this.snapshot;
  }
}

export class FakeWalletAdapter implements WalletAdapter {
  readonly fingerprint = "fake-wallet-v1";
  readonly approvals: Array<{ requestId: string; digest: string }> = [];
  constructor(
    readonly capabilities: WalletCapabilities,
    private readonly request: WalletTransactionRequest,
    private readonly approvalFactory: (requestId: string, digest: string) => WalletApproval = (requestId, digest) => ({
      requestId,
      messageDigest: digest,
      signature: "fake-signature",
    }),
  ) {}

  async captureTransactionRequest(): Promise<WalletTransactionRequest> {
    return this.request;
  }

  async approveBoundDigest(requestId: string, messageDigest: string): Promise<WalletApproval> {
    this.approvals.push({ requestId, digest: messageDigest });
    return this.approvalFactory(requestId, messageDigest);
  }
}

export function fakeTermsAuthorization(wallet: string, fingerprint = "fake-wallet-v1"): TermsAuthorization {
  return { recordId: "terms-1", authorizedAt: new Date("2026-01-01T00:00:00.000Z"), adapterFingerprint: fingerprint, wallet };
}
