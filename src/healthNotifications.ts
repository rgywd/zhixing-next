import * as Notifications from "expo-notifications";
import * as Crypto from "expo-crypto";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Connection } from "./api";
import type { HealthSummary } from "./serviceApi";
import { dateInZone, planHealthReminders } from "./reminderPlan";

const channelId = "zhixing-health";
const prefix = "zhixing.health.";
let pending = Promise.resolve();

export async function notificationScope(connection: Connection) {
  return (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${connection.url}\n${connection.token}`)).slice(0, 20);
}

export function cancelHealthNotifications(scope?: string, day?: string) {
  const operation = pending.catch(() => undefined).then(async () => {
    for (const item of await Notifications.getAllScheduledNotificationsAsync()) {
      if (item.identifier.startsWith(scope ? `${prefix}${scope}.` : prefix) && (!day || item.content.data?.day === day)) await Notifications.cancelScheduledNotificationAsync(item.identifier);
    }
  });
  pending = operation;
  return operation;
}

export async function pauseHealthNotificationsForToday(connection: Connection) {
  const scope = await notificationScope(connection);
  const zone = await AsyncStorage.getItem(`zhixing.health-zone:${scope}`) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day = dateInZone(new Date(), zone);
  await AsyncStorage.setItem(`zhixing.health-pause:${scope}`, day);
  await cancelHealthNotifications(scope, day);
}

export function syncHealthNotifications(scope: string, summary: HealthSummary, current = () => true) {
  let count = 0;
  const operation = pending.catch(() => undefined).then(async () => {
    if (Platform.OS !== "android" || !current()) return;
    const settings = summary.reminders;
    const permission = await Notifications.getPermissionsAsync();
    const permitted = permission.granted && permission.status === "granted";
    const localPause = await AsyncStorage.getItem(`zhixing.health-pause:${scope}`);
    await AsyncStorage.setItem(`zhixing.health-zone:${scope}`, settings.timezone);
    const plan = permitted ? planHealthReminders(settings, summary.meals, new Date(), scope).filter((item) => item.day !== localPause) : [];
    const expected = new Map(plan.map((item) => [item.identifier, item]));
    const existing = await Notifications.getAllScheduledNotificationsAsync();
    if (!current()) return;
    const retained = new Set<string>();
    for (const item of existing) {
      if (!item.identifier.startsWith(prefix)) continue;
      const desired = expected.get(item.identifier);
      if (desired && item.content.data?.planKey === desired.planKey) retained.add(item.identifier);
      else await Notifications.cancelScheduledNotificationAsync(item.identifier);
    }
    if (settings.enabled && !permitted) throw new Error("饮食提醒尚未安排：请在手机能力或系统设置中允许通知。");
    await Notifications.setNotificationChannelAsync(channelId, { name: "饮食与体重", importance: Notifications.AndroidImportance.DEFAULT });
    const channel = await Notifications.getNotificationChannelAsync(channelId);
    if (settings.enabled && channel?.importance === Notifications.AndroidImportance.NONE) throw new Error("饮食提醒渠道已关闭，请在系统通知设置中打开。");
    for (const item of plan) {
      if (!current()) return;
      if (!retained.has(item.identifier)) await Notifications.scheduleNotificationAsync({
        identifier: item.identifier,
        content: { title: item.kind === "review" ? "和知行回顾一下" : "到约定的用餐时段了",
          body: item.kind === "review" ? "看看最近的记录，聊聊哪里需要调整。" : "看看下一餐建议，吃过后也可以顺手记一下。",
          data: { service: "health", scope, day: item.day, slotId: item.slotId, planKey: item.planKey } },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: item.date, channelId },
      });
    }
    count = plan.length;
  });
  pending = operation;
  return operation.then(() => count);
}
