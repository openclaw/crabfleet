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

  /// Explicit launch flags plus the persisted "start sharing when I log in"
  /// preference set from the share sheet.
  static func isRequested(
    arguments: [String] = ProcessInfo.processInfo.arguments,
    environment: [String: String] = ProcessInfo.processInfo.environment,
    defaults: UserDefaults = .standard
  ) -> Bool {
    isEnabled(arguments: arguments, environment: environment)
      || PrivateMacShareController.isAutoShareRequested(defaults: defaults)
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
  let shareController: PrivateMacShareController
  private let replyToTerminationRequest: @MainActor (Bool) -> Void
  private let isAutoShareRequested: @MainActor () -> Bool
  private let autoShareDelay: Duration
  private var autoShareTask: Task<Void, Never>?
  private var terminationTask: Task<Void, Never>?

  override init() {
    shareController = PrivateMacShareController()
    replyToTerminationRequest = { shouldTerminate in
      NSApp.reply(toApplicationShouldTerminate: shouldTerminate)
    }
    isAutoShareRequested = { PrivateMacShareLaunchMode.isRequested() }
    autoShareDelay = .milliseconds(500)
    super.init()
  }

  init(
    shareController: PrivateMacShareController,
    replyToTerminationRequest: @escaping @MainActor (Bool) -> Void = {
      NSApp.reply(toApplicationShouldTerminate: $0)
    },
    isAutoShareRequested: @escaping @MainActor () -> Bool = {
      PrivateMacShareLaunchMode.isRequested()
    },
    autoShareDelay: Duration = .milliseconds(500)
  ) {
    self.shareController = shareController
    self.replyToTerminationRequest = replyToTerminationRequest
    self.isAutoShareRequested = isAutoShareRequested
    self.autoShareDelay = autoShareDelay
    super.init()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    guard isAutoShareRequested() else { return }
    NSApp.activate(ignoringOtherApps: true)
    autoShareTask = Task { [weak self] in
      guard let self else { return }
      do {
        try await Task.sleep(for: autoShareDelay)
      } catch {
        return
      }
      guard !Task.isCancelled else { return }
      await self.startPrivateShare(shareController)
    }
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    autoShareTask?.cancel()
    guard terminationTask == nil else { return .terminateLater }
    terminationTask = Task { [weak self] in
      guard let self else { return }
      let cleanupCanRecover = await shareController.stopAndWaitForCleanup()
      terminationTask = nil
      replyToTerminationRequest(cleanupCanRecover)
    }
    return .terminateLater
  }

  func applicationWillTerminate(_ notification: Notification) {
    autoShareTask?.cancel()
  }

  private func startPrivateShare(_ controller: PrivateMacShareController) async {
    await controller.refresh()
    guard !Task.isCancelled else { return }
    report(
      "private share prerequisites: tailnet \(controller.identity == nil ? "unavailable" : "ready"), "
        + "Screen Recording \(controller.screenRecordingGranted ? "allowed" : "denied")"
        + (controller.notice.map { ": \($0)" } ?? "")
    )
    if !controller.screenRecordingGranted {
      await controller.requestScreenRecordingPermission()
      guard !Task.isCancelled else { return }
    }

    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: .seconds(300))
    while !Task.isCancelled, clock.now < deadline {
      await controller.refresh()
      guard !Task.isCancelled else { return }
      if controller.canStart {
        await controller.start()
        guard !Task.isCancelled else { return }
        for _ in 0..<50 where controller.phase == .starting {
          do {
            try await Task.sleep(for: .milliseconds(100))
          } catch {
            return
          }
        }
        let address = controller.connectionAddress.map { " at \($0)" } ?? ""
        let notice = controller.notice.map { ": \($0)" } ?? ""
        report("private share \(controller.phase.title.lowercased())\(address)\(notice)")
        return
      }
      do {
        try await Task.sleep(for: .seconds(2))
      } catch {
        return
      }
    }

    let missing = [
      controller.screenRecordingGranted ? nil : "Screen Recording",
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
        privateShare: appDelegate.shareController,
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
  @ObservedObject var privateShare: PrivateMacShareController
  let launchConnection: VNCAddress?

  @Environment(\.scenePhase) private var scenePhase
  @State private var localOnly: Bool

  init(
    fleetStore: FleetStore,
    connectionLibrary: ConnectionLibrary,
    sessionPool: VNCSessionPool,
    privateShare: PrivateMacShareController,
    launchConnection: VNCAddress?
  ) {
    self.fleetStore = fleetStore
    self.connectionLibrary = connectionLibrary
    self.sessionPool = sessionPool
    self.privateShare = privateShare
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
          privateShare: privateShare,
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
