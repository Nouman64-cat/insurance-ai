import Link from "next/link";
export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="text-center"><p className="text-5xl font-black text-slate-300">404</p><p className="mt-2 text-sm text-slate-500">This page does not exist.</p>
        <Link href="/dashboard" className="btn-primary mt-5 inline-flex">Go to dashboard</Link></div>
    </div>
  );
}
