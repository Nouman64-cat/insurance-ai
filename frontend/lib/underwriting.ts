/**
 * Line-of-business benchmark figures shared across the executive dashboard —
 * illustrative weights/loss ratios, consistent with the rest of the
 * prototype's simulated LoB figures. Factored out of UnderwritingCard so the
 * Underwriting Insights card can flag the worst-performing line from the
 * same source instead of a second hand-maintained copy.
 */
export interface LineOfBusiness {
  name: string;
  shortName: string;
  weight: number;
  lossRatio: number;
  color: string; // tailwind bg-* class
}

export const LINES_OF_BUSINESS: LineOfBusiness[] = [
  { name: "Individual Life & Health", shortName: "Ind. Life", weight: 0.45, lossRatio: 36.2, color: "bg-blue-600" },
  { name: "Group Life & Protection", shortName: "Group Life", weight: 0.30, lossRatio: 42.8, color: "bg-indigo-600" },
  { name: "Bancassurance Portfolio", shortName: "Bancas.", weight: 0.15, lossRatio: 29.5, color: "bg-emerald-600" },
  { name: "Corporate Micro-Takaful", shortName: "Takaful", weight: 0.10, lossRatio: 51.0, color: "bg-purple-600" },
];

/** The line of business with the highest loss ratio — the one worth flagging for pricing review. */
export function worstLossRatioLine(): LineOfBusiness {
  return LINES_OF_BUSINESS.reduce((worst, lob) => (lob.lossRatio > worst.lossRatio ? lob : worst));
}
