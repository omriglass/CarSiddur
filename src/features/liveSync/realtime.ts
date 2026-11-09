import type { RealtimeChannel } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";

import type { ChannelHandlers, WatchScope } from "./watcher";

/**
 * Private Realtime broadcast channels for the change watch (REQ item 149, D2). Topic
 * `week:<department>:<week>:<public|sadran>`, event `changed`, payload `{ seq, tab }` (`tab` = the changing page's
 * `x-tab-id`, O28-8) — sent by the
 * database at commit (`_wcs_flush()`), joined only when RLS on `realtime.messages` allows it
 * (`realtime_topic_authorized`). supabase-js multiplexes every channel of the tab over one socket
 * and closes the socket when the last channel is removed.
 *
 * Two screens of one tab watching the same topic share one channel (reference counted), so closing
 * one never tears down the other's. A channel nobody watches any more stays open for
 * `LEAVE_LINGER_MS` first: moving between screens (siddur ⇄ my rides) unmounts the old screen before
 * the new one subscribes, and every join costs a `realtime.authorize` call in the database (PF1).
 */
export const LEAVE_LINGER_MS = 60_000;

interface SharedChannel {
  channel: RealtimeChannel;
  listeners: Set<ChannelHandlers>;
  status: "connecting" | "live" | "failed";
  detail?: string;
  transient?: boolean;
  lingerTimer?: ReturnType<typeof setTimeout>;
}

const shared = new Map<string, SharedChannel>();

export function weekTopic(departmentId: string, weekStart: string, scope: WatchScope): string {
  return `week:${departmentId}:${weekStart}:${scope}`;
}

function seqOf(payload: unknown): number | null {
  const seq = (payload as { seq?: unknown } | null | undefined)?.seq;
  return typeof seq === "number" ? seq : null;
}

function tabOf(payload: unknown): string | null {
  const tab = (payload as { tab?: unknown } | null | undefined)?.tab;
  return typeof tab === "string" ? tab : null;
}

/**
 * A network drop rather than a server answer: the socket's own error/close event, a missed heartbeat,
 * a join timeout or close. These happen whenever a phone sleeps, a PWA goes to the background or the
 * network switches (production 2026-11: ~25 a day, none a refusal) and heal on the next retry. A
 * server reply refusing the join (RLS, auth, limits) is not one.
 */
export function isTransportDrop(status: string, error?: Error): boolean {
  if (status !== "CHANNEL_ERROR") return true;
  const message = error?.message ?? "";
  return (
    message === "" ||
    message.startsWith("channel error: ") ||
    message.startsWith("socket closed: ") ||
    message === "heartbeat timeout" ||
    (typeof Event !== "undefined" && error?.cause instanceof Event)
  );
}

function open(topic: string): SharedChannel {
  const channel = supabase.channel(topic, { config: { private: true } });
  const entry: SharedChannel = { channel, listeners: new Set(), status: "connecting" };
  channel.on("broadcast", { event: "changed" }, (message) => {
    const seq = seqOf(message.payload);
    const tab = tabOf(message.payload);
    for (const listener of entry.listeners) listener.onChange(seq, tab);
  });
  // Private channels need the user's JWT on the socket before joining.
  void supabase.realtime
    .setAuth()
    .catch(() => undefined)
    .then(() => {
      if (shared.get(topic) !== entry) return;
      channel.subscribe((status, error) => {
        if (shared.get(topic) !== entry) return;
        if (status === "SUBSCRIBED") {
          entry.status = "live";
          for (const listener of entry.listeners) listener.onStatus("live");
          return;
        }
        // CHANNEL_ERROR (refused by RLS, rate/connection limits), TIMED_OUT, CLOSED by the server.
        entry.status = "failed";
        entry.detail = error?.message ? `${status}: ${error.message}` : status;
        entry.transient = isTransportDrop(status, error);
        shared.delete(topic);
        void supabase.removeChannel(channel);
        for (const listener of [...entry.listeners]) listener.onStatus("failed", entry.detail, entry.transient);
      });
    });
  shared.set(topic, entry);
  return entry;
}

/** Joins (or shares) the week's channel; returns the function that leaves it. */
export function subscribeWeekTopic(departmentId: string, weekStart: string, scope: WatchScope, handlers: ChannelHandlers): () => void {
  const topic = weekTopic(departmentId, weekStart, scope);
  const entry = shared.get(topic) ?? open(topic);
  clearTimeout(entry.lingerTimer);
  entry.lingerTimer = undefined;
  entry.listeners.add(handlers);
  if (entry.status === "live") queueMicrotask(() => entry.listeners.has(handlers) && handlers.onStatus("live"));
  return () => {
    entry.listeners.delete(handlers);
    if (entry.listeners.size > 0 || shared.get(topic) !== entry) return;
    clearTimeout(entry.lingerTimer);
    entry.lingerTimer = setTimeout(() => {
      entry.lingerTimer = undefined;
      if (entry.listeners.size > 0 || shared.get(topic) !== entry) return;
      shared.delete(topic);
      void supabase.removeChannel(entry.channel);
    }, LEAVE_LINGER_MS);
  };
}
