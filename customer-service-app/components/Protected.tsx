"use client";
import { usePathname } from "next/navigation";
import SsoGate from "@/components/satellite/SsoGate";
export default function Protected({children}:{children:React.ReactNode}){
 if(usePathname()==="/sso-problem") return <>{children}</>;
 return <SsoGate>{children}</SsoGate>;
}
