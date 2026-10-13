import api from "@/app/services/api";
import { registerPendingQuote } from "@/lib/pendingQuotes";

export type DraftEntityType = "INDIVIDUAL" | "FAMILY" | "CORPORATE";

const COLLECTION: Record<DraftEntityType, string> = {
  INDIVIDUAL: "customers",
  FAMILY: "families",
  CORPORATE: "organizations",
};

/**
 * Sends a lead to Proposals by marking it DRAFT. A plan chosen on the full customer form waits in
 * details.pending_plan until now, when it becomes the proposal's policy.
 */
export async function sendLeadToDraft(type: DraftEntityType, id: string, name: string): Promise<void> {
  const tenantId = localStorage.getItem("tenant_id");
  if (!tenantId) throw new Error("No active tenant found.");
  const path = `/tenants/${tenantId}/${COLLECTION[type]}/${id}`;

  if (type === "INDIVIDUAL") {
    const { data: customer } = await api.get(path);
    const { pending_plan, ...restDetails } = customer.details || {};
    if (pending_plan) {
      await api.post(`${path}/policies`, pending_plan);
      registerPendingQuote(id, name);
    }
    await api.put(path, pending_plan ? { profile_status: "DRAFT", details: restDetails } : { profile_status: "DRAFT" });
  } else {
    await api.patch(path, { profile_status: "DRAFT" });
  }
}

/** True when the page is embedded (e.g. in the Copilot panel), where navigating away would break the host. */
export const isEmbedded = (): boolean => typeof window !== "undefined" && window.parent !== window;
