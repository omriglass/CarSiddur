import { useEffect, useRef, useState } from "react";

/**
 * Fullscreen + orientation-lock "table landscape" mode, shared by
 * `TableViewControls` (desktop-inline row) and `SiddurDisplayMenu` (mobile
 * icon menu) so the gnarly fullscreen/orientation-lock orchestration lives
 * in exactly one place (CLAUDE.md Conventions — no duplicated logic between
 * the inline and menu renderings of the same options).
 */
export function useLandscapeToggle(onTableChange: (table: boolean) => void) {
  const [landscape, setLandscape] = useState(false);
  const [rotateHint, setRotateHint] = useState(false);
  const ownsFullscreen = useRef(false);
  useEffect(() => {
    const changed = () => {
      if (!document.fullscreenElement) {
        ownsFullscreen.current = false;
        setLandscape(false);
      }
    };
    document.addEventListener("fullscreenchange", changed);
    return () => {
      document.removeEventListener("fullscreenchange", changed);
      if (ownsFullscreen.current) {
        screen.orientation?.unlock?.();
        void document.exitFullscreen().catch(() => undefined);
      }
    };
  }, []);

  async function exitLandscape() {
    if (ownsFullscreen.current) {
      screen.orientation?.unlock?.();
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
      ownsFullscreen.current = false;
    }
    setLandscape(false);
    setRotateHint(false);
  }

  async function enterLandscape() {
    onTableChange(true);
    setLandscape(true);
    // Orientation lock is optional (not supported by every phone browser).
    const orientation = screen.orientation as ScreenOrientation & { lock?: (value: "landscape") => Promise<void> };
    try {
      if (!orientation?.lock || !document.documentElement.requestFullscreen) throw new Error("unsupported");
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
        ownsFullscreen.current = true;
      }
      await orientation.lock("landscape");
      setRotateHint(false);
    } catch {
      if (ownsFullscreen.current && document.fullscreenElement) {
        await document.exitFullscreen().catch(() => undefined);
        ownsFullscreen.current = false;
      }
      setLandscape(true);
      setRotateHint(true);
    }
  }

  return { landscape, rotateHint, enterLandscape, exitLandscape };
}
