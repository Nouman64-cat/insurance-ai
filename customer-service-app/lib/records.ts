// Looking up the customer and policy a ticket is about, so nobody has to paste an id. These are the platform's own records
// (tenant-service, through the gateway) with the signed-in user's token: what the user may not see does not come back.
import axios from "axios";

const records = axios.create({ baseURL: (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8010").replace(/\/+$/, ""), timeout: 15_000 });
records.interceptors.request.use((config) => {
  if (typeof window !== "undefined") {
    const token = localStorage.getItem("jwt_token");
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export interface CustomerHit { id: string; name: string; cnic?: string | null; city?: string | null; profile_status?: string }
export interface PolicyHit { id: string; policy_number?: string | null; product_name: string; status: string }

const tenant = () => (typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "");

export async function searchCustomers(term: string): Promise<CustomerHit[]> {
  const r = await records.get(`/tenants/${tenant()}/customers`, { params: { search: term } });
  return (r.data as CustomerHit[]).slice(0, 8);
}

export async function customerPolicies(customerId: string): Promise<PolicyHit[]> {
  const r = await records.get(`/tenants/${tenant()}/customers/${customerId}/policies`);
  return r.data as PolicyHit[];
}
