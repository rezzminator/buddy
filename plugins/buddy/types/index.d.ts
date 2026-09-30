// The buddy's $.state contract: the feed its drawer draws, one entry per
// thing that passed between you and the buddy (src/feed.ts FeedEntry).

declare module 'claude-code' {
  interface PluginState {
    buddy: {
      feed: {
        id: number;
        at: number;
        kind: 'you' | 'compact' | 'ask' | 'answer' | 'comment' | 'verdict' | 'suggest' | 'line' | 'failed' | 'clear';
        text: string;
        who?: string;
        color?: string;
        ms?: number;
        tokens?: number;
        taken?: boolean;
        turnId?: string;
        read?: boolean;
        numbers?: string;
        verdict?: 'RIGHT' | 'SHORTCUT' | 'WRONG';
        desire?: string;
      }[];
    };
  }
}

export type FeedKind = 'you' | 'compact' | 'ask' | 'answer' | 'comment' | 'verdict' | 'suggest' | 'line' | 'failed' | 'clear';
