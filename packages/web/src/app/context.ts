// How full an agent's context window is (`PaneInfo.context`, added by the
// bridge from the agent's transcript, in its enrichers/context/). Shared by the
// meter under each agent's name tag, the roster, the tooltip and the panel.

import type { ContextUsage } from "@kauak/protocol";

export type ContextLevel = "ok" | "warn" | "full";

// Past these shares of the window the meter turns amber, then red: agents
// start compacting (and forgetting) somewhere past 80%.
const WARN = 0.6;
const FULL = 0.85;

export const CONTEXT_COLOR: Record<ContextLevel, number> = { ok: 0x7fd1b9, warn: 0xffb347, full: 0xff6b6b };

export function contextShare(c: ContextUsage): number {
  return c.max > 0 ? Math.min(1, Math.max(0, c.used / c.max)) : 0;
}

export function contextLevel(c: ContextUsage): ContextLevel {
  const s = contextShare(c);
  return s >= FULL ? "full" : s >= WARN ? "warn" : "ok";
}

export function contextPercent(c: ContextUsage): string {
  return `${Math.round(contextShare(c) * 100)}%`;
}

/** "184k of 1M tokens (18%)" */
export function contextText(c: ContextUsage): string {
  return `${tokens(c.used)} of ${tokens(c.max)} tokens (${contextPercent(c)})`;
}

/** 84k, 1.2M */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
