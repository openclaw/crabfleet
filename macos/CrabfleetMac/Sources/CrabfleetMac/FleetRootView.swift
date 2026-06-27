import AppKit
import SwiftUI

struct FleetRootView: View {
  @ObservedObject var store: FleetStore
  @ObservedObject var connections: ConnectionLibrary
  @ObservedObject var sessions: VNCSessionPool
  let launchConnection: VNCAddress?
  let deploymentLabel: String
  let accountLabel: String
  let disconnectLabel: String
  let disconnectDeployment: () -> Void
  @StateObject private var privateShare = PrivateMacShareController()

  @Namespace private var desktopTransition
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  @State private var scope: DesktopScope = .all
  @State private var query = ""
  @State private var focusedTargetID: DesktopTarget.ID?
  @State private var connectionTarget: DesktopTarget?
  @State private var showingQuickConnect = false
  @State private var showingPrivateShare = false
  @State private var didHandleLaunchConnection = false

  private var allTargets: [DesktopTarget] {
    let saved = connections.profiles.map(DesktopTarget.init(profile:))
    let fleet = store.leases.map(DesktopTarget.init(lease:))
    let hosts = store.desktopHosts.map(DesktopTarget.init(host:))
    return (saved + hosts + fleet).sorted(by: targetSort)
  }

  private var visibleTargets: [DesktopTarget] {
    allTargets.filter { target in
      let isVisible: Bool
      switch scope {
      case .all:
        isVisible = true
      case .mine:
        isVisible =
          target.source == .saved || target.endpoint != nil || target.owner == store.currentUser
      case .fleet:
        isVisible = target.source == .crabfleet
      case .saved:
        isVisible = target.source == .saved
      }
      return isVisible && target.matches(query)
    }
  }

  private var focusedTarget: DesktopTarget? {
    guard let focusedTargetID else { return nil }
    return allTargets.first { $0.id == focusedTargetID }
  }

  private var targetConnectionStates: [DesktopTargetConnectionState] {
    allTargets.map {
      DesktopTargetConnectionState(id: $0.id, nativeVncSessionID: $0.nativeVncSessionID)
    }
  }

  var body: some View {
    ZStack {
      if let target = focusedTarget {
        DesktopFocusView(
          target: target,
          targets: allTargets,
          session: sessions.session(for: target.id),
          sessions: sessions,
          namespace: desktopTransition,
          connect: { connect(target) },
          disconnect: { sessions.disconnect(targetID: target.id) },
          switchTo: focus,
          close: closeFocus
        )
        .zIndex(20)
      } else {
        HStack(spacing: 0) {
          DesktopSourceRail(
            scope: $scope,
            targets: allTargets,
            currentUser: store.currentUser,
            notice: store.notice,
            deploymentLabel: deploymentLabel,
            accountLabel: accountLabel,
            disconnectLabel: disconnectLabel,
            disconnectDeployment: disconnectDeployment,
            shareThisMac: { showingPrivateShare = true },
            quickConnect: { showingQuickConnect = true }
          )
          Divider().overlay(.white.opacity(0.07))
          DesktopDeck(
            title: scope.rawValue,
            targets: visibleTargets,
            query: $query,
            isRefreshing: store.isRefreshing,
            namespace: desktopTransition,
            sessions: sessions,
            refresh: { Task { await store.refresh() } },
            quickConnect: { showingQuickConnect = true },
            focus: focus
          )
        }
        .background(DeckBackground())
      }
    }
    .tint(.mint)
    .sheet(item: $connectionTarget) { target in
      DesktopConnectionSheet(target: target) { request in
        sessions.connect(targetID: target.id, request: request)
        if let profileID = target.profileID {
          connections.markConnected(profileID: profileID)
        }
      }
    }
    .sheet(isPresented: $showingQuickConnect) {
      QuickConnectSheet { name, address, password, clipboardEnabled in
        let profile = connections.save(name: name, address: address)
        let target = DesktopTarget(profile: profile)
        sessions.connect(
          targetID: target.id,
          request: .init(
            host: address.host,
            port: address.port,
            username: address.username,
            password: password,
            clipboardEnabled: clipboardEnabled
          )
        )
        connections.markConnected(profileID: profile.id)
        focus(target.id)
      }
    }
    .sheet(isPresented: $showingPrivateShare) {
      PrivateMacShareSheet(controller: privateShare)
    }
    .onAppear(perform: connectLaunchConnectionIfNeeded)
    .onExitCommand(perform: closeFocus)
    .onChange(of: targetConnectionStates) { _, targetStates in
      let targetIDs = Set(targetStates.map(\.id))
      let nativeSessionIDs = Dictionary(
        uniqueKeysWithValues: targetStates.compactMap { state in
          state.nativeVncSessionID.map { (state.id, $0) }
        }
      )
      sessions.reconcile(validTargetIDs: targetIDs, nativeSessionIDs: nativeSessionIDs)
      if let focusedTargetID, !targetIDs.contains(focusedTargetID) {
        self.focusedTargetID = nil
        sessions.focus(targetID: nil)
      }
    }
    .onDisappear {
      sessions.disconnectAll()
    }
  }

