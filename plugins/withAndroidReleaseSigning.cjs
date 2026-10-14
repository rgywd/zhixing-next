const { withAppBuildGradle } = require("expo/config-plugins");

module.exports = function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (mod) => {
    const begin = "// zhixing-release-signing-start";
    const end = "// zhixing-release-signing-end";
    const oldStart = mod.modResults.contents.indexOf(begin);
    if (oldStart >= 0) {
      const oldEnd = mod.modResults.contents.indexOf(end, oldStart);
      if (oldEnd < 0) throw new Error("Incomplete Android release signing configuration");
      mod.modResults.contents = mod.modResults.contents.slice(0, oldStart) + mod.modResults.contents.slice(oldEnd + end.length);
    }
    mod.modResults.contents += `
${begin}
// Expo's generated release type inherits debug signing; always remove that fallback.
android.buildTypes.release.signingConfig = null
def zhixingStore = System.getenv("ZHIXING_ANDROID_KEYSTORE")
def zhixingStorePassword = System.getenv("ZHIXING_ANDROID_STORE_PASSWORD")
def zhixingKeyAlias = System.getenv("ZHIXING_ANDROID_KEY_ALIAS")
def zhixingKeyPassword = System.getenv("ZHIXING_ANDROID_KEY_PASSWORD")
def zhixingSigningReady = [zhixingStore, zhixingStorePassword, zhixingKeyAlias, zhixingKeyPassword].every { it != null && !it.isEmpty() }
if (zhixingSigningReady) {
    android.signingConfigs.create("zhixingRelease") {
        storeFile file(zhixingStore)
        storePassword zhixingStorePassword
        keyAlias zhixingKeyAlias
        keyPassword zhixingKeyPassword
    }
    android.buildTypes.release.signingConfig = android.signingConfigs.zhixingRelease
}
// Inspect resolved tasks: aggregate tasks (assemble/build) and abbreviations (aR)
// do not contain "release" in startParameter.taskNames but still build release.
gradle.taskGraph.whenReady { graph ->
    def buildsRelease = graph.allTasks.any { it.project.path == project.path && it.name.toLowerCase().contains("release") }
    if (buildsRelease && !zhixingSigningReady) {
        throw new GradleException("Release signing is missing. Use scripts/build_android_release.py with a private signing file.")
    }
}
${end}
`;
    return mod;
  });
};
