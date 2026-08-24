/**
 * Browser-side execution for the copilot's commission tools.
 *
 * The commission engine has no backend yet — the payee registry, waterfall,
 * ledger and payout runs all live in `app/services/commissions.ts` and are
 * derived in the browser from real policies and agents. So chat-agent declares
 * these tools, resolves what it can server-side, then hands execution here via
 * the same `client_execute` interrupt that `upload_document` and `issue_policy`
 * already use.
 *
 * Every result carries `quick_actions` so the answer stays one click from the
 * next step, and a `navigate` route so "show me" lands on the right screen.
 *
 * When routers/commissions.py exists this file goes away and the handlers move
 * server-side. The tool names and result shape are chosen so that swap needs no
 * change in the agent or the UI.
 */

import {
  listPayees,
  listCommissionLedger,
  listPayoutRuns,
  createPayoutRun,
  approvePayoutRun,
  computeCommissionWaterfall,
  PAYEE_TYPE_LABELS,
  type CommissionPayee,
  type CommissionLedgerEntry,
} from "@/app/services/commissions";
import { listPolicies } from "@/app/services/policies";

type ToolResult = Record<string, any>;

const money = (n: number) => `PKR ${Math.round(n || 0).toLocaleString()}`;

function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Who the copilot is acting for. Payout runs enforce segregation of duties —
 *  the approver must differ from the maker — so both halves have to be
 *  attributed to the signed-in human, not to "AI Copilot". */
function actor(): string {
  if (typeof window === "undefined") return "Portal User";
  return localStorage.getItem("user_name") || localStorage.getItem("user_email") || "Portal User";
}

/** Case-insensitive contains match on name or code. */
function matchPayee(payees: CommissionPayee[], needle?: string | null): CommissionPayee | undefined {
  if (!needle) return undefined;
  const n = needle.toLowerCase().trim();
  return (
    payees.find((p) => p.name.toLowerCase() === n || p.code.toLowerCase() === n) ??
    payees.find((p) => p.name.toLowerCase().includes(n) || p.code.toLowerCase().includes(n))
  );
}

const OPEN_LEDGER = { label: "Open Ledger", actionType: "navigate" as const, payload: "commission-ops/ledger" };
const OPEN_PAYEES = { label: "Open Payees", actionType: "navigate" as const, payload: "commissions/payees" };
const OPEN_RUNS = { label: "Open Payout Runs", actionType: "navigate" as const, payload: "treasury/runs" };

// ─────────────────────────────────────────────────────────────────────────────

async function payeesTool(args: ToolResult): Promise<ToolResult> {
  let payees = await listPayees();
  if (args.search) {
    const n = String(args.search).toLowerCase();
    payees = payees.filter((p) => p.name.toLowerCase().includes(n) || p.code.toLowerCase().includes(n));
  }
  if (args.channel) {
    payees = payees.filter((p) => p.channel === args.channel);
  }
  if (payees.length === 0) {
    return { success: true, message: "No payees match that.", payees: [], quick_actions: [OPEN_PAYEES] };
  }

  const today = new Date().toISOString().slice(0, 10);
  const lines = payees
    .slice(0, 15)
    .map((p) => {
      const expired = p.licenceExpiry && p.licenceExpiry < today;
      const flag = expired ? " ⚠️ licence expired" : "";
      return `- **${p.name}** (\`${p.code}\`) — ${PAYEE_TYPE_LABELS[p.type]} · YTD ${money(p.ytdCommission)}${flag}`;
    })
    .join("\n");

  const expiredCount = payees.filter((p) => p.licenceExpiry && p.licenceExpiry < today).length;
  const warning = expiredCount
    ? `\n\n⚠️ ${expiredCount} payee(s) have an expired licence and cannot be paid until it is renewed.`
    : "";

  return {
    success: true,
    message: `${payees.length} payee(s):\n${lines}${warning}`,
    payees,
    quick_actions: [
      OPEN_PAYEES,
      { label: "View ledger", actionType: "submit", payload: "Show the commission ledger" },
    ],
  };
}

