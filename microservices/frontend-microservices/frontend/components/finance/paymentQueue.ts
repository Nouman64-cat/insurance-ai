import type { Claim } from "@/app/services/claims";

export const money = (amount: number) => `PKR ${amount.toLocaleString("en-PK", { maximumFractionDigits: 2 })}`;
export function paymentQueue(claims: Claim[], view: string, search: string) {
  return claims.filter(c => {
    const pending = ["Approved", "Partial Approval"].includes(c.status);
    const paid = ["Settled", "Closed"].includes(c.status) && (c.settlement_amount ?? 0) > 0;
    return (view === "reconciliation" ? c.status === "Settled" && !c.finance_summary?.reconciled_at : view === "history" ? paid : pending) &&
      `${c.claim_number} ${c.policy_number ?? ""} ${c.customer_name ?? ""} ${c.claimant_name}`.toLowerCase().includes(search.toLowerCase());
  });
}

