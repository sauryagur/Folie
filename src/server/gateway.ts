// Execution gateway: the only path for external effects (ADR 0007, protocols §11).
// The gateway holds external-account credentials and pre-authorizes spend against
// the leaf budget, then commits actual usage afterwards (§12, E2). Secrets enter
// through the injected CredentialStore only; nothing here reads process.env, so a
// model key never lands in the sandbox (no LLM proxy in this slice: the gateway
// is the enforcement point for gateway tools; model spend waits for the proxy).
import { ValidationError } from "./errors";
import type { BudgetRecord } from "../shared/types";
import type { BudgetRepo } from "./store";

/** Properties of a tool definition (interfaces.md §6); risk and idempotency are mandatory. */
export type RiskClass =
  | "R0_read"
  | "R1_local_reversible"
  | "R2_external_read"
  | "R3_external_write_reversible"
  | "R4_commitment"
  | "R5_destructive"
  | "R6_production"
  | "R7_physical";

export type Idempotency = "natural" | "key" | "none";

export interface ToolDefinition {
  id: string;
  version: string;
  kind: "gateway";
  risk: RiskClass;
  idempotency: Idempotency;
  /** Maximum pre-authorized cost, in the budget's dim (costModel max). */
  estimate: number;
  /** Budget dim this tool charges; must match the leaf budget. */
  dim?: string;
  /** Account whose credential the provider needs (resolved here, never returned). */
  account?: string;
}

/** What a provider hands back: result plus its measured usage when it meters itself. */
export interface ToolOutcome {
  ok: boolean;
  result?: unknown;
  actual?: number;
}

export interface ToolCall {
  tool: string;
  args: unknown;
}

/** Handed only to the provider's invoke; the caller never sees this. */
export interface ToolContext {
  credential?: string;
}

export type ToolHandler = (
  call: ToolCall,
  ctx: ToolContext,
) => Promise<ToolOutcome>;

export interface InvokeRequest {
  budgetId: number;
  tool: string;
  args?: unknown;
}

export interface InvokeResult {
  ok: boolean;
  result: unknown;
  budget: BudgetRecord;
}

/** The gateway's credential vault. Implementations hand secrets to providers, never to callers. */
export interface CredentialStore {
  accountCredential(account: string): string | undefined;
}

/** In-memory vault for tests and the interim single-process deployment. */
export class MapCredentialStore implements CredentialStore {
  constructor(private readonly secrets: Readonly<Record<string, string>>) {}
  accountCredential(account: string): string | undefined {
    return this.secrets[account];
  }
}

export class InsufficientBudgetError extends Error {}

const RISKS: RiskClass[] = [
  "R0_read",
  "R1_local_reversible",
  "R2_external_read",
  "R3_external_write_reversible",
  "R4_commitment",
  "R5_destructive",
  "R6_production",
  "R7_physical",
];
const IDEMPOTENCY: Idempotency[] = ["natural", "key", "none"];

/** Refuse undeclared tools instead of silently assuming a safe default. */
function validateDefinition(def: ToolDefinition): void {
  if (!def || typeof def.id !== "string" || def.id === "")
    throw new ValidationError("tool: id is required");
  if (def.kind !== "gateway")
    throw new ValidationError(
      `tool ${def.id}: kind must be "gateway" (local tools run in the sandbox)`,
    );
  if (!RISKS.includes(def.risk))
    throw new ValidationError(
      `tool ${def.id}: risk must be declared (one of ${RISKS.join(", ")})`,
    );
  if (!IDEMPOTENCY.includes(def.idempotency))
    throw new ValidationError(
      `tool ${def.id}: idempotency must be declared (one of ${IDEMPOTENCY.join(", ")})`,
    );
  if (!Number.isFinite(def.estimate) || def.estimate < 0)
    throw new ValidationError(`tool ${def.id}: estimate must be a number >= 0`);
}

export class Gateway {
  private readonly tools = new Map<
    string,
    { def: ToolDefinition; handler: ToolHandler }
  >();

  constructor(
    private readonly budgets: BudgetRepo,
    private readonly credentials: CredentialStore,
  ) {}

  /** Register a gateway tool. MCP-backed tools use this too: the adapter must declare risk and idempotency per tool. */
  registerTool(def: ToolDefinition, handler: ToolHandler): void {
    validateDefinition(def);
    this.tools.set(def.id, { def, handler });
  }

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    const entry = this.tools.get(req.tool);
    if (!entry) throw new ValidationError(`tool: unknown ${req.tool}`);
    const { def, handler } = entry;

    const budget = await this.budgets.get(req.budgetId);
    if (!budget || budget.status === "closed")
      throw new ValidationError(`budgetId: unknown or closed ${req.budgetId}`);
    if (def.dim !== undefined && def.dim !== budget.dim)
      throw new ValidationError(
        `tool ${def.id}: dim ${def.dim} does not match budget dim ${budget.dim}`,
      );

    const reservation = await this.budgets.reserve(
      req.budgetId,
      def.estimate,
      def.id,
    );
    if (!reservation) throw new InsufficientBudgetError("insufficient_budget");

    const credential = def.account
      ? this.credentials.accountCredential(def.account)
      : undefined;
    const scrub = (s: string): string =>
      credential === undefined ? s : s.split(credential).join("[redacted]");
    let result: unknown = null;
    let ok = false;
    try {
      let outcome: ToolOutcome;
      try {
        outcome = await handler(
          { tool: def.id, args: req.args ?? null },
          credential === undefined ? {} : { credential },
        );
      } catch (e) {
        throw new Error(scrub(e instanceof Error ? e.message : String(e)));
      }
      result = outcome.result ?? null;
      if (
        credential !== undefined &&
        JSON.stringify(result)?.includes(credential) === true
      )
        throw new Error(`tool ${def.id}: result would leak a credential`);
      const actual = outcome.actual ?? def.estimate;
      const committed = await this.budgets.commit(
        req.budgetId,
        actual,
        outcome.actual === undefined ? "estimated" : "measured",
      );
      if (!committed)
        throw new Error("budget: closed during invocation");
      ok = outcome.ok;
    } finally {
      await this.budgets.release(reservation.id);
    }
    const fresh = await this.budgets.get(req.budgetId);
    if (!fresh) throw new Error("budget: closed during invocation");
    return { ok, result, budget: fresh };
}
}
