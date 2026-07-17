import CryptoKit
import Foundation
import Network
import Security

enum DirectRFBTransport: String, Equatable, Hashable, Sendable {
  case tcp = "TCP"
  case quic = "QUIC"

  var label: String { rawValue }
}

struct QUICHostIdentity: @unchecked Sendable {
  let identity: SecIdentity
  let certHash: String
}

enum QUICTransportError: LocalizedError, Equatable {
  case keychain(OSStatus)
  case keyGeneration(String)
  case certificateGeneration(String)
  case identityUnavailable
  case invalidPin

  var errorDescription: String? {
    switch self {
    case .keychain(let status):
      "QUIC identity Keychain error (\(status))."
    case .keyGeneration(let message):
      "Could not generate the QUIC signing key: \(message)"
    case .certificateGeneration(let message):
      "Could not generate the QUIC certificate: \(message)"
    case .identityUnavailable:
      "Could not load the QUIC TLS identity from Keychain."
    case .invalidPin:
      "The registered QUIC certificate pin is invalid."
    }
  }
}

enum QUICIdentityStore {
  static let applicationTag = Data("org.openclaw.crabfleet.quic.host-key-v1".utf8)
  static let certificateLabel = "Crabfleet QUIC Host Certificate v1"

  static func loadOrCreate(
    applicationTag: Data = QUICIdentityStore.applicationTag,
    certificateLabel: String = QUICIdentityStore.certificateLabel,
    keyLabel: String = "Crabfleet QUIC Host Key v1"
  ) throws -> QUICHostIdentity {
    let privateKey = try loadOrCreatePrivateKey(applicationTag: applicationTag, keyLabel: keyLabel)
    let publicKey = try publicKey(for: privateKey)
    let publicKeyData = try externalRepresentation(of: publicKey)
    let spki = try SubjectPublicKeyInfo.p256(publicKeyData: publicKeyData)
    let certificate = try loadMatchingCertificate(
      publicKeyData: publicKeyData,
      certificateLabel: certificateLabel)
      ?? createAndStoreCertificate(
        privateKey: privateKey,
        certificateLabel: certificateLabel,
        spki: spki)
    var identity: SecIdentity?
    guard SecIdentityCreateWithCertificate(nil, certificate, &identity) == errSecSuccess,
      let identity
    else {
      throw QUICTransportError.identityUnavailable
    }
    return QUICHostIdentity(identity: identity, certHash: QUICCertificatePin.hash(spki: spki))
  }

  static func remove(applicationTag: Data, certificateLabel: String) {
    SecItemDelete([
      kSecClass: kSecClassKey,
      kSecAttrApplicationTag: applicationTag,
    ] as CFDictionary)
    SecItemDelete([
      kSecClass: kSecClassCertificate,
      kSecAttrLabel: certificateLabel,
    ] as CFDictionary)
  }

  private static func loadOrCreatePrivateKey(applicationTag: Data, keyLabel: String) throws -> SecKey {
    let query: [CFString: Any] = [
      kSecClass: kSecClassKey,
      kSecAttrApplicationTag: applicationTag,
      kSecAttrKeyClass: kSecAttrKeyClassPrivate,
      kSecReturnRef: true,
      kSecMatchLimit: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecSuccess, let key = result as! SecKey? { return key }
    guard status == errSecItemNotFound else { throw QUICTransportError.keychain(status) }

    var error: Unmanaged<CFError>?
    // Network.framework requires a public Security.framework SecIdentity for
    // its server identity. Security.framework does not expose Ed25519 identity
    // creation/import, so use its strongest supported compact EC identity.
    let attributes: [CFString: Any] = [
      kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits: 256,
      kSecPrivateKeyAttrs: [
        kSecAttrIsPermanent: true,
        kSecAttrApplicationTag: applicationTag,
        kSecAttrLabel: keyLabel,
      ],
    ]
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
      throw QUICTransportError.keyGeneration(
        error?.takeRetainedValue().localizedDescription ?? "unknown Security.framework error")
    }
    return key
  }

  private static func publicKey(for privateKey: SecKey) throws -> SecKey {
    guard let key = SecKeyCopyPublicKey(privateKey) else {
      throw QUICTransportError.keyGeneration("public key unavailable")
    }
    return key
  }

  private static func externalRepresentation(of key: SecKey) throws -> Data {
    var error: Unmanaged<CFError>?
    guard let data = SecKeyCopyExternalRepresentation(key, &error) as Data? else {
      throw QUICTransportError.keyGeneration(
        error?.takeRetainedValue().localizedDescription ?? "key export unavailable")
    }
    return data
  }

