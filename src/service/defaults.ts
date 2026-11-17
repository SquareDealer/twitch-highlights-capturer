import type { DetectorConfig } from './config';

/**
 * The values the service ships with. No Node imports here: the web interface reads them too
 * (the profile editor's «вернуть»).
 */
export function detectorDefaults(): DetectorConfig {
  return {
  chat: {
    windowS: 5, baselineS: 300, alpha: 1, minSpike: 2,
    minTriggerMessages: 3, minTriggerAuthors: 2, minTriggerShare: 0.5, endSpike: 1.5, repeatShare: 0.6,
    laughWords: [
      '^[ах]*ха[ах]*$', '^[ah]*ha[ah]*$', '^ору+$', '^ржу+$', '^ло+л$', '^ке+к$', '^пхп+$', '^хд+$',
      '^lo+l$', '^lmao+$', '^xd+$', '^kekw$', '^lul$', '^omegalul$', '^icant$', '😂', '🤣',
    ],
    reactionWords: [
      '^не+т+$', '^что+$', '^wtf+$', '^f$', '^pog(gers|champ)?$', '^о+мг$', '^omg+$', '^жесть$', '^капец$', '^rip$',
    ],
    interactiveWords: ['^\\d+$', '^[+\\-]+$', '^да+$', '^нет$', '^[a-dа-г]$', '^yes$', '^no$'],
  },
  audio: {
    blockMs: 100, baselineS: 45, spikeDb: 10, spikeVad: 0.5, spikeMinMs: 300,
    triggerDb: 15, triggerVad: 0.7, triggerMinMs: 500,
  },
  events: { warmupS: 60, lookbackS: 20, chatLagS: 8, voiceWindowS: 20, mergeGapS: 10, maxEventS: 60 },
  score: { shareFull: 0.9, spikeFull: 6, audioMinDb: 10, audioFullDb: 20 },
  };
}

/** Clip cutting values that belong to a profile. */
export const CUT_DEFAULTS = {
  preRollMs: 15000,
  preRollLowConfidenceMs: 30000,
  postRollMs: 10000,
  maxClipMs: 90000,
  maxClipsPerHour: 20,
} as const;
