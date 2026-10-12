"use client";
import { usePathname } from 'next/navigation';
import Link from 'next/link';
export default function CommissionLayout({children}: {children: React.ReactNode}) {
  const path = usePathname();
  const legacy = path !== '/commissions' && path !== '/commissions/earnings';
  return <>{legacy && <div className="m-4 p-4 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-900">Illustrative commission workspace. These calculations and payout actions do not post to the earnings ledger or settle payments. <Link className="underline font-semibold" href="/commissions">Open persisted earnings</Link></div>}{children}</>;
}
