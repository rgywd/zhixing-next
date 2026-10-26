package dev.zhixing.updates

import android.Manifest
import android.content.ClipData
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.system.Os
import android.system.OsConstants
import androidx.core.content.FileProvider
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.launch
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

private const val APK_MIME = "application/vnd.android.package-archive"
private const val UPDATE_DIRECTORY = "zhixing-updates"
private const val MAX_APK_BYTES = 512L * 1024 * 1024
private const val MAX_VERIFIED_COPIES = 4
private const val MAX_VERIFIED_BYTES = 1024L * 1024 * 1024
private const val PROTECTED_COPY_MILLIS = 30L * 60 * 1000
private const val EXPIRED_COPY_MILLIS = 24L * 60 * 60 * 1000
private const val MIN_FREE_BYTES = 16L * 1024 * 1024
private val VERIFIED_FILENAME = Regex("verified-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.apk")
private val SHA256 = Regex("[0-9a-fA-F]{64}")
private val VERSION = Regex("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)")
private val APK_FILENAME = Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,160}\\.apk")

/** No network, external-storage files, credentials, or application-content logs. */
class ZhixingUpdatesModule : Module() {
  private val installing = AtomicBoolean(false)

  private fun failure(code: String, message: String): Nothing = throw CodedException(code, message, null)
  private fun context(): Context = appContext.reactContext
    ?: failure("ERR_UPDATE_UNAVAILABLE", "更新服务暂不可用，请重新打开应用后重试。")

