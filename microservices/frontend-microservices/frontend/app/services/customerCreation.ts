import api from "./api";
import { browserOperationScope, operationHeaders, runOperation } from "@/lib/idempotency";

/** Keep one identity until the customer and optional proposal have both completed. */
export function createCustomer<T extends { id: string }>(
  tenantId: string,
  body: unknown,
  proposal: unknown = null,
  form: "full" | "quick" = "full",
): Promise<T> {
  return runOperation(browserOperationScope(), `customer-create:${tenantId}:${form}`, async key => {
    const response = await api.post<T>(`/tenants/${tenantId}/customers`, body, {
      headers: operationHeaders(key),
    });
    if (proposal) {
      try {
        await api.post(`/tenants/${tenantId}/customers/${response.data.id}/policies`, proposal, {
          headers: operationHeaders(`${key}:proposal`),
        });
      } catch (error) {
        // The customer already exists. Keep its key even if the proposal was
        // rejected, so retrying this form cannot create another customer.
        throw new Error(error instanceof Error ? error.message : "Failed to create proposal.");
      }
    }
    return response.data;
  });
}