async function calculateTool(args: ToolResult): Promise<ToolResult> {
  const policies = await listPolicies().catch(() => [] as any[]);
  let policy: any = null;

  if (args.policy_number) {
    policy = policies.find((p: any) => p.policy_number === args.policy_number);
  }
  if (!policy && args.policy_id) {
    policy = policies.find((p: any) => p.id === args.policy_id);
  }
  if (!policy && (args.cnic || args.applicant_name)) {
    const n = String(args.applicant_name ?? "").toLowerCase();
    policy = policies.find(
      (p: any) =>
        (args.cnic && p.customer_cnic === args.cnic) ||
        (n && String(p.customer_name ?? "").toLowerCase().includes(n)),
    );
  }
  if (!policy) policy = policies[0];

  if (!policy) {
    return {
      success: false,
      message: "I couldn't find a policy to calculate on. Issue a policy first, or name one explicitly.",
      quick_actions: [{ label: "Open Calculator", actionType: "navigate", payload: "commissions/calculator" }],
    };
  }

  const payees = await listPayees();
  const producer = matchPayee(payees, policy.agent_name) ?? payees[0];
  if (!producer) {
    return { success: false, message: "There are no commission payees set up yet.", quick_actions: [OPEN_PAYEES] };
  }

  const premium =
    Number(args.collected_premium) ||
    Number(policy.annual_premium) ||
    Number(policy.premium_amount) ||
    0;
  const policyYear = Number(args.policy_year) || 1;

  const result = computeCommissionWaterfall(
    {
      leadId: policy.customer_id ?? policy.id,
      policyId: policy.id,
      policyNumber: policy.policy_number ?? "—",
      customerName: policy.customer_name ?? "—",
      productName: policy.product_name ?? "—",
      segment: (policy.segment ?? "individual") as any,
      premiumType: policyYear === 1 ? "FIRST_YEAR" : "RENEWAL",
      policyYear,
      collectedPremium: premium,
      channel: producer.channel,
      producers: [{ payeeId: producer.id, splitPct: 100 }],
      isIssued: true,
      isPremiumCollected: true,
    },
    payees,
  );

  const byName = new Map(payees.map((p) => [p.id, p.name]));
  const rows = result.entries
    .map(
      (e: CommissionLedgerEntry) =>
        `| ${byName.get(e.payeeId) ?? e.payeeId} | ${e.entryKind} | ${e.ratePct}% | ${money(e.grossCommission)} | ${money(e.netCommission)} |`,
    )
    .join("\n");

  return {
    success: true,
    message:
      `**${policy.policy_number ?? policy.id}** — ${policy.customer_name ?? "—"} · ${policy.product_name ?? "—"}\n` +
      `Premium ${money(premium)} · policy year ${policyYear}\n\n` +
      `| Payee | Kind | Rate | Gross | Net |\n| :-- | :-- | --: | --: | --: |\n${rows}\n\n` +
      `**Total gross ${money(result.totalGross)} · net ${money(result.totalNet)}** after withholding.`,
    waterfall: result,
    quick_actions: [
      { label: "Open Calculator", actionType: "navigate", payload: "commissions/calculator" },
      OPEN_LEDGER,
      { label: "Create payout run", actionType: "submit", payload: "Create a payout run for this month" },
    ],
  };
}

