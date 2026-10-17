// Read the backend's rule result and receipt snapshot; never calculate a new split in chat.
export function paymentSummary(payment: string, ipp: any): string {
  const paid = payment === "paid";
  const amount = Number(paid ? ipp?.amount ?? 0 : ipp?.amount_due ?? ipp?.amount ?? 0);
  const money = (value: number) => value.toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const due = amount ? ` of **PKR ${money(amount)}**` : "";
  let summary = "";
  switch (payment) {
    case "paid": summary = `✅ Initial premium${due} received${ipp?.method ? ` (${ipp.method}${ipp.reference ? `, ref ${ipp.reference}` : ""})` : ""}.`; break;
    case "proof": summary = `🧾 The customer ${ipp?.proof_artifact_id ? "uploaded a receipt" : "says they have paid"}${due}${ipp?.proof_method ? ` by ${ipp.proof_method}` : ""}${ipp?.proof_reference ? ` (ref ${ipp.proof_reference})` : ""}.`; break;
    case "requested": summary = `⏳ Initial premium${due} requested${ipp?.link_expired ? " — **the link has expired**, resend it" : ""}. Waiting for the customer.`; break;
    case "due": summary = `💳 An initial premium${due} is due before this application can go to underwriting.`; break;
    default: return "";
  }
  const split = (paid ? ipp?.breakdown : ipp?.breakdown_due ?? ipp?.breakdown)?.split;
  if (!split) return summary;
  if (Number(split.remaining_amount) > 0) {
    summary += `\n\n**Premium split${split.rule_code ? ` · ${split.rule_code}` : ""}**\n- Before underwriting: **${split.upfront_pct}% — PKR ${money(Number(split.upfront_amount))}**${paid ? " (received)" : ""}.\n- At policy issuance: **${split.remaining_pct}% — PKR ${money(Number(split.remaining_amount))}**, plus any underwriting loading.\n${paid ? "The upfront receipt is credited against the final premium; only the outstanding balance is collected at issuance." : "The final issuance balance is confirmed after underwriting."}`;
  } else {
    summary += `\n\nThe rule requires **${split.upfront_pct}% upfront**. This receipt will be credited at issuance; any additional amount due is determined from the final premium.`;
  }
  return summary;
}
