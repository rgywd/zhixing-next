import { useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { request, type Connection } from "./api";
import type { HealthSummary } from "./serviceApi";
import { cancelHealthNotifications, notificationScope, syncHealthNotifications } from "./healthNotifications";
import { useNotice } from "./Notice";
import { humanError } from "./ui";

export function useHealthReminders(connection: Connection, revision: number, onOpen: () => void) {
  const open = useRef(onOpen);
  const handled = useRef<string | null>(null);
  useEffect(() => { open.current = onOpen; }, [onOpen]);
  const { show, dismiss } = useNotice();
  useEffect(() => {
    if (Platform.OS !== "android") return;
    Notifications.setNotificationHandler({ handleNotification: async () => ({
      shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false,
    }) });
    let active = true, syncing = false;
    let scope: string | undefined;
    const controller = new AbortController();
    async function sync() {
      if (!active || syncing || AppState.currentState !== "active") return;
      syncing = true;
      try {
        scope ??= await notificationScope(connection);
        const summary = await request<HealthSummary>(connection, "/health/summary", { signal: controller.signal });
        if (!active) return;
        await syncHealthNotifications(scope, summary, () => active);
        if (active) dismiss("health-reminders");
      } catch (error) {
        if (active) show({ id: "health-reminders", message: humanError(error), tone: "warning", duration: null });
      } finally { syncing = false; }
    }
    const respond = (response: Notifications.NotificationResponse | null) => {
      const data = response?.notification.request.content.data;
      const id = response?.notification.request.identifier;
      if (active && id && id !== handled.current && data?.service === "health" && data.scope === scope) {
        handled.current = id;
        open.current();
      }
    };
    void notificationScope(connection).then(async (value) => {
      scope = value;
      if (active) respond(await Notifications.getLastNotificationResponseAsync());
    }).catch(() => undefined);
    const responseListener = Notifications.addNotificationResponseReceivedListener(respond);
    const foregroundListener = AppState.addEventListener("change", (state) => { if (state === "active") void sync(); });
    void sync();
    const timer = setInterval(() => { void sync(); }, 30000);
    return () => { active = false; controller.abort(); clearInterval(timer); responseListener.remove(); foregroundListener.remove(); dismiss("health-reminders"); };
  }, [connection, revision, show, dismiss]);
  // Connection changes or disconnects retire the old device schedules as well.
  useEffect(() => {
    const savedScope = notificationScope(connection);
    return () => { void savedScope.then((scope) => cancelHealthNotifications(scope)).catch(() => undefined); };
  }, [connection]);
}
