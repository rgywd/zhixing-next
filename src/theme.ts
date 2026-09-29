// Life is the visual baseline. Shared UI owns these values; pages own composition.
export const colors = {
  paper: "#FBF7F1",
  white: "#FFFFFF",
  surface: "#FFFCFA",
  ink: "#25252D",
  accent: "#A6322C",
  muted: "#77777F",
  line: "#EBE6E2",
  pale: "#F8E9E6",
  red: "#B3261E",
  amber: "#8A5A28",
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
export const radius = { small: 12, control: 16, item: 20, card: 25, pill: 999 };
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
