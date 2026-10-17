import React, { useState } from 'react';
import { Screen, ScreenHeader, SegmentedControl } from '../components/ui';
import PolicyStageBody from './policyIssuance/PolicyStageBody';

type Stage = 'PRE_ISSUANCE' | 'POST_ISSUANCE';

/**
 * Policy Issuance — one screen covering both sides of binding a policy:
 * Pre-Issuance (awaiting binding and first premium) and Post-Issuance
 * (active policies and endorsements). Both read-only for agents.
 */
export default function PolicyIssuanceScreen() {
  const [stage, setStage] = useState<Stage>('PRE_ISSUANCE');
  const [subtitle, setSubtitle] = useState('Loading…');

  return (
    <Screen
      scrollable={false}
      padded={false}
      header={
        <ScreenHeader title="Policy Issuance" subtitle={subtitle} leading="back">
          <SegmentedControl<Stage>
            segments={[
              { value: 'PRE_ISSUANCE', label: 'Pending' },
              { value: 'POST_ISSUANCE', label: 'Active' },
            ]}
            value={stage}
            onChange={(next) => {
              setSubtitle('Loading…');
              setStage(next);
            }}
            variant="chips"
          />
        </ScreenHeader>
      }
    >
      {stage === 'PRE_ISSUANCE' ? (
        <PolicyStageBody
          stage="PRE_ISSUANCE"
          restrictionNote="Binding a policy and confirming the first premium require manager authorisation."
          actions={[
            { label: 'Issue & bind', gerund: 'Binding a policy', icon: 'shield-checkmark-outline' },
            { label: 'Confirm payment', gerund: 'Confirming a payment', icon: 'card-outline' },
          ]}
          emptyTitle="Nothing awaiting issuance"
          emptyDescription="Approved cases appear here once they are ready to be bound and paid for."
          onSubtitle={setSubtitle}
        />
      ) : (
        <PolicyStageBody
          stage="POST_ISSUANCE"
          restrictionNote="Endorsements, rider changes and cancellations require manager authorisation."
          actions={[
            { label: 'Endorsement', gerund: 'Requesting an endorsement', icon: 'create-outline' },
            { label: 'Cancel policy', gerund: 'Cancelling a policy', icon: 'close-circle-outline' },
          ]}
          emptyTitle="No active policies"
          emptyDescription="Policies appear here once they have been issued and the first premium has settled."
          onSubtitle={setSubtitle}
        />
      )}
    </Screen>
  );
}