async function ledgerTool(args: ToolResult): Promise<ToolResult> {
  const [entries, payees] = await Promise.all([listCommissionLedger(), listPayees()]);
  const byName = new Map(payees.map((p) => [p.id, p.name]));

  let rows = entries;
  if (args.payee_name) {
    const p = matchPayee(payees, args.payee_name);
    if (!p) {
      return { success: false, message: `No payee matching "${args.payee_name}".`, quick_actions: [OPEN_PAYEES] };
    }
    rows = rows.filter((e) => e.payeeId === p.id);
  }
  if (args.status) rows = rows.filter((e) => e.status === args.status);

  if (rows.length === 0) {
    return {
      success: true,
      message: "No commission entries match that. Entries are created when a policy is issued and its premium collected.",
      entries: [],
      quick_actions: [OPEN_LEDGER],
    };
  }

  const limit = Number(args.limit) || 20;
  const totalGross = rows.reduce((s, e) => s + e.grossCommission, 0);
  const totalNet = rows.reduce((s, e) => s + e.netCommission, 0);
  const lines = rows
    .slice(0, limit)
    .map((e) => `- ${byName.get(e.payeeId) ?? e.payeeId} · ${e.entryKind} · ${e.status} — ${money(e.netCommission)} net`)
    .join("\n");

  return {
    success: true,
    message: `${rows.length} entr(ies) — gross ${money(totalGross)}, net ${money(totalNet)}:\n${lines}${rows.length > limit ? "\n…" : ""}`,
    entries: rows,
    quick_actions: [OPEN_LEDGER, { label: "Create payout run", actionType: "submit", payload: "Create a payout run for this month" }],
  };
}

async function statementTool(args: ToolResult): Promise<ToolResult> {
  const [entries, payees] = await Promise.all([listCommissionLedger(), listPayees()]);
  const payee = matchPayee(payees, args.payee_name);
  if (!payee) {
    return {
      success: false,
      message: `No payee matching "${args.payee_name}". Ask me to list payees to see who exists.`,
      quick_actions: [OPEN_PAYEES],
    };
  }

  const mine = entries.filter((e) => e.payeeId === payee.id);
  const gross = mine.reduce((s, e) => s + e.grossCommission, 0);
  const tax = mine.reduce((s, e) => s + (e.whtTax ?? 0), 0);
  const net = mine.reduce((s, e) => s + e.netCommission, 0);
  const period = args.period || currentPeriod();

  return {
    success: true,
    message:
      `**${payee.name}** (\`${payee.code}\`) — statement for ${period}\n\n` +
      `- ${PAYEE_TYPE_LABELS[payee.type]} · ${payee.branch ?? "—"}\n` +
      `- Entries: **${mine.length}**\n` +
      `- Gross: **${money(gross)}**\n` +
      `- Withholding (${payee.taxFilerStatus === "FILER" ? "10%, filer" : "20%, non-filer"}): **${money(tax)}**\n` +
      `- **Net payable: ${money(net)}**`,
    statement: { payee, entries: mine, gross, tax, net, period },
    quick_actions: [
      { label: "Open Statements", actionType: "navigate", payload: "commission-ops/statements" },
      OPEN_LEDGER,
    ],
  };
}

async function summaryTool(): Promise<ToolResult> {
  const [entries, payees] = await Promise.all([listCommissionLedger(), listPayees()]);
  if (entries.length === 0) {
    return {
      success: true,
      message: "No commission has been accrued yet. Entries appear once a policy is issued and its premium collected.",
      quick_actions: [OPEN_LEDGER],
    };
  }

  const byStatus = new Map<string, number>();
  for (const e of entries) byStatus.set(e.status, (byStatus.get(e.status) ?? 0) + e.netCommission);

  const byName = new Map(payees.map((p) => [p.id, p.name]));
  const byPayee = new Map<string, number>();
  for (const e of entries) byPayee.set(e.payeeId, (byPayee.get(e.payeeId) ?? 0) + e.netCommission);
  const top = Array.from(byPayee.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);

  return {
    success: true,
    message:
      `**Commission position** — ${entries.length} entr(ies) across ${byPayee.size} payee(s)\n\n` +
      Array.from(byStatus.entries()).map(([s, v]) => `- ${s}: **${money(v)}**`).join("\n") +
      `\n\n**Top earners**\n` +
      top.map(([id, v], i) => `${i + 1}. ${byName.get(id) ?? id} — ${money(v)}`).join("\n"),
    quick_actions: [
      { label: "Open Commissions", actionType: "navigate", payload: "commissions" },
      OPEN_LEDGER,
      OPEN_RUNS,
    ],
  };
}

