import React from 'react';
import PolicyStageScreen from './PolicyStageScreen';

export default function PrePolicyIssuanceScreen() {
  return (
    <PolicyStageScreen
      stage="PRE_ISSUANCE"
      title="Pre-Issuance"
      subtitle="awaiting binding and first premium"
      restrictionNote="Binding a policy and confirming the first premium require manager authorisation."
      actions={[
        { label: 'Issue & bind', gerund: 'Binding a policy', icon: 'shield-checkmark-outline' },
        { label: 'Confirm payment', gerund: 'Confirming a payment', icon: 'card-outline' },
      ]}
      emptyTitle="Nothing awaiting issuance"
      emptyDescription="Approved cases appear here once they are ready to be bound and paid for."
    />
  );
}
