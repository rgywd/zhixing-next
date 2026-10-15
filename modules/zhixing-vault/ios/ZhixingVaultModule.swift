import CommonCrypto
import CoreFoundation
import ExpoModulesCore
import Foundation
import UIKit

private let maximumVaultBytes = 8 * 1024 * 1024

public class ZhixingVaultModule: Module {
  private let ioQueue = DispatchQueue(label: "dev.zhixing.vault.io")
  private var clipboardChange: Int?
  private var clipboardExpiry: DispatchWorkItem?

  public func definition() -> ModuleDefinition {
    Name("ZhixingVault")
    Function("isSupported") { true }
    AsyncFunction("deriveKey") { (master: String, salt: String) -> String in
      guard master.utf16.count >= 12, master.utf16.count <= 1024, salt.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil else { throw self.failure("ERR_VAULT_INPUT") }
      let saltBytes = stride(from: 0, to: 32, by: 2).map { index -> UInt8 in
        let start = salt.index(salt.startIndex, offsetBy: index)
        return UInt8(salt[start..<salt.index(start, offsetBy: 2)], radix: 16)!
      }
      var password = Array(master.utf8)
      var derived = [UInt8](repeating: 0, count: 32)
      defer { password.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) }; derived.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) } }
      let status = password.withUnsafeBytes { passwordPointer in
        saltBytes.withUnsafeBytes { saltPointer in
          derived.withUnsafeMutableBytes { resultPointer in
            CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), passwordPointer.baseAddress?.assumingMemoryBound(to: Int8.self), password.count, saltPointer.baseAddress?.assumingMemoryBound(to: UInt8.self), saltBytes.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), 600000, resultPointer.baseAddress?.assumingMemoryBound(to: UInt8.self), 32)
          }
        }
      }
      guard status == kCCSuccess else { throw self.failure("ERR_VAULT_KDF") }
      return derived.map { String(format: "%02x", $0) }.joined()
    }

    AsyncFunction("readVaultRaw") { () -> String? in try self.readRaw() }.runOnQueue(ioQueue)
    AsyncFunction("writeVaultRaw") { (raw: String, expectedRaw: String?) in
      try self.validateEnvelope(raw)
      if let expectedRaw { try self.validateEnvelope(expectedRaw) }
      guard try self.readRaw() == expectedRaw else { throw self.failure("ERR_VAULT_CONFLICT") }
      do {
        let url = try self.vaultURL()
        try Data(raw.utf8).write(to: url, options: [.atomic, .completeFileProtection])
        guard try self.readRaw() == raw else { throw self.failure("ERR_VAULT_WRITE") }
      } catch { throw self.failure("ERR_VAULT_WRITE") }
    }.runOnQueue(ioQueue)

    AsyncFunction("copyValue") { (value: String) in
      guard value.utf16.count <= 20000 else { throw self.failure("ERR_VAULT_INPUT") }
      self.clipboardExpiry?.cancel()
      UIPasteboard.general.setItems([["public.utf8-plain-text": value]], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(30)])
      self.clipboardChange = UIPasteboard.general.changeCount
      let expiry = DispatchWorkItem { [weak self] in self?.clearOwnedClipboard() }
      self.clipboardExpiry = expiry
      DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: expiry)
    }.runOnQueue(.main)
    AsyncFunction("clearClipboard") { self.clearOwnedClipboard() }.runOnQueue(.main)
    OnDestroy { DispatchQueue.main.async { self.clearOwnedClipboard() } }
  }

  private func failure(_ code: String) -> Exception {
    Exception(name: "VaultOperation", description: "密码库操作未完成，原数据已保留。", code: code)
  }

  private func clearOwnedClipboard() {
    guard let change = clipboardChange else { return }
    if UIPasteboard.general.changeCount == change { UIPasteboard.general.items = [] }
    clipboardChange = nil; clipboardExpiry?.cancel(); clipboardExpiry = nil
  }

  private func vaultURL() throws -> URL {
    guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { throw failure("ERR_VAULT_UNAVAILABLE") }
    var directory = support.appendingPathComponent("ZhixingPasswordVault", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
    var resources = URLResourceValues(); resources.isExcludedFromBackup = true
    try directory.setResourceValues(resources)
    return directory.appendingPathComponent("vault.json")
  }

  private func readRaw() throws -> String? {
    do {
      let url = try vaultURL()
      guard FileManager.default.fileExists(atPath: url.path) else { return nil }
      let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
      guard let size = attributes[.size] as? NSNumber, size.intValue <= maximumVaultBytes else { throw failure("ERR_VAULT_FORMAT") }
      let data = try Data(contentsOf: url)
      guard data.count <= maximumVaultBytes, let raw = String(data: data, encoding: .utf8) else { throw failure("ERR_VAULT_FORMAT") }
      try validateEnvelope(raw)
      return raw
    } catch let error as Exception { throw error }
    catch { throw failure("ERR_VAULT_READ") }
  }

  private func validateEnvelope(_ raw: String) throws {
    do {
      let bytes = Data(raw.utf8)
      guard bytes.count <= maximumVaultBytes, let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], Set(value.keys) == Set(["version", "kdf", "iterations", "salt", "sealed"]),
        let version = value["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
        let iterations = value["iterations"] as? NSNumber, CFGetTypeID(iterations) != CFBooleanGetTypeID(), iterations.doubleValue == 600000,
        value["kdf"] as? String == "pbkdf2-sha256", let salt = value["salt"] as? String, salt.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil,
        let sealed = value["sealed"] as? String, let data = Data(base64Encoded: sealed), data.count >= 29, data.base64EncodedString() == sealed else { throw failure("ERR_VAULT_FORMAT") }
    } catch { throw failure("ERR_VAULT_FORMAT") }
  }
}
