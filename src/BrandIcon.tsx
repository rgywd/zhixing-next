import { useTheme } from "./ThemeProvider";
import { Image, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { SvgXml } from "react-native-svg";
import { brandMarks } from "./brandMarks";

export function BrandIcon({ name = "", size = 25, search = false }: { name?: string; size?: number; search?: boolean }) {
  const { colors, mode } = useTheme();
  const value = name.toLowerCase();
  let key: keyof typeof brandMarks | undefined;
  if (/qwen|通义|千问/.test(value)) key = "qwen-color";
  else if (/deepseek|深度求索/.test(value)) key = "deepseek-color";
  else if (/gemini|google/.test(value)) key = "gemini-color";
  else if (/claude|anthropic/.test(value)) key = "claude-color";
  else if (/openai|gpt|o[134]-/.test(value)) key = "openai";
  else if (/阿里|bailian|alibaba/.test(value)) key = "alibabacloud-color";
  else if (/brave/.test(value)) key = "brave";
  // Lift Qwen's near-black gradient stop at night instead of adding a plate.
  const artwork = key ? brandMarks[key] : undefined;
  const xml = mode === "dark" && key === "qwen-color" ? artwork?.replace("#00055F", "#A29CFF") : artwork;
  return <View accessible={false} style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
    {/tavily/.test(value) ? <Image source={require("../assets/brands/tavily.png")} style={{ width: size, height: size }} resizeMode="contain" />
      : xml ? <SvgXml xml={xml} width={size} height={size} color={colors.ink} />
      : <Ionicons name={search ? "globe-outline" : "hardware-chip-outline"} size={size} color={search ? colors.blue : colors.gold} />}
  </View>;
}
