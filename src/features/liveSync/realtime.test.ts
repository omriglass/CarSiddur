import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ channel: vi.fn(), removeChannel: vi.fn(), setAuth: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { channel: mocks.channel, removeChannel: mocks.removeChannel, realtime: { setAuth: mocks.setAuth } },
}));

import { LEAVE_LINGER_MS, subscribeWeekTopic } from "./realtime";

const handlers = () => ({ onChange: vi.fn(), onStatus: vi.fn() });

describe("subscribeWeekTopic", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.setAuth.mockResolvedValue(undefined);
    mocks.channel.mockImplementation(() => {
      const channel = { on: vi.fn(() => channel), subscribe: vi.fn() };
      return channel;
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("keeps a left channel for the next screen instead of joining again (PF1)", () => {
    const leaveMy = subscribeWeekTopic("d1", "2026-11-08", "public", handlers());
    leaveMy();
    vi.advanceTimersByTime(LEAVE_LINGER_MS - 1);
    const leaveSiddur = subscribeWeekTopic("d1", "2026-11-08", "public", handlers());
    expect(mocks.channel).toHaveBeenCalledTimes(1);
    expect(mocks.removeChannel).not.toHaveBeenCalled();

    leaveSiddur();
    vi.advanceTimersByTime(LEAVE_LINGER_MS);
    expect(mocks.removeChannel).toHaveBeenCalledTimes(1);
  });

  it("joins afresh once the linger has passed", () => {
    subscribeWeekTopic("d2", "2026-11-08", "public", handlers())();
    vi.advanceTimersByTime(LEAVE_LINGER_MS);
    expect(mocks.removeChannel).toHaveBeenCalledTimes(1);
    subscribeWeekTopic("d2", "2026-11-08", "public", handlers());
    expect(mocks.channel).toHaveBeenCalledTimes(2);
  });
});
