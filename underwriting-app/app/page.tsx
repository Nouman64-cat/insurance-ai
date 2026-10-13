import { redirect } from "next/navigation";

// The workbench opens on the underwriting queue.
export default function Home() {
  redirect("/underwriting");
}
