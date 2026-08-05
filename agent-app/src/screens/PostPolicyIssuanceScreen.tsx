import React from 'react';
import PolicyStageScreen from './PolicyStageScreen';

export default function PostPolicyIssuanceScreen() {
  return (
    <PolicyStageScreen
      stage="POST_ISSUANCE"
      title="Post-Issuance"
      subtitle="active policies and endorsements"
      restrictionNote="Endorsements, rider changes and cancellations require manager authorisation."
      actions={[
        { label: 'Endorsement', gerund: 'Requesting an endorsement', icon: 'create-outline' },
        { label: 'Cancel policy', gerund: 'Cancelling a policy', icon: 'close-circle-outline' },
      ]}
      emptyTitle="No active policies"
      emptyDescription="Policies appear here once they have been issued and the first premium has settled."
    />
  );
}