  private func targetSort(_ lhs: DesktopTarget, _ rhs: DesktopTarget) -> Bool {
    if lhs.source != rhs.source { return lhs.source == .saved }
    let lhsActive = lhs.status?.isActive ?? false
    let rhsActive = rhs.status?.isActive ?? false
    if lhsActive != rhsActive { return lhsActive && !rhsActive }
    return lhs.updatedAt > rhs.updatedAt
  }

  private func focus(_ targetID: DesktopTarget.ID) {
    sessions.focus(targetID: targetID)
    if let target = allTargets.first(where: { $0.id == targetID }),
      target.source == .crabfleet,
      (target.endpoint != nil || target.nativeVncSessionID != nil),
      !sessions.session(for: targetID).phase.isConnectedOrConnecting
    {
      connect(target)
    }
    let animation: Animation =
      reduceMotion
      ? .easeOut(duration: 0.12)
      : .spring(response: 0.24, dampingFraction: 0.9)
    withAnimation(animation) {
      focusedTargetID = targetID
    }
  }

  private func connect(_ target: DesktopTarget) {
    if target.source == .crabfleet, let sessionID = target.nativeVncSessionID {
      sessions.connectCrabbox(targetID: target.id, sessionID: sessionID) {
        try await store.nativeVNCGrant(sessionID: sessionID)
      }
    } else if target.source == .crabfleet, let endpoint = target.endpoint {
      sessions.connect(
        targetID: target.id,
        request: .init(
          host: endpoint.host,
          port: endpoint.port,
          username: endpoint.username,
          password: "",
          clipboardEnabled: false
        )
      )
    } else {
      connectionTarget = target
    }
  }

  private func connectLaunchConnectionIfNeeded() {
    guard !didHandleLaunchConnection, let launchConnection else { return }
    didHandleLaunchConnection = true
    let profile = connections.save(
      name: launchConnection.displayValue,
      address: launchConnection,
      favorite: true
    )
    let target = DesktopTarget(profile: profile)
    focus(target.id)
    sessions.connect(
      targetID: target.id,
      request: .init(
        host: launchConnection.host,
        port: launchConnection.port,
        username: launchConnection.username,
        password: "",
        clipboardEnabled: false
      )
    )
    connections.markConnected(profileID: profile.id)
  }

  private func closeFocus() {
    guard focusedTargetID != nil else { return }
    sessions.focus(targetID: nil)
    let animation: Animation =
      reduceMotion
      ? .easeOut(duration: 0.1)
      : .spring(response: 0.22, dampingFraction: 0.92)
    withAnimation(animation) {
      focusedTargetID = nil
    }
  }
}

private struct DesktopTargetConnectionState: Equatable {
  let id: String
  let nativeVncSessionID: String?
}

