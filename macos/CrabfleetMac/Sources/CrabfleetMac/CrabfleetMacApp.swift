import SwiftUI

@main
struct CrabfleetMacApp: App {
  @StateObject private var fleetStore = FleetStore()
  @StateObject private var connectionLibrary = ConnectionLibrary()
  @StateObject private var sessionPool = VNCSessionPool()

  var body: some Scene {
    Window("Crabfleet", id: "main") {
      CrabfleetAppRoot(
        fleetStore: fleetStore,
        connectionLibrary: connectionLibrary,
        sessionPool: sessionPool
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
        .keyboardShortcut("r", modifiers: [.command])
      }
    }
  }
}

private struct CrabfleetAppRoot: View {
  @ObservedObject var fleetStore: FleetStore
  @ObservedObject var connectionLibrary: ConnectionLibrary
  @ObservedObject var sessionPool: VNCSessionPool

  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    FleetRootView(
      store: fleetStore,
      connections: connectionLibrary,
      sessions: sessionPool
    )
    .frame(minWidth: 1_080, minHeight: 680)
    .preferredColorScheme(.dark)
    .task {
      await fleetStore.refresh()
    }
    .onChange(of: scenePhase) { _, phase in
      sessionPool.setApplicationActive(phase == .active)
    }
  }
}
