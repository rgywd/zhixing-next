import { useEffect, useRef, useState } from "react";
import { Linking } from "react-native";
import { checkGitHubUpdate, isReleaseLink, type UpdateResult } from "./appUpdates";

export type UpdateState = { status: "idle" | "checking" } | { status: "done"; result: UpdateResult } | { status: "error"; error: string };

export function useAppUpdate(currentVersion: string) {
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  const [opening, setOpening] = useState(false);
  const [linkError, setLinkError] = useState("");
  const lifetime = useRef({ active: true, generation: 0, check: null as AbortController | null, opening: false });
  useEffect(() => {
    const session = lifetime.current;
    session.active = true;
    return () => { session.active = false; session.generation++; session.check?.abort(); };
  }, []);

  function close() {
    const session = lifetime.current;
    if (!session.active) return;
    session.generation++; session.check?.abort(); session.check = null; session.opening = false;
    setVisible(false); setOpening(false); setLinkError(""); setState({ status: "idle" });
  }

  async function check() {
    const session = lifetime.current;
    if (!session.active || session.check) return;
    const controller = new AbortController(), generation = ++session.generation;
    session.check = controller; session.opening = false;
    setVisible(true); setOpening(false); setLinkError(""); setState({ status: "checking" });
    try {
      const result = await checkGitHubUpdate(currentVersion, controller.signal);
      if (session.active && generation === session.generation) setState({ status: "done", result });
    } catch (error) {
      if (session.active && generation === session.generation && !controller.signal.aborted) setState({ status: "error", error: error instanceof Error ? error.message : "检查更新失败，请重试。" });
    } finally {
      if (session.check === controller) session.check = null;
    }
  }

  async function openLink(url: string) {
    const session = lifetime.current, generation = session.generation;
    if (!session.active || session.opening) return;
    if (!isReleaseLink(url)) { setLinkError("版本链接无效，请重新检查更新。"); return; }
    session.opening = true; setOpening(true); setLinkError("");
    try { await Linking.openURL(url); }
    catch {
      if (session.active && generation === session.generation) setLinkError("未能打开浏览器，请重试，或在浏览器中访问 GitHub 的 rgywd/zhixing-next 发布页。");
    } finally {
      if (session.active && generation === session.generation) { session.opening = false; setOpening(false); }
    }
  }

  return { visible, state, opening, linkError, check, close, openLink };
}