private struct DesktopSourceRail: View {
  @Binding var scope: DesktopScope
  let targets: [DesktopTarget]
  let currentUser: String
  let notice: String?
  let deploymentLabel: String
  let accountLabel: String
  let disconnectLabel: String
  let disconnectDeployment: () -> Void
  let shareThisMac: () -> Void
  let quickConnect: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 11) {
        ZStack {
          RoundedRectangle(cornerRadius: 9, style: .continuous)
            .fill(Color.mint.opacity(0.13))
            .stroke(Color.mint.opacity(0.22), lineWidth: 0.8)
          Image(systemName: "rectangle.3.group")
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.mint)
        }
        .frame(width: 36, height: 36)

        VStack(alignment: .leading, spacing: 1) {
          Text("CRABFLEET")
            .font(.system(size: 13, weight: .bold, design: .rounded))
            .tracking(1.4)
          Text("VNC CONTROL DECK")
            .font(.system(size: 8, weight: .semibold, design: .monospaced))
            .tracking(0.9)
            .foregroundStyle(.tertiary)
        }
      }
      .padding(.horizontal, 17)
      .padding(.top, 18)
      .padding(.bottom, 20)

      VStack(spacing: 4) {
        ForEach(DesktopScope.allCases) { candidate in
          SourceRailButton(
            scope: candidate,
            count: count(for: candidate),
            isSelected: scope == candidate
          ) {
            withAnimation(.easeOut(duration: 0.14)) {
              scope = candidate
            }
          }
        }
      }
      .padding(.horizontal, 9)

      Spacer()

      Menu {
        Text(accountLabel)
        Divider()
        Button(disconnectLabel, role: .destructive, action: disconnectDeployment)
      } label: {
        HStack(spacing: 9) {
          ZStack {
            Circle().fill(.mint.opacity(0.13))
            Image(systemName: "network")
              .font(.system(size: 10, weight: .semibold))
              .foregroundStyle(.mint)
          }
          .frame(width: 27, height: 27)
          VStack(alignment: .leading, spacing: 1) {
            Text(deploymentLabel)
              .font(.system(size: 10, weight: .semibold, design: .rounded))
              .lineLimit(1)
            Text(accountLabel)
              .font(.system(size: 8, weight: .medium, design: .rounded))
              .foregroundStyle(.tertiary)
              .lineLimit(1)
          }
          Spacer()
          Image(systemName: "chevron.up.chevron.down")
            .font(.system(size: 8, weight: .semibold))
            .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 10)
        .frame(height: 40)
        .background(.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 8))
      }
      .menuStyle(.borderlessButton)
      .padding(.horizontal, 12)
      .padding(.bottom, 10)

      if let notice {
        Text(notice)
          .font(.system(size: 10, weight: .medium, design: .rounded))
          .foregroundStyle(.tertiary)
          .lineLimit(3)
          .padding(.horizontal, 17)
          .padding(.bottom, 13)
      }

      Button(action: shareThisMac) {
        HStack(spacing: 8) {
          Image(systemName: "display.and.arrow.down")
          Text("Share This Mac")
          Spacer()
          Image(systemName: "lock.shield")
            .font(.system(size: 10))
            .foregroundStyle(.mint)
        }
        .font(.system(size: 12, weight: .semibold, design: .rounded))
        .padding(.horizontal, 12)
        .frame(height: 36)
        .background(.mint.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
      }
      .buttonStyle(.plain)
      .padding(.horizontal, 12)
      .padding(.bottom, 5)

      Button(action: quickConnect) {
        HStack(spacing: 8) {
          Image(systemName: "plus")
          Text("Quick Connect")
          Spacer()
          Text("⌘K")
            .font(.system(size: 9, weight: .medium, design: .monospaced))
            .foregroundStyle(.tertiary)
        }
        .font(.system(size: 12, weight: .semibold, design: .rounded))
        .padding(.horizontal, 12)
        .frame(height: 36)
        .background(.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 8))
      }
      .buttonStyle(.plain)
      .keyboardShortcut("k", modifiers: [.command])
      .padding(12)
    }
    .frame(width: 224)
    .background(Color(red: 0.052, green: 0.058, blue: 0.062).opacity(0.98))
  }

  private func count(for scope: DesktopScope) -> Int {
    switch scope {
    case .all: targets.count
    case .mine:
      targets.filter { $0.source == .saved || $0.endpoint != nil || $0.owner == currentUser }.count
    case .fleet: targets.filter { $0.source == .crabfleet }.count
    case .saved: targets.filter { $0.source == .saved }.count
    }
  }
}

private struct SourceRailButton: View {
  let scope: DesktopScope
  let count: Int
  let isSelected: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 9) {
        Image(systemName: scope.systemImage)
          .frame(width: 17)
        Text(scope.rawValue)
        Spacer()
        Text(count, format: .number)
          .font(.system(size: 10, weight: .medium, design: .monospaced))
          .foregroundStyle(isSelected ? .primary : .tertiary)
      }
      .font(.system(size: 12, weight: isSelected ? .semibold : .medium, design: .rounded))
      .foregroundStyle(isSelected ? Color.primary : Color.secondary)
      .padding(.horizontal, 10)
      .frame(height: 34)
      .background(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(isSelected ? Color.white.opacity(0.08) : .clear)
      )
      .overlay(alignment: .leading) {
        if isSelected {
          Capsule().fill(.mint).frame(width: 2, height: 17).offset(x: -1)
        }
      }
    }
    .buttonStyle(.plain)
  }
}