  private static func loadMatchingCertificate(
    publicKeyData: Data,
    certificateLabel: String
  ) throws -> SecCertificate? {
    let query: [CFString: Any] = [
      kSecClass: kSecClassCertificate,
      kSecAttrLabel: certificateLabel,
      kSecReturnRef: true,
      kSecMatchLimit: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let certificate = result as! SecCertificate? else {
      throw QUICTransportError.keychain(status)
    }
    guard let certificateKey = SecCertificateCopyKey(certificate),
      try externalRepresentation(of: certificateKey) == publicKeyData
    else {
      let deleteStatus = SecItemDelete([
        kSecClass: kSecClassCertificate,
        kSecValueRef: certificate,
      ] as CFDictionary)
      guard deleteStatus == errSecSuccess || deleteStatus == errSecItemNotFound else {
        throw QUICTransportError.keychain(deleteStatus)
      }
      return nil
    }
    return certificate
  }

  private static func createAndStoreCertificate(
    privateKey: SecKey,
    certificateLabel: String,
    spki: Data
  ) throws -> SecCertificate {
    let signatureAlgorithm = DER.sequence(DER.oid([1, 2, 840, 10045, 4, 3, 2]))
    let commonName = DER.sequence(
      DER.set(
        DER.sequence(
          DER.oid([2, 5, 4, 3]) + DER.tag(0x0c, Data("Crabfleet QUIC".utf8)))))
    let now = Date()
    let validity = DER.sequence(
      DER.generalizedTime(now.addingTimeInterval(-86_400))
        + DER.generalizedTime(now.addingTimeInterval(10 * 365 * 86_400)))
    var serial = Data(count: 16)
    let randomStatus = serial.withUnsafeMutableBytes {
      SecRandomCopyBytes(kSecRandomDefault, $0.count, $0.baseAddress!)
    }
    guard randomStatus == errSecSuccess else { throw QUICTransportError.keychain(randomStatus) }
    if serial.allSatisfy({ $0 == 0 }) { serial[serial.startIndex] = 1 }
    serial = X509SerialNumber.canonicalDERContent(serial)

    let basicConstraints = DER.sequence(
      DER.oid([2, 5, 29, 19]) + DER.boolean(true) + DER.octetString(DER.sequence(Data())))
    let keyUsage = DER.sequence(
      DER.oid([2, 5, 29, 15])
        + DER.boolean(true)
        + DER.octetString(DER.bitString(Data([0x80]), unusedBits: 7)))
    let extendedKeyUsage = DER.sequence(
      DER.oid([2, 5, 29, 37])
        + DER.octetString(DER.sequence(DER.oid([1, 3, 6, 1, 5, 5, 7, 3, 1]))))
    let extensions = DER.explicit(
      3,
      DER.sequence(basicConstraints + keyUsage + extendedKeyUsage))
    let tbs = DER.sequence(
      DER.explicit(0, DER.integer(Data([2])))
        + DER.integer(serial)
        + signatureAlgorithm
        + commonName
        + validity
        + commonName
        + spki
        + extensions)

    var signatureError: Unmanaged<CFError>?
    guard
      SecKeyIsAlgorithmSupported(privateKey, .sign, .ecdsaSignatureMessageX962SHA256),
      let signature = SecKeyCreateSignature(
        privateKey,
        .ecdsaSignatureMessageX962SHA256,
        tbs as CFData,
        &signatureError) as Data?
    else {
      throw QUICTransportError.certificateGeneration(
        signatureError?.takeRetainedValue().localizedDescription ?? "signature unavailable")
    }
    let certificateData = DER.sequence(tbs + signatureAlgorithm + DER.bitString(signature))
    guard let certificate = SecCertificateCreateWithData(nil, certificateData as CFData) else {
      throw QUICTransportError.certificateGeneration("invalid certificate encoding")
    }
    let addQuery: [CFString: Any] = [
      kSecClass: kSecClassCertificate,
      kSecValueRef: certificate,
      kSecAttrLabel: certificateLabel,
    ]
    let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
    guard addStatus == errSecSuccess || addStatus == errSecDuplicateItem else {
      throw QUICTransportError.keychain(addStatus)
    }
    return certificate
  }
}

enum X509SerialNumber {
  static func canonicalDERContent(_ bytes: Data) -> Data {
    guard !bytes.isEmpty else { return Data([1]) }
    var result = bytes
    while result.count > 1, result.first == 0, result[result.index(after: result.startIndex)] < 0x80 {
      result.removeFirst()
    }
    if let first = result.first, first >= 0x80 { result.insert(0, at: result.startIndex) }
    return result
  }
}

enum QUICCertificatePin {
  static func hash(spki: Data) -> String {
    Data(SHA256.hash(data: spki)).base64URLEncodedString()
  }

  static func matches(trust: SecTrust, expectedHash: String) -> Bool {
    guard isValid(expectedHash),
      let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
      let certificate = chain.first
    else { return false }
    return matches(certificate: certificate, expectedHash: expectedHash)
  }

  static func matches(certificate: SecCertificate, expectedHash: String) -> Bool {
    guard isValid(expectedHash),
      let key = SecCertificateCopyKey(certificate),
      let representation = externalRepresentation(of: key),
      let spki = try? SubjectPublicKeyInfo.p256(publicKeyData: representation)
    else { return false }
    return constantTimeEqual(hash(spki: spki), expectedHash)
  }

  static func isValid(_ value: String) -> Bool {
    value.utf8.count == 43
      && value.utf8.allSatisfy {
        (0x30...0x39).contains($0) || (0x41...0x5a).contains($0)
          || (0x61...0x7a).contains($0) || $0 == 0x2d || $0 == 0x5f
      }
  }

