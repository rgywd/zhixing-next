import type { ThemeColors } from "./theme";
import { useTheme, useThemedStyles } from "./ThemeProvider";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AccessibilityInfo, Animated, Easing, Keyboard, KeyboardAvoidingView, Modal, PanResponder, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { radius, space, typography } from "./theme";

export function BottomSheet({ visible, title, subtitle, onClose, children, tall = false }: {
  visible: boolean; title: string; subtitle?: string; onClose: () => void; children: ReactNode; tall?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [mounted, setMounted] = useState(visible);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [progress] = useState(() => new Animated.Value(0));
  const [drag] = useState(() => new Animated.Value(0));
  if (visible && !mounted) setMounted(true);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    // Edge-to-edge Android modals can keep their full window height behind the IME.
    // Bound the panel as well as moving the dock so its scrollable children can shrink.
    const show = Keyboard.addListener("keyboardDidShow", (event) => setKeyboardHeight(event.endCoordinates.height));
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (active) setReduceMotion(value); });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => { active = false; subscription.remove(); };
  }, []);
  const animate = useCallback((toValue: number, done?: () => void) => {
    Animated.timing(progress, { toValue, duration: reduceMotion ? 0 : toValue ? 260 : 190, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start(({ finished }) => { if (finished) done?.(); });
  }, [progress, reduceMotion]);
  useEffect(() => {
    if (visible) { drag.setValue(0); animate(1); }
    else animate(0, () => setMounted(false));
  }, [visible, animate, drag]);
  const dismiss = useCallback(() => {
    Keyboard.dismiss();
    animate(0, () => { setMounted(false); onClose(); });
  }, [animate, onClose]);
  const gesture = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, state) => state.dy > 6 && Math.abs(state.dx) < state.dy,
    onPanResponderMove: (_, state) => drag.setValue(Math.max(0, state.dy)),
    onPanResponderRelease: (_, state) => {
      if (state.dy > 80 || state.vy > 0.8) dismiss();
      else Animated.spring(drag, { toValue: 0, useNativeDriver: true, damping: 22, stiffness: 240 }).start();
    },
    onPanResponderTerminate: () => drag.setValue(0),
  }), [dismiss, drag]);
  const keyboardInset = keyboardHeight ? keyboardHeight + insets.bottom : 0;
  const availableHeight = Math.max(160, height - keyboardInset - insets.top - 24);
  return <Modal visible={mounted} transparent animationType="none" statusBarTranslucent onRequestClose={dismiss}>
    <View style={styles.root}>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: progress, backgroundColor: colors.overlay }]}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel={`关闭${title}`} onPress={dismiss} />
      </Animated.View>
      <KeyboardAvoidingView pointerEvents="box-none" behavior={Platform.OS === "ios" ? "padding" : undefined} style={[styles.dock, { paddingBottom: keyboardInset }]}>
        <Animated.View accessibilityViewIsModal style={[styles.panel, { maxHeight: availableHeight, ...(tall ? { height: Math.min(height * 0.74, availableHeight) } : {}), paddingBottom: keyboardHeight ? 8 : Math.max(insets.bottom, 12), transform: [{ translateY: Animated.add(progress.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }), drag) }] }]}>
          <View {...gesture.panHandlers} style={styles.handleArea}><View style={styles.handle} /></View>
          <View style={styles.header}>
            <View style={styles.heading}><Text accessibilityRole="header" style={styles.title}>{title}</Text>{subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}</View>
            <Pressable accessibilityRole="button" accessibilityLabel={`关闭${title}`} onPress={dismiss} style={styles.close}><Ionicons name="close" size={21} color={colors.muted} /></Pressable>
          </View>
          {children}
        </Animated.View>
      </KeyboardAvoidingView>
    </View>
  </Modal>;
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  dock: { justifyContent: "flex-end", maxHeight: "100%" },
  panel: { backgroundColor: colors.paper, borderTopLeftRadius: 28, borderTopRightRadius: 28, overflow: "hidden", width: "100%", maxWidth: 600, alignSelf: "center" },
  handleArea: { height: 26, justifyContent: "center", alignItems: "center" },
  handle: { width: 32, height: 4, borderRadius: radius.pill, backgroundColor: colors.strongLine },
  header: { flexDirection: "row", alignItems: "center", paddingLeft: 22, paddingRight: space.md, paddingBottom: 12 },
  heading: { flex: 1, gap: 3 },
  title: { ...typography.section, fontSize: 19, color: colors.ink },
  subtitle: { ...typography.caption, color: colors.muted },
  close: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
});