private struct DesktopDeck: View {
  let title: String
  let targets: [DesktopTarget]
  @Binding var query: String
  let isRefreshing: Bool
  let namespace: Namespace.ID
  @ObservedObject var sessions: VNCSessionPool
  let refresh: () -> Void
  let quickConnect: () -> Void
  let focus: (DesktopTarget.ID) -> Void

  private let columns = [
    GridItem(.adaptive(minimum: 292, maximum: 440), spacing: 17, alignment: .top)
  ]

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(.system(size: 22, weight: .semibold, design: .rounded))
          Text("\(targets.count) available desktop\(targets.count == 1 ? "" : "s")")
            .font(.caption)
            .foregroundStyle(.tertiary)
        }

        Spacer()

        HStack(spacing: 7) {
          Image(systemName: "magnifyingglass")
            .foregroundStyle(.tertiary)
          TextField("Search computers", text: $query)
            .textFieldStyle(.plain)
            .frame(width: 176)
          if !query.isEmpty {
            Button {
              query = ""
            } label: {
              Image(systemName: "xmark.circle.fill")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.tertiary)
          }
        }
        .font(.system(size: 12, design: .rounded))
        .padding(.horizontal, 10)
        .frame(height: 32)
        .background(.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 8))

        Button(action: refresh) {
          Image(systemName: "arrow.clockwise")
            .opacity(isRefreshing ? 0.45 : 1)
        }
        .buttonStyle(.borderless)
        .help("Refresh Crabfleet")

        Button("Connect", systemImage: "plus", action: quickConnect)
          .buttonStyle(.borderedProminent)
          .controlSize(.small)
      }
      .padding(.horizontal, 22)
      .padding(.vertical, 17)

      Divider().overlay(.white.opacity(0.055))

      if targets.isEmpty {
        ContentUnavailableView(
          "No desktops here",
          systemImage: "rectangle.slash",
          description: Text("Change the source or add a VNC connection.")
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        ScrollView {
          LazyVGrid(columns: columns, alignment: .leading, spacing: 17) {
            ForEach(targets) { target in
              DesktopCard(
                target: target,
                session: sessions.session(for: target.id),
                namespace: namespace
              ) {
                focus(target.id)
              }
            }
          }
          .padding(22)
        }
        .scrollIndicators(.automatic)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

private struct DesktopCard: View {
  let target: DesktopTarget
  @ObservedObject var session: VNCSessionController
  let namespace: Namespace.ID
  let open: () -> Void

  @State private var isHovering = false

  private var accent: Color {
    target.source == .crabfleet
      ? Color(red: 1, green: 0.39, blue: 0.25)
      : Color(red: 0.25, green: 0.72, blue: 1)
  }

  var body: some View {
    Button(action: open) {
      ZStack(alignment: .bottom) {
        DesktopPreview(target: target, thumbnail: session.thumbnail, accent: accent)

        LinearGradient(
          colors: [.clear, .black.opacity(0.24), .black.opacity(0.88)],
          startPoint: .top,
          endPoint: .bottom
        )

        VStack(spacing: 0) {
          HStack(alignment: .top) {
            SourceBadge(source: target.source, accent: accent)
            Spacer()
            SessionPhaseBadge(phase: session.phase, fallbackStatus: target.status)
          }
          Spacer()
          HStack(alignment: .bottom, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
              Text(target.title)
                .font(.system(size: 16, weight: .semibold, design: .rounded))
                .lineLimit(1)
              Text(target.subtitle)
                .font(.system(size: 11, weight: .medium, design: .rounded))
                .foregroundStyle(.secondary)
                .lineLimit(1)
              if target.source == .crabfleet, let branch = target.branch {
                Label(branch, systemImage: "arrow.triangle.branch")
                  .font(.system(size: 9, weight: .medium, design: .monospaced))
                  .foregroundStyle(.tertiary)
                  .lineLimit(1)
              }
            }
            Spacer(minLength: 0)
            Image(systemName: "arrow.up.right")
              .font(.system(size: 12, weight: .semibold))
              .foregroundStyle(.primary)
              .padding(8)
              .background(.white.opacity(isHovering ? 0.15 : 0.075), in: Circle())
          }
        }
        .padding(13)
      }
      .aspectRatio(1.6, contentMode: .fit)
      .background(Color.black.opacity(0.55))
      .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: 13, style: .continuous)
          .stroke(isHovering ? accent.opacity(0.6) : .white.opacity(0.09), lineWidth: 1)
      }
      .overlay(alignment: .leading) {
        Rectangle()
          .fill(accent)
          .frame(width: 2)
          .padding(.vertical, 14)
      }
      .shadow(color: .black.opacity(isHovering ? 0.45 : 0.24), radius: isHovering ? 18 : 8, y: 7)
      .scaleEffect(isHovering ? 1.008 : 1)
      .matchedGeometryEffect(id: "desktop-\(target.id)", in: namespace, isSource: true)
    }
    .buttonStyle(.plain)
    .onHover { hovering in
      withAnimation(.easeOut(duration: 0.12)) {
        isHovering = hovering
      }
    }
    .accessibilityLabel("Open \(target.title)")
  }
}

