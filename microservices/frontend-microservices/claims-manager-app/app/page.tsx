import { redirect } from "next/navigation";

// The portal opens on the dashboard.
export default function Home() {
  redirect("/claims/dashboard");
}
