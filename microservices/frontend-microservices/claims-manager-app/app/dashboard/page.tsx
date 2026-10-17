import { redirect } from "next/navigation";

// The overview and the analytics are one Dashboard: the manager's overview sits at the top of the Claims Dashboard.
export default function DashboardRedirect() {
  redirect("/claims/dashboard");
}