private struct DesktopPreview: View {
  let target: DesktopTarget
  let thumbnail: NSImage?
  let accent: Color

  var body: some View {
    Group {
      if let thumbnail {
        Image(nsImage: thumbnail)
          .resizable()
          .interpolation(.high)
          .aspectRatio(contentMode: .fill)
      } else {
        ZStack {
          LinearGradient(
            colors: [accent.opacity(0.17), Color(red: 0.04, green: 0.05, blue: 0.055)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          )
          Canvas { context, size in
            var path = Path()
            let spacing: CGFloat = 24
            for x in stride(from: CGFloat.zero, through: size.width, by: spacing) {
              path.move(to: .init(x: x, y: 0))
              path.addLine(to: .init(x: x, y: size.height))
            }
            for y in stride(from: CGFloat.zero, through: size.height, by: spacing) {
              path.move(to: .init(x: 0, y: y))
              path.addLine(to: .init(x: size.width, y: y))
            }
            context.stroke(path, with: .color(.white.opacity(0.025)), lineWidth: 0.5)
          }
          Image(systemName: target.source == .crabfleet ? "server.rack" : "display")
            .font(.system(size: 31, weight: .ultraLight))
            .foregroundStyle(accent.opacity(0.55))
        }
      }
    }
    .clipped()
  }
}

private struct SourceBadge: View {
  let source: DesktopSource
  let accent: Color

  var body: some View {
    Label(source.label.uppercased(), systemImage: source == .crabfleet ? "server.rack" : "bookmark")
      .font(.system(size: 8, weight: .bold, design: .monospaced))
      .tracking(0.6)
      .foregroundStyle(accent)
      .padding(.horizontal, 7)
      .padding(.vertical, 5)
      .background(.black.opacity(0.42), in: Capsule())
  }
}

private struct SessionPhaseBadge: View {
  let phase: VNCSessionController.Phase
  let fallbackStatus: LeaseStatus?

  private var title: String {
    phase == .idle ? (fallbackStatus?.label ?? "Saved") : phase.title
  }

  private var color: Color {
    if phase != .idle { return phase.color }
    guard let fallbackStatus else { return .secondary }
    return StatusBeacon.color(for: fallbackStatus)
  }

  var body: some View {
    HStack(spacing: 5) {
      Circle().fill(color).frame(width: 5, height: 5)
      Text(title)
    }
    .font(.system(size: 9, weight: .semibold, design: .rounded))
    .foregroundStyle(.secondary)
    .padding(.horizontal, 7)
    .padding(.vertical, 5)
    .background(.black.opacity(0.42), in: Capsule())
  }
}

struct StatusBeacon: View {
  let status: LeaseStatus

  static func color(for status: LeaseStatus) -> Color {
    switch status {
    case .ready, .attached, .detached: .mint
    case .provisioning, .pendingAdapter: .orange
    case .failed: .red
    case .stopping, .stopped, .expired: .gray
    }
  }

  var body: some View {
    let color = Self.color(for: status)
    ZStack {
      Circle().fill(color.opacity(0.17)).frame(width: 14, height: 14)
      Circle().fill(color).frame(width: 6, height: 6)
    }
    .accessibilityLabel(status.label)
  }
}

private struct DeckBackground: View {
  var body: some View {
    LinearGradient(
      colors: [
        Color(red: 0.035, green: 0.041, blue: 0.045),
        Color(red: 0.018, green: 0.023, blue: 0.026),
      ],
      startPoint: .topLeading,
      endPoint: .bottomTrailing
    )
    .ignoresSafeArea()
  }
}
