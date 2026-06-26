import AppKit
import Foundation
import SwiftUI

enum PrivateMacShareLaunchMode {
  static let argument = "--share-this-mac"
  static let environmentKey = "CRABFLEET_AUTO_SHARE"

  static func isEnabled(
    arguments: [String] = ProcessInfo.processInfo.arguments,
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> Bool {
    arguments.dropFirst().contains(argument) || environment[environmentKey] == "1"
  }
}

enum VNCConnectionLaunchMode {
  static let argument = "--connect"
  static let environmentKey = "CRABFLEET_AUTO_CONNECT"

  static func address(
    arguments: [String] = ProcessInfo.processInfo.arguments,
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) throws -> VNCAddress? {
    let rawValue: String?
    if let argumentIndex = arguments.dropFirst().firstIndex(of: argument) {
      let valueIndex = arguments.index(after: argumentIndex)
      rawValue = valueIndex < arguments.endIndex ? arguments[valueIndex] : ""
    } else {
      rawValue = environment[environmentKey]
    }
    guard let rawValue else { return nil }
    return try VNCAddress.parse(rawValue)
  }
}

@MainActor
final class CrabfleetApplicationDelegate: NSObject, NSApplicationDelegate {
  private var shareController: PrivateMacShareController?
  private var autoShareTask: Task<Void, Never>?

  func applicationDidFinishLaunching(_ notification: Notification) {
    guard PrivateMacShareLaunchMode.isEnabled() else { return }
    NSApp.activate(ignoringOtherApps: true)
    let controller = PrivateMacShareController()
    shareController = controller
    autoShareTask = Task { [weak self] in
      guard let self else { return }
      try? await Task.sleep(for: .milliseconds(500))
      await self.startPrivateShare(controller)
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    autoShareTask?.cancel()
  }

  private func startPrivateShare(_ controller: PrivateMacShareController) async {
    await controller.refresh()
    if !controller.screenRecordingGranted {
      await controller.requestScreenRecordingPermission()
    }
    if !controller.accessibilityGranted {
      controller.requestAccessibilityPermission()
    }

    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: .seconds(300))
    while !Task.isCancelled, clock.now < deadline {
      await controller.refresh()
      if controller.canStart {
        await controller.start()
        for _ in 0..<50 where controller.phase == .starting {
          try? await Task.sleep(for: .milliseconds(100))
        }
        let address = controller.connectionAddress.map { " at \($0)" } ?? ""
        let notice = controller.notice.map { ": \($0)" } ?? ""
        report("private share \(controller.phase.title.lowercased())\(address)\(notice)")
        return
      }
      try? await Task.sleep(for: .seconds(2))
    }

    let missing = [
      controller.screenRecordingGranted ? nil : "Screen Recording",
      controller.accessibilityGranted ? nil : "Accessibility",
    ].compactMap { $0 }
    report("private share waiting for \(missing.joined(separator: " and ")) permission")
  }

  private func report(_ message: String) {
    FileHandle.standardError.write(Data("Crabfleet: \(message)\n".utf8))
  }
}

@main
struct CrabfleetMacApp: App {
  @NSApplicationDelegateAdaptor(CrabfleetApplicationDelegate.self) private var appDelegate
  @StateObject private var fleetStore = FleetStore()
  @StateObject private var connectionLibrary = ConnectionLibrary()
  @StateObject private var sessionPool = VNCSessionPool()
  private let launchConnection = try? VNCConnectionLaunchMode.address()

  var body: some Scene {
    Window("Crabfleet", id: "main") {
      CrabfleetAppRoot(
        fleetStore: fleetStore,
        connectionLibrary: connectionLibrary,
        sessionPool: sessionPool,
        launchConnection: launchConnection
      )
    }
    .defaultSize(width: 1_360, height: 860)
    .windowResizability(.contentMinSize)
    .commands {
      CommandGroup(replacing: .newItem) {}

      CommandGroup(after: .sidebar) {
        Button("Refresh Fleet") {
          Task { await fleetStore.refresh() }
        }
        .disabled(!fleetStore.isConnected)
        .keyboardShortcut("r", modifiers: [.command])
      }
    }
  }
}

private struct CrabfleetAppRoot: View {
  @ObservedObject var fleetStore: FleetStore
  @ObservedObject var connectionLibrary: ConnectionLibrary
  @ObservedObject var sessionPool: VNCSessionPool
  let launchConnection: VNCAddress?

  @Environment(\.scenePhase) private var scenePhase
  @State private var localOnly: Bool

  init(
    fleetStore: FleetStore,
    connectionLibrary: ConnectionLibrary,
    sessionPool: VNCSessionPool,
    launchConnection: VNCAddress?
  ) {
    self.fleetStore = fleetStore
    self.connectionLibrary = connectionLibrary
    self.sessionPool = sessionPool
    self.launchConnection = launchConnection
    _localOnly = State(
      initialValue: ProcessInfo.processInfo.environment["CRABFLEET_LOCAL_ONLY"] == "1"
        || launchConnection != nil
    )
  }

  var body: some View {
    Group {
      if fleetStore.isConnected || localOnly {
        FleetRootView(
          store: fleetStore,
          connections: connectionLibrary,
          sessions: sessionPool,
          launchConnection: launchConnection,
          deploymentLabel: fleetStore.isConnected ? fleetStore.deploymentLabel : "Local VNC",
          accountLabel: fleetStore.isConnected ? fleetStore.accountLabel : NSUserName(),
          disconnectLabel: fleetStore.isConnected
            ? "Disconnect Deployment"
            : "Return to Deployment Sign-In",
          disconnectDeployment: leaveCurrentMode
        )
      } else {
        DeploymentConnectionView(
          store: fleetStore,
          useLocalConnections: { localOnly = true }
        )
      }
    }
    .frame(minWidth: 1_080, minHeight: 680)
    .preferredColorScheme(.dark)
    .task(id: localOnly) {
      if !localOnly {
        await fleetStore.restore()
      }
    }
    .onChange(of: scenePhase) { _, phase in
      sessionPool.setApplicationActive(phase == .active)
    }
  }

  private func leaveCurrentMode() {
    if fleetStore.isConnected {
      fleetStore.disconnect()
    }
    localOnly = false
  }
}
