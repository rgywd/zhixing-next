import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import type { Conversation } from "./api";
import { BottomSheet } from "./BottomSheet";
import { ActionLink, Field, IconAction, useUi } from "./ui";
import { localDateKey, scheduleMonthDays } from "./scheduleForm";
import { layout, radius, space } from "./theme";

function selectedMonth(value: string) {
  const parsed = new Date(`${value}T12:00:00`);
  const selected = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return new Date(selected.getFullYear(), selected.getMonth(), 1);
}

export function ScheduleDatePicker({ visible, value, onSelect, onClose }: {
  visible: boolean; value: string; onSelect: (date: string) => void; onClose: () => void;
}) {
  const { s, colors } = useUi();
  const [view, setView] = useState(() => ({ value, visible, month: selectedMonth(value) }));
  let month = view.month;
  if (view.value !== value || view.visible !== visible) {
    if (visible) month = selectedMonth(value);
    setView({ value, visible, month });
  }
  const today = localDateKey(new Date());
  const days = scheduleMonthDays(month.getFullYear(), month.getMonth());
  function move(amount: number) { setView({ value, visible, month: new Date(month.getFullYear(), month.getMonth() + amount, 1) }); }
  return <BottomSheet visible={visible} title="选择日期" subtitle="使用手机当地时间" onClose={onClose}>
    <ScrollView contentContainerStyle={styles.sheet} keyboardShouldPersistTaps="handled">
      <View style={s.spread}>
        <IconAction icon="chevron-back" label="上个月" onPress={() => move(-1)} />
        <Text accessibilityRole="header" style={s.title}>{month.getFullYear()}年{month.getMonth() + 1}月</Text>
        <IconAction icon="chevron-forward" label="下个月" onPress={() => move(1)} />
      </View>
      <View style={styles.week}>{["日", "一", "二", "三", "四", "五", "六"].map((day) => <Text key={day} style={[s.small, styles.weekday]}>{day}</Text>)}</View>
      <View style={styles.grid}>{days.map((day, index) => <View key={day ?? `empty-${index}`} style={styles.cell}>
        {day ? <Pressable accessibilityRole="button" accessibilityLabel={`选择日期 ${day}`} accessibilityState={{ selected: day === value, disabled: day < today }} disabled={day < today} onPress={() => onSelect(day)} style={({ pressed }) => [styles.day, day === value && { backgroundColor: colors.primary }, pressed && s.pressed, day < today && s.disabled]}>
          <Text style={[s.text, day === value && { color: colors.onPrimary }]}>{Number(day.slice(-2))}</Text>
        </Pressable> : null}
      </View>)}</View>
    </ScrollView>
  </BottomSheet>;
}

export function ScheduleConversationPicker({ visible, conversations, selectedId, hasMore, loading = false, error, onLoadMore, onSelect, onClose }: {
  visible: boolean; conversations: Conversation[]; selectedId: string | null; hasMore?: boolean;
  loading?: boolean; error?: string;
  onLoadMore?: () => void; onSelect: (id: string) => void; onClose: () => void;
}) {
  const { s, colors } = useUi();
  const [query, setQuery] = useState("");
  const items = conversations.filter((item) => item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <BottomSheet visible={visible} tall title="结果发到哪个对话" subtitle="执行进度和结果都留在这个对话里" onClose={onClose}>
    <ScrollView contentContainerStyle={styles.sheet} keyboardShouldPersistTaps="handled">
      <Field label="查找对话" placeholder="筛选已加载的对话…" value={query} onChangeText={setQuery} />
      {items.map((item) => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`选择结果对话 ${item.title}`} accessibilityState={{ selected: selectedId === item.id }} onPress={() => onSelect(item.id)} style={({ pressed }) => [s.actionRow, s.rowDivider, pressed && s.pressed]}>
        <Ionicons name="chatbubble-outline" size={19} color={colors.blue} />
        <Text numberOfLines={2} style={[s.text, styles.conversationTitle]}>{item.title}</Text>
        {selectedId === item.id ? <Ionicons name="checkmark" size={20} color={colors.accent} /> : null}
      </Pressable>)}
      {!items.length ? <Text style={s.description}>{conversations.length ? "已加载的对话中没有匹配项。" : "还没有对话，先与知行聊一句，再来安排。"}</Text> : null}
      {error && !loading ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
      {hasMore && onLoadMore ? <ActionLink icon={error ? "refresh-outline" : "chevron-down"} disabled={loading} onPress={() => { if (!loading) onLoadMore(); }}>{loading ? "正在加载对话…" : error ? "重试加载对话" : "加载更多对话"}</ActionLink> : null}
    </ScrollView>
  </BottomSheet>;
}

const styles = StyleSheet.create({
  sheet: { paddingHorizontal: space.md, paddingBottom: space.md, gap: space.sm },
  week: { flexDirection: "row" },
  weekday: { flex: 1, textAlign: "center", paddingVertical: space.sm },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { width: "14.285714%", minHeight: layout.touchTarget },
  day: { minHeight: layout.touchTarget, justifyContent: "center", alignItems: "center", borderRadius: radius.small },
  conversationTitle: { flex: 1 },
});
