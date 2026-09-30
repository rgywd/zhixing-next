// Surfaces and foregrounds are separate so a theme never inverts button labels.
export const lightColors = {
  paper: "#FAFAF9",
  surface: "#FFFFFF",
  surfaceRaised: "#FFFFFF",
  ink: "#202125",
  onInk: "#FFFFFF",
  accent: "#B53632",
  pale: "#FAEEEC",
  primary: "#B53632",
  onPrimary: "#FFFFFF",
  muted: "#6C6C72",
  line: "#E7E7E6",
  strongLine: "#C6C3BC",
  neutral: "#F1F1EF",
  red: "#B3261E",
  amber: "#88631C",
  blue: "#2C648E",
  blueSoft: "#ECF3FA",
  blueLine: "#ADC7DE",
  gold: "#89651E",
  goldSoft: "#F6F0E2",
  khaki: "#756F5E",
  green: "#396A4D",
  greenSoft: "#EAF2EC",
  overlay: "rgba(20, 20, 22, 0.32)",
  shadow: "#18181B",
  switchThumb: "#FFFFFF",
  brandPlate: "#F1F1EF",
};

export type ThemeColors = typeof lightColors;
export const darkColors: ThemeColors = {
  paper: "#131211",
  surface: "#1B1A19",
  surfaceRaised: "#23211F",
  ink: "#F2F1EE",
  onInk: "#171615",
  accent: "#C4AE86",
  pale: "#302A20",
  primary: "#E6E1D8",
  onPrimary: "#181715",
  muted: "#ABA6A0",
  line: "#36332F",
  strongLine: "#625D53",
  neutral: "#282624",
  red: "#F09588",
  amber: "#CCB47C",
  blue: "#94BCDB",
  blueSoft: "#1D2A34",
  blueLine: "#425F75",
  gold: "#C6AB73",
  goldSoft: "#2E291E",
  khaki: "#B3AC96",
  green: "#A3C2AA",
  greenSoft: "#233129",
  overlay: "rgba(0, 0, 0, 0.64)",
  shadow: "#000000",
  switchThumb: "#F2F1EE",
  brandPlate: "#DDD8CE",
};

export type ThemeMode = "light" | "dark";
export type ThemePreference = ThemeMode | "system";
export const themePreferenceKey = "zhixing.appearance.v1";
export const parseThemePreference = (value: unknown): ThemePreference =>
  value === "light" || value === "dark" ? value : "system";
export const resolveThemeMode = (preference: ThemePreference, system: string | null | undefined): ThemeMode =>
  preference === "system" ? system === "dark" ? "dark" : "light" : preference;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
export const radius = { small: 10, control: 12, item: 16, card: 20, pill: 999 };
export const layout = { gutter: 16, pageGap: 14, cardPadding: 14, heroHeight: 116, touchTarget: 44, compactWidth: 360, tabClearance: 132 };

export const typography = {
  kicker: { fontSize: 12, lineHeight: 18, fontWeight: "700", letterSpacing: 0.5 },
  hero: { fontSize: 31, lineHeight: 42, fontWeight: "700" },
  title: { fontSize: 23, lineHeight: 32, fontWeight: "700" },
  section: { fontSize: 17, lineHeight: 24, fontWeight: "700" },
  item: { fontSize: 15, lineHeight: 22, fontWeight: "600" },
  body: { fontSize: 13, lineHeight: 21 },
  reading: { fontSize: 15, lineHeight: 24 },
  button: { fontSize: 14, lineHeight: 20, fontWeight: "600" },
  caption: { fontSize: 11, lineHeight: 18 },
  detail: { fontSize: 12, lineHeight: 19 },
  small: { fontSize: 10, lineHeight: 15 },
} as const;
