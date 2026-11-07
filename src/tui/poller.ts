// One refresh of everything the TUI shows. The active view decides which extra reads are worth making.
import type { FolieClient } from "../shared/client";
import type { LedgerEvent } from "../shared/types";
import type {
  AlertKind,
  AlertSignal,
  BudgetNodeInput,
  PollResult,
  TuiState,
} from "./model";

export type PollApi = Pick<
  FolieClient,
  | "agents"
  | "messages"
  | "topics"
  | "inbox"
  | "reports"
  | "stream"
  | "listBudgets"
>;

/** How many messages the stream asks for on its first load and on each catch-up. */
export const STREAM_PAGE = 200;

const ALERT_LEDGER_TYPES = ["verification.verdict"];

const kindFor = (e: LedgerEvent): AlertKind | null => {
  if (e.type === "verification.verdict" && e.payload.verdict === "fail")
    return "verification_rejected";
  return null;
};

export const eventToSignal = (e: LedgerEvent): AlertSignal | null => {
  const kind = kindFor(e);
  if (!kind) return null;
  const agent = typeof e.payload.agent === "string" ? e.payload.agent : null;
  return {
    kind,
    at: e.createdAt,
    agent,
    detail: `${e.type} ${e.aggregateId}`,
  };
};

export async function poll(api: PollApi, s: TuiState): Promise<PollResult> {
  // First load starts at the oldest message (after=0) so the cursor walks the whole log.
  const messages =
    s.cursor === 0
      ? api.messages({ after: 0, limit: STREAM_PAGE })
      : api.messages({ after: s.cursor, limit: STREAM_PAGE });
  const needBudgets = s.view === "budgets" || s.view === "alerts";
  const [agents, msgs, topics, inbox, reports, ledger, budgets] =
    await Promise.all([
      api.agents(),
      messages,
      api.topics(),
      s.view === "inbox" && s.selected ? api.inbox(s.selected) : undefined,
      s.view === "reports" && s.selected
        ? api.reports({ agent: s.selected, limit: 50 })
        : undefined,
      needBudgets
        ? api.stream({ types: ALERT_LEDGER_TYPES, limit: 100 })
        : undefined,
      needBudgets ? api.listBudgets() : undefined,
    ]);
  const fromLedger = (ledger ?? [])
    .map(eventToSignal)
    .filter((x): x is AlertSignal => x !== null);
  const fromBudgets: AlertSignal[] = (budgets ?? [])
    .filter((b) => b.status === "exhausted" && b.spent >= b.limitAmount)
    .map((b) => ({
      kind: "budget_exhausted" as AlertKind,
      detail: `budget ${b.name} spent ${b.spent}/${b.limitAmount}`,
    }));
  const budgetInputs: BudgetNodeInput[] = (budgets ?? []).map((b) => ({
    id: b.id,
    name: b.name,
    dim: b.dim,
    limit: b.limitAmount,
    reserved: b.reserved,
    spent: b.spent,
    parentId: b.parentId,
    status: b.status,
  }));
  return {
    agents,
    messages: msgs,
    topics,
    inbox,
    reports: reports?.slice().reverse(),
    alertSignals: needBudgets ? [...fromLedger, ...fromBudgets] : undefined,
    budgets: needBudgets ? budgetInputs : undefined,
    forAgent: s.selected,
  };
}
