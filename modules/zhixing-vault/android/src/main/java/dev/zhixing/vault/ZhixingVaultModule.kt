package dev.zhixing.vault

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.os.SystemClock
import android.util.AtomicFile
import android.util.Base64
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

private const val MAX_RAW_BYTES = 8 * 1024 * 1024
private const val ITERATIONS = 600000
private const val CLIP_TTL = 30000L
private const val CLIP_OWNER = "dev.zhixing.vault.owner"

/** No credentials, plaintext files, network, or log output cross this boundary. */
class ZhixingVaultModule : Module() {
  private val fileLock = Any()
  private val handler = Handler(Looper.getMainLooper())
  private var clipboardToken: String? = null
  private var clipboardDeadline = 0L
  private var pendingClear = false
  private var clearRetry: Runnable? = null
  // Retry at 100/300/700/1000ms without moving the original copy deadline.
  private val clearRetryDelays = longArrayOf(100L, 200L, 400L, 300L)
  private val expiry = Runnable { clearOwnedClipboard() }

  private fun failure(code: String): Nothing = throw CodedException(code, "密码库操作未完成，原数据已保留。", null)
  private fun context(): Context = appContext.reactContext ?: failure("ERR_VAULT_UNAVAILABLE")
  private fun requireSupported() { if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) failure("ERR_VAULT_UNSUPPORTED") }

  override fun definition() = ModuleDefinition {
    Name("ZhixingVault")
    Function("isSupported") { Build.VERSION.SDK_INT >= Build.VERSION_CODES.O }

    // AsyncFunction's default native queue keeps the KDF off the JS/UI thread.
    AsyncFunction("deriveKey") { master: String, salt: String ->
      requireSupported()
      if (master.length < 12 || master.length > 1024 || !validUnicode(master) || !salt.matches(Regex("[0-9a-f]{32}"))) failure("ERR_VAULT_INPUT")
      val chars = master.toCharArray()
      val saltBytes = ByteArray(16) { index -> salt.substring(index * 2, index * 2 + 2).toInt(16).toByte() }
      val spec = PBEKeySpec(chars, saltBytes, ITERATIONS, 256)
      try {
        val bytes = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
        try { bytes.joinToString("") { "%02x".format(it.toInt() and 255) } } finally { bytes.fill(0) }
      } catch (_: Exception) { failure("ERR_VAULT_KDF") }
      finally { spec.clearPassword(); chars.fill('\u0000'); saltBytes.fill(0) }
    }

    AsyncFunction("readVaultRaw") { requireSupported(); synchronized(fileLock) { readRaw() } }
    AsyncFunction("writeVaultRaw") { raw: String, expectedRaw: String? ->
      requireSupported()
      validateEnvelope(raw)
      if (expectedRaw != null) validateEnvelope(expectedRaw)
      synchronized(fileLock) {
        if (readRaw() != expectedRaw) failure("ERR_VAULT_CONFLICT")
        val file = atomicFile()
        var output: FileOutputStream? = null
        try {
          output = file.startWrite()
          output.write(raw.toByteArray(Charsets.UTF_8))
          file.finishWrite(output)
          if (readRaw() != raw) failure("ERR_VAULT_WRITE")
        } catch (_: Exception) {
          file.failWrite(output)
          failure("ERR_VAULT_WRITE")
        }
      }
    }

    AsyncFunction("copyValue") { value: String ->
      requireSupported()
      if (value.length > 20000) failure("ERR_VAULT_INPUT")
      try {
        val token = UUID.randomUUID().toString()
        val clip = ClipData.newPlainText("知行密码库", value)
        clip.description.extras = PersistableBundle().apply {
          putBoolean("android.content.extra.IS_SENSITIVE", true)
          putString(CLIP_OWNER, token)
        }
        clipboard().setPrimaryClip(clip)
        // A failed replacement must leave the previous copy's cleanup intact.
        handler.removeCallbacks(expiry)
        cancelClearRetry()
        pendingClear = false
        clipboardToken = token
        clipboardDeadline = SystemClock.elapsedRealtime() + CLIP_TTL
        handler.postDelayed(expiry, CLIP_TTL)
      } catch (_: Exception) { failure("ERR_VAULT_CLIPBOARD") }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("clearClipboard") { clearOwnedClipboard() }.runOnQueue(Queues.MAIN)
    OnActivityEntersForeground {
      handler.post { if (clipboardToken != null && (pendingClear || SystemClock.elapsedRealtime() >= clipboardDeadline)) clearOwnedClipboard() }
    }
    OnDestroy { handler.post { clearOwnedClipboard() } }
  }

  private fun clipboard() = context().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

  private fun validUnicode(value: String): Boolean {
    var index = 0
    while (index < value.length) {
      val unit = value[index++]
      if (Character.isHighSurrogate(unit)) {
        if (index == value.length || !Character.isLowSurrogate(value[index++])) return false
      } else if (Character.isLowSurrogate(unit)) return false
    }
    return true
  }

  private fun clearOwnedClipboard() {
    val token = clipboardToken ?: return
    pendingClear = true
    cancelClearRetry()
    tryClearOwnedClipboard(token, 0)
  }

  private fun cancelClearRetry() {
    clearRetry?.let { handler.removeCallbacks(it) }
    clearRetry = null
  }

  private fun tryClearOwnedClipboard(token: String, attempt: Int) {
    if (!pendingClear || clipboardToken != token) return
    clearRetry = null
    try {
      val manager = clipboard()
      // Android can deny clipboard reads in the background. Retain the token so
      // bounded retries and the foreground callback can retry after focus returns.
      val description = manager.primaryClipDescription
      if (description != null) {
        if (description.extras?.getString(CLIP_OWNER) == token) {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) manager.clearPrimaryClip()
          else manager.setPrimaryClip(ClipData.newPlainText("", ""))
        }
        // A different owner is never cleared and ends this old owner's request.
        clipboardToken = null
        pendingClear = false
        handler.removeCallbacks(expiry)
        return
      }
    } catch (_: Exception) { /* A foreground retry owns the remaining token. */ }
    if (attempt < clearRetryDelays.size && pendingClear && clipboardToken == token) {
      val retry = Runnable { tryClearOwnedClipboard(token, attempt + 1) }
      clearRetry = retry
      handler.postDelayed(retry, clearRetryDelays[attempt])
    }
  }

  private fun atomicFile(): AtomicFile = AtomicFile(File(context().noBackupFilesDir, "zhixing-password-vault.json"))

  private fun readRaw(): String? {
    val file = atomicFile()
    if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return null
    try {
      val bytes = file.openRead().use { input ->
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          if (output.size() + count > MAX_RAW_BYTES) failure("ERR_VAULT_FORMAT")
          output.write(buffer, 0, count)
        }
        output.toByteArray()
      }
      val raw = bytes.toString(Charsets.UTF_8)
      validateEnvelope(raw)
      return raw
    } catch (error: CodedException) { throw error }
    catch (_: Exception) { failure("ERR_VAULT_READ") }
  }

  private fun validateEnvelope(raw: String) {
    try {
      if (raw.toByteArray(Charsets.UTF_8).size > MAX_RAW_BYTES) failure("ERR_VAULT_FORMAT")
      val value = JSONObject(raw)
      if (value.keys().asSequence().toSet() != setOf("version", "kdf", "iterations", "salt", "sealed")) failure("ERR_VAULT_FORMAT")
      if (value.opt("version") !is Number || value.getDouble("version") != 1.0 || value.opt("iterations") !is Number || value.getDouble("iterations") != ITERATIONS.toDouble()) failure("ERR_VAULT_FORMAT")
      if (value.opt("kdf") != "pbkdf2-sha256") failure("ERR_VAULT_FORMAT")
      val salt = value.opt("salt") as? String ?: failure("ERR_VAULT_FORMAT")
      val sealed = value.opt("sealed") as? String ?: failure("ERR_VAULT_FORMAT")
      val padding = if (sealed.endsWith("==")) 2 else if (sealed.endsWith("=")) 1 else 0
      if (!salt.matches(Regex("[0-9a-f]{32}")) || sealed.isEmpty() || sealed.length % 4 != 0 || sealed.dropLast(padding).any { it !in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/" }) failure("ERR_VAULT_FORMAT")
      val bytes = Base64.decode(sealed, Base64.NO_WRAP)
      if (bytes.size < 29 || Base64.encodeToString(bytes, Base64.NO_WRAP) != sealed) failure("ERR_VAULT_FORMAT")
    } catch (error: CodedException) { throw error }
    catch (_: Exception) { failure("ERR_VAULT_FORMAT") }
  }
}