  private static func externalRepresentation(of key: SecKey) -> Data? {
    var error: Unmanaged<CFError>?
    return SecKeyCopyExternalRepresentation(key, &error) as Data?
  }

  private static func constantTimeEqual(_ lhs: String, _ rhs: String) -> Bool {
    let left = Array(lhs.utf8)
    let right = Array(rhs.utf8)
    guard left.count == right.count else { return false }
    return zip(left, right).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
  }
}

enum QUICParameters {
  static let alpn = ["crabfleet-rfb-1"]

  static func server(identity: SecIdentity) throws -> NWParameters {
    let options = NWProtocolQUIC.Options(alpn: alpn)
    configureSingleRFBStream(options)
    guard let protocolIdentity = sec_identity_create(identity) else {
      throw QUICTransportError.identityUnavailable
    }
    sec_protocol_options_set_local_identity(options.securityProtocolOptions, protocolIdentity)
    let parameters = NWParameters(quic: options)
    parameters.allowLocalEndpointReuse = true
    parameters.serviceClass = .interactiveVideo
    return parameters
  }

  static func client(expectedCertHash: String) throws -> NWParameters {
    guard QUICCertificatePin.isValid(expectedCertHash) else { throw QUICTransportError.invalidPin }
    let options = NWProtocolQUIC.Options(alpn: alpn)
    configureSingleRFBStream(options)
    let verifyQueue = DispatchQueue(label: "org.openclaw.crabfleet.quic-pin")
    sec_protocol_options_set_verify_block(
      options.securityProtocolOptions,
      { _, trust, complete in
        let secTrust = sec_trust_copy_ref(trust).takeRetainedValue()
        complete(QUICCertificatePin.matches(trust: secTrust, expectedHash: expectedCertHash))
      },
      verifyQueue)
    let parameters = NWParameters(quic: options)
    parameters.serviceClass = .interactiveVideo
    return parameters
  }

  private static func configureSingleRFBStream(_ options: NWProtocolQUIC.Options) {
    options.direction = .bidirectional
    options.initialMaxStreamsBidirectional = 1
    options.initialMaxStreamsUnidirectional = 0
    options.initialMaxData = 16 * 1_024 * 1_024
    options.initialMaxStreamDataBidirectionalLocal = 16 * 1_024 * 1_024
    options.initialMaxStreamDataBidirectionalRemote = 16 * 1_024 * 1_024
  }
}

private enum SubjectPublicKeyInfo {
  static func p256(publicKeyData: Data) throws -> Data {
    guard publicKeyData.count == 65, publicKeyData.first == 0x04 else {
      throw QUICTransportError.certificateGeneration("unsupported public key")
    }
    let algorithm = DER.sequence(
      DER.oid([1, 2, 840, 10045, 2, 1]) + DER.oid([1, 2, 840, 10045, 3, 1, 7]))
    return DER.sequence(algorithm + DER.bitString(publicKeyData))
  }
}

private enum DER {
  static func tag(_ tag: UInt8, _ content: Data) -> Data {
    Data([tag]) + length(content.count) + content
  }

  static func sequence(_ content: Data) -> Data { tag(0x30, content) }
  static func set(_ content: Data) -> Data { tag(0x31, content) }
  static func integer(_ content: Data) -> Data { tag(0x02, content) }
  static func octetString(_ content: Data) -> Data { tag(0x04, content) }
  static func boolean(_ value: Bool) -> Data { tag(0x01, Data([value ? 0xff : 0x00])) }
  static func explicit(_ number: UInt8, _ content: Data) -> Data { tag(0xa0 | number, content) }

  static func bitString(_ content: Data, unusedBits: UInt8 = 0) -> Data {
    tag(0x03, Data([unusedBits]) + content)
  }

  static func generalizedTime(_ date: Date) -> Data {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    let components = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
    let value = String(
      format: "%04d%02d%02d%02d%02d%02dZ",
      components.year ?? 1970,
      components.month ?? 1,
      components.day ?? 1,
      components.hour ?? 0,
      components.minute ?? 0,
      components.second ?? 0)
    return tag(0x18, Data(value.utf8))
  }

  static func oid(_ arcs: [UInt64]) -> Data {
    precondition(arcs.count >= 2)
    var content = Data([UInt8(arcs[0] * 40 + arcs[1])])
    for arc in arcs.dropFirst(2) {
      var bytes = [UInt8(arc & 0x7f)]
      var remaining = arc >> 7
      while remaining > 0 {
        bytes.append(UInt8(remaining & 0x7f) | 0x80)
        remaining >>= 7
      }
      content.append(contentsOf: bytes.reversed())
    }
    return tag(0x06, content)
  }

  private static func length(_ value: Int) -> Data {
    if value < 128 { return Data([UInt8(value)]) }
    var remaining = value
    var bytes: [UInt8] = []
    while remaining > 0 {
      bytes.append(UInt8(remaining & 0xff))
      remaining >>= 8
    }
    return Data([0x80 | UInt8(bytes.count)] + bytes.reversed())
  }
}

extension Data {
  fileprivate func base64URLEncodedString() -> String {
    base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}
