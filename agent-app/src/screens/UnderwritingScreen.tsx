import React, { useState } from 'react';
import { Screen, ScreenHeader, SegmentedControl } from '../components/ui';
import PreUnderwritingBody from './underwriting/PreUnderwritingBody';
import RiskEngineBody from './underwriting/RiskEngineBody';
import PostUnderwritingBody from './underwriting/PostUnderwritingBody';

type Stage = 'PRE' | 'RISK' | 'POST';

const STAGE_TITLE: Record<Stage, string> = {
  PRE: 'Pre-Underwriting',
  RISK: 'Risk Engine',
  POST: 'Post-Underwriting',
};

/**
 * The three underwriting stages a case moves through after a proposal:
 * Pre-Underwriting (the 6 gates — full agent access), Risk Engine (AI
 * assessment — read-only), and Post-Underwriting (Stage A pre-issuance
 * verification — read-only). One screen, one stage picker, three bodies.
 */
export default function UnderwritingScreen() {
  const [stage, setStage] = useState<Stage>('PRE');
  const [subtitle, setSubtitle] = useState('Loading…');

  return (
    <Screen
      scrollable={false}
      padded={false}
      header={
        <ScreenHeader title={STAGE_TITLE[stage]} subtitle={subtitle} leading="back">
          <SegmentedControl<Stage>
            segments={[
              { value: 'PRE', label: 'Pre-UW' },
              { value: 'RISK', label: 'Risk Engine' },
              { value: 'POST', label: 'Post-UW' },
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
      {stage === 'PRE' ? <PreUnderwritingBody onSubtitle={setSubtitle} /> : null}
      {stage === 'RISK' ? <RiskEngineBody onSubtitle={setSubtitle} /> : null}
      {stage === 'POST' ? <PostUnderwritingBody onSubtitle={setSubtitle} /> : null}
    </Screen>
  );
}
