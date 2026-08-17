"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function RateCardPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/commissions");
  }, [router]);

  return null;
}