async function createRunTool(args: ToolResult): Promise<ToolResult> {
  const period = args.period || currentPeriod();
  // Attributed to the human, not the bot, and with the SAME string the
  // approve path uses — so if they try to approve their own run, the
  // segregation-of-duties check in approvePayoutRun correctly refuses.
  const run = await createPayoutRun({ period, channel: args.channel ?? "ALL", createdBy: actor() });

  if (!run || run.stageCount === 0) {
    return {
      success: false,
      message: `Nothing is due for ${period} — a payout run needs at least one releasable tranche. Entries must be PAYABLE, and the payee's licence must be current.`,
      quick_actions: [OPEN_LEDGER, OPEN_RUNS],
    };
  }

  return {
    success: true,
    message:
      `Created payout run **${run.id}** for ${period}:\n\n` +
      `- Payees: **${run.payeeCount}**\n` +
      `- Tranches: **${run.stageCount}**\n` +
      `- Gross: **${money(run.grossTotal)}**\n` +
      `- Deductions: **${money(run.deductionsTotal)}**\n` +
      `- **Net to disburse: ${money(run.netTotal)}**\n\n` +
      `Status **${run.status}** — it needs a second person to approve before any money moves.`,
    run,
    last_action: {
      tool_name: "create_payout_run",
      entity_type: "payout_run",
      entity_id: run.id,
      route: "treasury/runs",
      label: `Payout run ${run.id} created`,
    },
    quick_actions: [
      { label: "Approve this run", actionType: "submit", payload: `Approve payout run ${run.id}` },
      OPEN_RUNS,
    ],
  };
}

async function approveRunTool(args: ToolResult): Promise<ToolResult> {
  const runs = await listPayoutRuns();
  const run =
    runs.find((r) => r.id === args.run_id) ??
    runs.find((r) => r.status === "PENDING_APPROVAL");

  if (!run) {
    return {
      success: false,
      message: "No payout run is waiting for approval.",
      quick_actions: [
        { label: "Create a run", actionType: "submit", payload: "Create a payout run for this month" },
        OPEN_RUNS,
      ],
    };
  }

  let approved;
  try {
    approved = await approvePayoutRun(run.id, actor());
  } catch (err: any) {
    // Most likely segregation of duties — the signed-in user created this run.
    // Surface that as guidance rather than a failure the user can't act on.
    return {
      success: false,
      message:
        `Run **${run.id}** can't be approved by you: ${err?.message ?? "approval refused"}. ` +
        `Maker–checker requires a second person — ask a colleague to approve it.`,
      quick_actions: [OPEN_RUNS],
    };
  }

  return {
    success: true,
    message:
      `Approved payout run **${run.id}** (${run.period}) — ${run.payeeCount} payee(s), ` +
      `**${money(run.netTotal)}** released for disbursement. Status is now **${approved?.status ?? "APPROVED"}**.`,
    run: approved ?? run,
    last_action: {
      tool_name: "approve_payout_run",
      entity_type: "payout_run",
      entity_id: run.id,
      route: "treasury/runs",
      label: `Payout run ${run.id} approved`,
    },
    quick_actions: [
      OPEN_RUNS,
      { label: "Open Banking", actionType: "navigate", payload: "treasury/banking" },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────

const HANDLERS: Record<string, (args: ToolResult) => Promise<ToolResult>> = {
  list_commission_payees: payeesTool,
  calculate_commission: calculateTool,
  get_commission_ledger: ledgerTool,
  get_agent_statement: statementTool,
  get_commission_summary: summaryTool,
  create_payout_run: createRunTool,
  approve_payout_run: approveRunTool,
};

export const COMMISSION_CLIENT_TOOLS = new Set(Object.keys(HANDLERS));

export function isCommissionTool(name?: string): boolean {
  return !!name && COMMISSION_CLIENT_TOOLS.has(name);
}

/** Run one commission tool in the browser. Never throws — the graph is waiting
 *  on a resume value, so an exception here would hang the conversation. */
export async function runCommissionTool(name: string, args: ToolResult): Promise<ToolResult> {
  const handler = HANDLERS[name];
  if (!handler) return { success: false, error: `Unknown commission tool: ${name}` };
  try {
    return await handler(args ?? {});
  } catch (err: any) {
    return { success: false, error: err?.message || "That commission calculation failed." };
  }
}
