import Combine
import Foundation

@MainActor
final class VNCSessionPool: ObservableObject {
  @Published private(set) var focusedSessionID: String?

  let clipboardCoordinator: ClipboardCoordinator

  private let maximumLiveSessions: Int
  private var sessions: [String: VNCSessionController] = [:]
  private var lastUsedAt: [String: Date] = [:]
  private var isApplicationActive = true

  init(
    clipboardCoordinator: ClipboardCoordinator? = nil,
    maximumLiveSessions: Int = 6
  ) {
    self.clipboardCoordinator = clipboardCoordinator ?? ClipboardCoordinator()
    self.maximumLiveSessions = max(1, maximumLiveSessions)
  }

  func session(for targetID: String) -> VNCSessionController {
    if let session = sessions[targetID] { return session }

    let session = VNCSessionController(
      targetID: targetID,
      clipboardCoordinator: clipboardCoordinator
    )
    session.setApplicationActive(isApplicationActive)
    sessions[targetID] = session
    return session
  }

  func connect(targetID: String, request: VNCConnectionRequest) {
    enforceLiveSessionBudget(excluding: targetID)
    clipboardCoordinator.reset(targetID: targetID)

    let targetSession = session(for: targetID)
    lastUsedAt[targetID] = .now
    targetSession.connect(
      host: request.host,
      port: UInt16(clamping: request.port),
      username: request.username,
      password: request.password,
      clipboardEnabled: request.clipboardEnabled
    )

    if focusedSessionID == targetID {
      clipboardCoordinator.focus(session: targetSession, targetID: targetID)
    }
  }

  func focus(targetID: String?) {
    if let focusedSessionID, focusedSessionID != targetID {
      sessions[focusedSessionID]?.setFocused(false)
    }
    focusedSessionID = targetID
    guard let targetID else {
      clipboardCoordinator.focus(session: nil, targetID: nil)
      return
    }

    lastUsedAt[targetID] = .now
    let focusedSession = session(for: targetID)
    focusedSession.setFocused(true)
    clipboardCoordinator.focus(session: focusedSession, targetID: targetID)
  }

  func disconnect(targetID: String) {
    guard let session = sessions[targetID] else { return }
    session.disconnect()
    clipboardCoordinator.reset(targetID: targetID)
    clipboardCoordinator.sessionStateDidChange(
      session,
      targetID: targetID
    )
  }

  func disconnectAll() {
    focus(targetID: nil)
    for session in sessions.values {
      session.disconnect()
    }
  }

  func setApplicationActive(_ isActive: Bool) {
    isApplicationActive = isActive
    for session in sessions.values {
      session.setApplicationActive(isActive)
    }
  }

  func reconcile(validTargetIDs: Set<String>) {
    let staleTargetIDs = sessions.keys.filter { !validTargetIDs.contains($0) }
    for targetID in staleTargetIDs {
      sessions[targetID]?.disconnect()
      sessions[targetID] = nil
      lastUsedAt[targetID] = nil
      clipboardCoordinator.forget(targetID: targetID)
    }
    if let focusedSessionID, staleTargetIDs.contains(focusedSessionID) {
      focus(targetID: nil)
    }
  }

  private func enforceLiveSessionBudget(excluding targetID: String) {
    let liveTargetIDs = sessions.compactMap { id, session in
      id != targetID && session.phase.isConnectedOrConnecting ? id : nil
    }
    guard liveTargetIDs.count >= maximumLiveSessions else { return }

    let evictionTargetID = liveTargetIDs
      .filter { $0 != focusedSessionID }
      .min { (lastUsedAt[$0] ?? .distantPast) < (lastUsedAt[$1] ?? .distantPast) }
      ?? liveTargetIDs.min {
        (lastUsedAt[$0] ?? .distantPast) < (lastUsedAt[$1] ?? .distantPast)
      }

    if let evictionTargetID {
      sessions[evictionTargetID]?.disconnect()
      clipboardCoordinator.reset(targetID: evictionTargetID)
    }
  }
}
