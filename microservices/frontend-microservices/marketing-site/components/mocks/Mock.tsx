import type { MockKind } from "@/content/platform";
import { OperationsMock } from "./OperationsMock";
import { AgentMock } from "./AgentMock";
import { ClaimsMock } from "./ClaimsMock";
import { CopilotMock } from "./CopilotMock";
import { FraudMock } from "./FraudMock";
import { UnderwritingMock } from "./UnderwritingMock";

export function Mock({ kind }: { kind: MockKind }) {
  switch (kind) {
    case "finance":
    case "commissions":
    case "customer":
      return <OperationsMock kind={kind} />;
    case "underwriting":
      return <UnderwritingMock />;
    case "copilot":
      return <CopilotMock />;
    case "claims":
      return <ClaimsMock />;
    case "fraud":
      return <FraudMock />;
    case "agent":
      return <AgentMock />;
  }
}
