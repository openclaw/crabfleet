import CoreGraphics
import ScreenCaptureKit

enum CapturePermissionKind: Equatable, Sendable {
  case screenRecording
  case remoteDesktop

  var title: String {
    switch self {
    case .screenRecording: "Screen Recording"
    case .remoteDesktop: "Remote Desktop"
    }
  }
}

struct CapturePermissionPolicy {
  static func selectedKind(experimentalRemoteDesktopEnabled: Bool) -> CapturePermissionKind {
    experimentalRemoteDesktopEnabled ? .remoteDesktop : .screenRecording
  }

  static func canStart(identityAvailable: Bool, captureAuthorized: Bool) -> Bool {
    identityAvailable && captureAuthorized
  }

  static func allowsCaptureStart(
    kind: CapturePermissionKind,
    screenRecordingAuthorized: Bool
  ) -> Bool {
    switch kind {
    case .screenRecording: screenRecordingAuthorized
    case .remoteDesktop: !screenRecordingAuthorized
    }
  }
}

struct CapturePermissionAuthorizer {
  private let screenRecordingCheck: () -> Bool
  private let remoteDesktopCheck: () async -> Bool

  init(
    screenRecordingCheck: @escaping () -> Bool = { CGPreflightScreenCaptureAccess() },
    remoteDesktopCheck: @escaping () async -> Bool = {
      // macOS exposes no public Remote Desktop TCC preflight/request API. Probe
      // the same SCK capability used by capture so a settings grant is noticed.
      guard let content = try? await SCShareableContent.current else { return false }
      return !content.displays.isEmpty
    }
  ) {
    self.screenRecordingCheck = screenRecordingCheck
    self.remoteDesktopCheck = remoteDesktopCheck
  }

  func isScreenRecordingAuthorized() -> Bool { screenRecordingCheck() }

  func isRemoteDesktopAuthorized() async -> Bool {
    // The capability probe cannot identify the TCC service that granted access.
    // Fail closed until Screen Recording is revoked so it cannot satisfy the
    // Remote Desktop experiment accidentally.
    guard !screenRecordingCheck() else { return false }
    let remoteDesktopAuthorized = await remoteDesktopCheck()
    guard !screenRecordingCheck() else { return false }
    return remoteDesktopAuthorized
  }
}