  override fun definition() = ModuleDefinition {
    Name("ZhixingUpdates")

    AsyncFunction("canInstallAsync") {
      try {
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context().packageManager.canRequestPackageInstalls()
      } catch (_: Exception) {
        failure("ERR_UPDATE_UNAVAILABLE", "暂时无法检查安装权限，请重试。")
      }
    }

    AsyncFunction("openInstallSettingsAsync") {
      val ctx = context()
      val activity = appContext.currentActivity
        ?: failure("ERR_UPDATE_UNAVAILABLE", "请回到应用中再打开安装设置。")
      val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}"))
      } else {
        Intent(Settings.ACTION_SECURITY_SETTINGS)
      }
      try {
        activity.startActivity(intent)
      } catch (_: Exception) {
        failure("ERR_UPDATE_SETTINGS", "无法打开安装权限设置，请在系统设置中允许知行安装应用。")
      }
      // Opening settings does not mean the user granted permission.
      Unit
    }.runOnQueue(Queues.MAIN)

    // Expo's default native AsyncFunction queue keeps streaming I/O and parsing
    // off the UI thread. Only the final system UI handoff runs on the main queue.
    AsyncFunction("installApkAsync") { uri: String, expectedSha256: String, expectedSize: Double, expectedVersion: String, promise: Promise ->
      if (!installing.compareAndSet(false, true)) {
        promise.reject("ERR_UPDATE_BUSY", "正在准备安装，请稍候。", null)
      } else {
        var verified: File? = null
        try {
          val ctx = context()
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !ctx.packageManager.canRequestPackageInstalls()) {
            failure("ERR_UPDATE_PERMISSION", "请先允许知行安装应用，再继续安装。")
          }
          val ready = verifyApk(ctx, uri, expectedSha256, expectedSize, expectedVersion)
          verified = ready
          appContext.mainQueue.launch {
            try {
              launchInstaller(ctx, ready)
              // This promise confirms the installer opened, never installation.
              promise.resolve()
            } catch (error: CodedException) {
              ready.delete()
              promise.reject(error)
            } catch (_: Exception) {
              ready.delete()
              promise.reject("ERR_UPDATE_INSTALLER", "无法打开系统安装界面，请重试。", null)
            } finally {
              installing.set(false)
            }
          }
        } catch (error: CodedException) {
          verified?.delete()
          installing.set(false)
          promise.reject(error)
        } catch (_: Exception) {
          verified?.delete()
          installing.set(false)
          promise.reject("ERR_UPDATE_VERIFY", "安装包校验未通过，请重新下载。", null)
        }
      }
    }
  }

  private fun selectedFile(ctx: Context, value: String): Pair<File, File> {
    val uri = Uri.parse(value)
    if (uri.scheme != "file" || !uri.authority.isNullOrEmpty() || uri.query != null || uri.fragment != null) {
      failure("ERR_UPDATE_PATH", "安装包位置无效，请重新下载。")
    }
    val path = uri.path ?: failure("ERR_UPDATE_PATH", "安装包位置无效，请重新下载。")
    if (path.split('/').any { it == "." || it == ".." }) {
      failure("ERR_UPDATE_PATH", "安装包位置无效，请重新下载。")
    }
    val directory = File(ctx.cacheDir, UPDATE_DIRECTORY)
    val cache = ctx.cacheDir.canonicalFile
    val root = directory.canonicalFile
    if (!OsConstants.S_ISDIR(Os.lstat(directory.path).st_mode) || root.parentFile != cache) {
      failure("ERR_UPDATE_PATH", "安装包位置无效，请重新下载。")
    }
    val file = File(path)
    // Only a direct child is accepted, allowing Android's own /data/user aliases
    // while rejecting symlinks or traversal within the selected private folder.
    if (!APK_FILENAME.matches(file.name) || file.parentFile?.absolutePath !in setOf(directory.absolutePath, root.path)
      || file.canonicalFile != File(root, file.name) || !OsConstants.S_ISREG(Os.lstat(file.path).st_mode)) {
      failure("ERR_UPDATE_PATH", "安装包位置无效，请重新下载。")
    }
    return Pair(root, file.canonicalFile)
  }

  private fun verifyApk(ctx: Context, uri: String, expectedSha256: String, expectedSize: Double, expectedVersion: String): File {
    if (!SHA256.matches(expectedSha256) || !VERSION.matches(expectedVersion) || !expectedSize.isFinite()
      || expectedSize < 1 || expectedSize > MAX_APK_BYTES || expectedSize != expectedSize.toLong().toDouble()) {
      failure("ERR_UPDATE_METADATA", "更新信息不完整，请重新检查更新。")
    }
    val size = expectedSize.toLong()
    val (root, source) = selectedFile(ctx, uri)
    reserveVerifiedCopy(root, source, size)
    val verified = File(root, "verified-${UUID.randomUUID()}.apk")
    try {
      // O_NOFOLLOW closes the final-component symlink race. The unguessable,
      // native-created copy is the exact byte sequence later parsed and shared.
      val inputFd = Os.open(source.path, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC, 0)
      FileInputStream(inputFd).use { input ->
        val info = Os.fstat(inputFd)
        if (!OsConstants.S_ISREG(info.st_mode) || info.st_size != size) {
          failure("ERR_UPDATE_SIZE", "安装包大小不正确，请重新下载。")
        }
        val outputFd = Os.open(verified.path,
          OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC,
          OsConstants.S_IRUSR or OsConstants.S_IWUSR)
        val digest = MessageDigest.getInstance("SHA-256")
        var copied = 0L
        FileOutputStream(outputFd).use { output ->
          val buffer = ByteArray(64 * 1024)
          while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            copied += count
            if (copied > size) failure("ERR_UPDATE_SIZE", "安装包大小不正确，请重新下载。")
            digest.update(buffer, 0, count)
            output.write(buffer, 0, count)
          }
          output.fd.sync()
        }
        if (copied != size || !MessageDigest.isEqual(digest.digest(), hexBytes(expectedSha256))) {
          failure("ERR_UPDATE_HASH", "安装包校验未通过，请重新下载。")
        }
      }
      Os.chmod(verified.path, OsConstants.S_IRUSR)
      verifyPackage(ctx, verified, expectedVersion)
      return verified
    } catch (error: Exception) {
      verified.delete()
      throw error
    }
  }

  /** Only an explicit installation attempt prunes native copies; downloads stay untouched. */
  private fun reserveVerifiedCopy(root: File, source: File, incomingBytes: Long) {
    val now = System.currentTimeMillis()
    val files = root.listFiles { file -> VERIFIED_FILENAME.matches(file.name) }
      ?.toMutableList() ?: failure("ERR_UPDATE_STORAGE", "暂时无法准备安装包，请稍后重试。")
    for (file in files) {
      if (!OsConstants.S_ISREG(Os.lstat(file.path).st_mode) || file.canonicalFile != file) {
        failure("ERR_UPDATE_PATH", "更新缓存位置无效，请重新下载。")
      }
    }
    // Recent copies may still be consumed by an open system installer. The
    // selected input is protected even if a caller explicitly reuses an old copy.
    fun isProtected(file: File): Boolean = file == source || now - file.lastModified() < PROTECTED_COPY_MILLIS
    fun remove(file: File) {
      if (!file.delete()) failure("ERR_UPDATE_STORAGE", "暂时无法整理更新缓存，请稍后重试。")
      files.remove(file)
    }
    files.filter { !isProtected(it) && now - it.lastModified() >= EXPIRED_COPY_MILLIS }.forEach { remove(it) }
    files.filter { !isProtected(it) }.sortedByDescending { it.lastModified() }.drop(2).forEach { remove(it) }
    // Reserve the next copy before writing any bytes. Older unprotected copies
    // can make room; fresh copies are never removed merely to meet the cap.
    while (files.size + 1 > MAX_VERIFIED_COPIES || files.sumOf { it.length() } + incomingBytes > MAX_VERIFIED_BYTES) {
      val oldest = files.filter { !isProtected(it) }.minByOrNull { it.lastModified() }
        ?: failure("ERR_UPDATE_STORAGE", "安装包准备次数较多，请稍后重试。")
      remove(oldest)
    }
    if (root.usableSpace < incomingBytes + MIN_FREE_BYTES) {
      failure("ERR_UPDATE_STORAGE", "设备可用空间不足，暂时无法准备安装包。")
    }
  }

  @Suppress("DEPRECATION")
  private fun verifyPackage(ctx: Context, file: File, expectedVersion: String) {
    val manager = ctx.packageManager
    val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
    val archive = manager.getPackageArchiveInfo(file.path, flags)
      ?: failure("ERR_UPDATE_PACKAGE", "无法读取安装包，请重新下载。")
    val installed = manager.getPackageInfo(ctx.packageName, flags)
    if (archive.packageName != ctx.packageName || archive.versionName != expectedVersion) {
      failure("ERR_UPDATE_PACKAGE", "安装包与此应用或目标版本不匹配。")
    }
    val archiveCode = versionCode(archive)
    val installedCode = versionCode(installed)
    if (archiveCode < installedCode || archiveCode == installedCode && installed.versionName != expectedVersion) {
      failure("ERR_UPDATE_VERSION", "安装包版本与当前应用不匹配，请重新检查更新。")
    }
    // An explicit reinstall may use the identical version/code; a lower code or
    // an equal code with a different version name is never an update candidate.
    if (signerDigests(archive) != signerDigests(installed)) {
      failure("ERR_UPDATE_SIGNATURE", "安装包签名不匹配，已停止安装。")
    }
  }

  @Suppress("DEPRECATION")
  private fun versionCode(info: PackageInfo): Long = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()

  @Suppress("DEPRECATION")
  private fun signerDigests(info: PackageInfo): Set<String> {
    // Strict current-signer equality intentionally does not authorize rotations.
    val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.signingInfo?.apkContentsSigners else info.signatures
    if (signatures.isNullOrEmpty()) failure("ERR_UPDATE_SIGNATURE", "无法核对安装包签名，已停止安装。")
    return signatures.map { signature ->
      MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) }
    }.toSet()
  }

  private fun hexBytes(value: String): ByteArray = ByteArray(32) { index -> value.substring(index * 2, index * 2 + 2).toInt(16).toByte() }

  @Suppress("DEPRECATION")
  private fun launchInstaller(ctx: Context, file: File) {
    val activity = appContext.currentActivity
      ?: failure("ERR_UPDATE_UNAVAILABLE", "请回到应用中再继续安装。")
    if (activity.isFinishing || activity.isDestroyed) failure("ERR_UPDATE_UNAVAILABLE", "请回到应用中再继续安装。")
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !ctx.packageManager.canRequestPackageInstalls()) {
      failure("ERR_UPDATE_PERMISSION", "请先允许知行安装应用，再继续安装。")
    }
    val root = File(ctx.cacheDir, UPDATE_DIRECTORY).canonicalFile
    if (file.parentFile != root || file.canonicalFile != file || !OsConstants.S_ISREG(Os.lstat(file.path).st_mode)) {
      failure("ERR_UPDATE_PATH", "安装包位置已变化，请重新下载。")
    }
    val content = FileProvider.getUriForFile(ctx, ctx.packageName + ".updates", file)
    val intent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(content, APK_MIME)
      clipData = ClipData.newRawUri("知行更新", content)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    val manager = ctx.packageManager
    val candidates = manager.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY).filter { result ->
      val info = result.activityInfo
      info.exported && (info.applicationInfo.flags and (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP)) != 0
        && manager.checkPermission(Manifest.permission.INSTALL_PACKAGES, info.packageName) == PackageManager.PERMISSION_GRANTED
    }
    val preferred = manager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo
    val target = candidates.firstOrNull { it.activityInfo.packageName == preferred?.packageName && it.activityInfo.name == preferred?.name }
      ?: candidates.firstOrNull()
      ?: failure("ERR_UPDATE_INSTALLER", "此设备没有可用的系统安装界面。")
    intent.component = ComponentName(target.activityInfo.packageName, target.activityInfo.name)
    activity.startActivity(intent)
  }
}
