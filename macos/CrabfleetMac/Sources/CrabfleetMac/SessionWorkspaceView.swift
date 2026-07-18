import AppKit
import SwiftUI

struct DesktopFocusView: View {
  let target: DesktopTarget
  let targets: [DesktopTarget]
  @ObservedObject var session: VNCSessionController
  @ObservedObject var sessions: VNCSessionPool
  let namespace: Namespace.ID
  let connect: () -> Void
  let disconnect: () -> Void
  let switchTo: (DesktopTarget.ID) -> Void
  let close: () -> Void

  var body: some View {
    VStack(spacing: 0) {
      FocusToolbar(
        target: target,
        session: session,
        clipboard: sessions.clipboardCoordinator,
        connect: connect,
        disconnect: disconnect,
        close: close
      )
      Divider().overlay(.white.opacity(0.07))

      ZStack {
        if session.framebuffer != nil {
          RemoteDesktopView(session: session)
        } else {
          FocusCanvasBackground()
          FocusPlaceholder(target: target, session: session, connect: connect)
        }
        if session.isFileBrowserVisible, session.sharedFolderName != nil {
          HStack {
            Spacer()
            NativeSharedFolderPanel(session: session)
              .frame(width: 360)
              .padding(12)
          }
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .matchedGeometryEffect(id: "desktop-\(target.id)", in: namespace, isSource: false)

      if targets.count > 1 {
        DesktopSwitcher(
          targets: targets,
          selectedID: target.id,
          sessions: sessions,
          clipboard: sessions.clipboardCoordinator,
          switchTo: switchTo
        )
      }

      FocusStatusBar(target: target, session: session)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color(red: 0.014, green: 0.017, blue: 0.019).ignoresSafeArea())
    .transition(.opacity)
  }
}

private struct FocusToolbar: View {
  let target: DesktopTarget
  @ObservedObject var session: VNCSessionController
  @ObservedObject var clipboard: ClipboardCoordinator
  let connect: () -> Void
  let disconnect: () -> Void
  let close: () -> Void

  var body: some View {
    HStack(spacing: 12) {
      Button(action: close) {
        Image(systemName: "chevron.backward")
          .frame(width: 25, height: 25)
          .background(.white.opacity(0.06), in: Circle())
      }
      .buttonStyle(.plain)
      .help("Back to computers")

      VStack(alignment: .leading, spacing: 1) {
        HStack(spacing: 7) {
          Text(target.title)
            .font(.system(size: 14, weight: .semibold, design: .rounded))
          Text(target.source.label.uppercased())
            .font(.system(size: 7, weight: .bold, design: .monospaced))
            .tracking(0.6)
            .foregroundStyle(target.source == .crabfleet ? .orange : .blue)
        }
        Text(target.source == .crabfleet ? target.detail : target.subtitle)
          .font(.caption)
          .foregroundStyle(.tertiary)
          .lineLimit(1)
      }

      Spacer()

      if session.phase == .connected {
        Picker("Quality", selection: $session.qualityMode) {
          ForEach(ShareQualityMode.allCases) { mode in
            Text(mode.title).tag(mode)
          }
        }
        .pickerStyle(.segmented)
        .frame(width: 190)
        .help("Quality for this viewer and host")

        Button {
          session.toggleAudioMuted()
        } label: {
          FocusControlPill(
            icon: session.isAudioMuted ? "speaker.slash.fill" : "speaker.wave.2.fill",
            title: session.isAudioMuted ? "Muted" : "Audio",
            color: session.isAudioMuted ? .secondary : .mint
          )
        }
        .buttonStyle(.plain)
        .help(session.isAudioMuted ? "Unmute remote audio" : "Mute remote audio")

        if session.clipboardEnabled {
          Menu {
            Button("Send Mac Clipboard Now", systemImage: "arrow.up.doc.on.clipboard") {
              clipboard.sendCurrentClipboard()
            }
            Button("Get Remote Clipboard", systemImage: "arrow.down.doc.on.clipboard") {
              clipboard.applyRemoteClipboard(for: target.id)
            }
            .disabled(!clipboard.hasRemoteClipboard(for: target.id))
            Divider()
            Picker("Sync Direction", selection: $clipboard.direction) {
              ForEach(ClipboardCoordinator.SyncDirection.allCases) { direction in
                Text(direction.title).tag(direction)
              }
            }
            .pickerStyle(.inline)
            Divider()
            Text(clipboard.state.title)
          } label: {
            FocusControlPill(
              icon: clipboardIcon,
              title: clipboard.state.title,
              color: clipboardColor
            )
          }
          .menuStyle(.borderlessButton)
          .help("Clipboard synchronization and recovery actions")
        } else {
          FocusControlPill(icon: "clipboard", title: "Clipboard off", color: .secondary)
        }
        if let folderName = session.sharedFolderName {
          Button { session.showFileBrowser() } label: {
            FocusControlPill(
              icon: "folder.fill",
              title: session.isFileBrowserVisible ? "Hide \(folderName)" : folderName,
              color: .mint)
          }
          .buttonStyle(.plain)
          .help("Browse and transfer files in the host's shared folder")
        }
        FocusControlPill(
          icon: "rectangle.arrowtriangle.2.outward",
          title: "Fit",
          color: .secondary
        )
      }

      Button {
        NSApp.keyWindow?.toggleFullScreen(nil)
      } label: {
        Image(systemName: "arrow.up.left.and.arrow.down.right")
      }
      .buttonStyle(.borderless)
      .help("Toggle full screen")

      if session.phase.isConnectedOrConnecting {
        Button("Disconnect", systemImage: "xmark.circle", action: disconnect)
          .buttonStyle(.bordered)
      } else {
        Button("Connect", systemImage: "play.fill", action: connect)
          .buttonStyle(.borderedProminent)
          .disabled(!target.desktopAvailable)
      }
    }
    .padding(.horizontal, 10)
    .frame(height: 44)
    .background(Color(red: 0.045, green: 0.049, blue: 0.052))
  }

  private var clipboardIcon: String {
    switch clipboard.state {
    case .remoteAvailable: "clipboard.fill"
    case .error: "exclamationmark.triangle.fill"
    case .synced: "checkmark.circle.fill"
    default: "doc.on.clipboard"
    }
  }

  private var clipboardColor: Color {
    switch clipboard.state {
    case .error: .red
    case .remoteAvailable: .orange
    case .synced: .mint
    default: .secondary
    }
  }
}

private struct NativeSharedFolderPanel: View {
  @ObservedObject var session: VNCSessionController

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        VStack(alignment: .leading, spacing: 2) {
          Text(session.sharedFolderName ?? "Shared folder")
            .font(.headline)
          Text("/\(session.sharedFolderPath)")
            .font(.caption.monospaced())
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        Spacer()
        Button("Up", systemImage: "chevron.up") { session.navigateSharedFolderUp() }
          .disabled(session.sharedFolderPath.isEmpty)
        Button("Close", systemImage: "xmark") { session.showFileBrowser() }
          .labelStyle(.iconOnly)
      }
      .padding(12)

      Divider()

      if session.sharedFolderEntries.isEmpty {
        ContentUnavailableView(
          "Folder is empty", systemImage: "folder",
          description: Text("Files shared by the host appear here."))
          .frame(maxHeight: .infinity)
      } else {
        List(session.sharedFolderEntries) { entry in
          Button { session.openSharedFolderEntry(entry) } label: {
            HStack(spacing: 9) {
              Image(systemName: entry.isDirectory ? "folder.fill" : "doc.fill")
                .foregroundStyle(entry.isDirectory ? .mint : .secondary)
              Text(entry.name).lineLimit(1)
              Spacer()
              Text(entry.isDirectory ? "" : ByteCountFormatter.string(
                fromByteCount: Int64(entry.size), countStyle: .file))
                .font(.caption)
                .foregroundStyle(.secondary)
            }
          }
          .buttonStyle(.plain)
        }
        .listStyle(.plain)
      }

      if let progress = session.fileTransferProgress {
        ProgressView(value: progress).padding(.horizontal, 12)
      }
      if let status = session.fileTransferStatus {
        Text(status)
          .font(.caption)
          .foregroundStyle(.secondary)
          .padding(.horizontal, 12)
          .padding(.top, 6)
      }

      if session.sharedFolderWritesAllowed {
        HStack {
          Button("Upload Files…", systemImage: "arrow.up.doc") {
            session.chooseFilesToUpload()
          }
          Button("New Folder", systemImage: "folder.badge.plus") {
            session.createSharedFolderDirectory()
          }
        }
        .padding(12)
      } else {
        Text("Uploads disabled by host")
          .font(.caption)
          .foregroundStyle(.secondary)
          .padding(12)
      }
    }
    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(.white.opacity(0.12)))
    .dropDestination(for: URL.self) { urls, _ in
      guard session.sharedFolderWritesAllowed else { return false }
      session.uploadSharedFiles(urls)
      return true
    }
  }
}

private struct FocusControlPill: View {
  let icon: String
  let title: String
  let color: Color

  var body: some View {
    Label(title, systemImage: icon)
      .font(.system(size: 10, weight: .medium, design: .rounded))
      .foregroundStyle(color)
      .padding(.horizontal, 8)
      .padding(.vertical, 5)
      .background(.white.opacity(0.05), in: Capsule())
  }
}

private struct FocusPlaceholder: View {
  let target: DesktopTarget
  @ObservedObject var session: VNCSessionController
  let connect: () -> Void

  var body: some View {
    ZStack {
      if let thumbnail = session.thumbnail {
        Image(nsImage: thumbnail)
          .resizable()
          .aspectRatio(contentMode: .fill)
          .blur(radius: 18)
          .opacity(0.22)
          .clipped()
      }

      VStack(spacing: 17) {
        ZStack {
          RoundedRectangle(cornerRadius: 22, style: .continuous)
            .fill(.mint.opacity(0.075))
            .stroke(.mint.opacity(0.14), lineWidth: 1)
          Image(systemName: session.phase == .failed ? "exclamationmark.triangle" : "display")
            .font(.system(size: 32, weight: .ultraLight))
            .foregroundStyle(session.phase == .failed ? Color.red : Color.mint)
        }
        .frame(width: 86, height: 86)

        VStack(spacing: 5) {
          Text(session.phase.title)
            .font(.system(size: 21, weight: .semibold, design: .rounded))
          Text(session.errorMessage ?? "Connect to \(target.title) with the native Metal viewer.")
            .font(.callout)
            .foregroundStyle(session.errorMessage == nil ? Color.secondary : Color.red)
            .multilineTextAlignment(.center)
            .frame(maxWidth: 480)
        }

        if session.phase.isConnectedOrConnecting {
          ProgressView().controlSize(.small)
        } else {
          Button("Connect to Desktop", systemImage: "play.fill", action: connect)
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(!target.desktopAvailable)
        }
      }
      .padding(42)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

private struct DesktopSwitcher: View {
  let targets: [DesktopTarget]
  let selectedID: DesktopTarget.ID
  @ObservedObject var sessions: VNCSessionPool
  @ObservedObject var clipboard: ClipboardCoordinator
  let switchTo: (DesktopTarget.ID) -> Void

  var body: some View {
    ScrollView(.horizontal) {
      HStack(spacing: 7) {
        ForEach(targets) { candidate in
          DesktopSwitcherButton(
            target: candidate,
            session: sessions.session(for: candidate.id),
            isSelected: candidate.id == selectedID,
            hasPendingClipboard: clipboard.hasPendingRemoteClipboard(for: candidate.id)
          ) {
            switchTo(candidate.id)
          }
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 4)
    }
    .scrollIndicators(.hidden)
    .frame(height: 47)
  }
}

private struct DesktopSwitcherButton: View {
  let target: DesktopTarget
  @ObservedObject var session: VNCSessionController
  let isSelected: Bool
  let hasPendingClipboard: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 7) {
        ZStack {
          RoundedRectangle(cornerRadius: 4)
            .fill(.white.opacity(0.055))
          if let thumbnail = session.thumbnail {
            Image(nsImage: thumbnail)
              .resizable()
              .aspectRatio(contentMode: .fill)
              .clipShape(RoundedRectangle(cornerRadius: 4))
          } else {
            Image(systemName: target.source == .crabfleet ? "server.rack" : "display")
              .font(.system(size: 9))
              .foregroundStyle(.tertiary)
          }
          if hasPendingClipboard {
            Image(systemName: "clipboard.fill")
              .font(.system(size: 6, weight: .bold))
              .foregroundStyle(.black)
              .padding(3)
              .background(.orange, in: Circle())
              .offset(x: 17, y: -10)
          }
        }
        .frame(width: 38, height: 24)

        VStack(alignment: .leading, spacing: 1) {
          Text(target.title)
            .font(.system(size: 10, weight: .semibold, design: .rounded))
          Text(session.phase == .idle ? target.subtitle : session.phase.title)
            .font(.system(size: 8, weight: .medium, design: .rounded))
            .foregroundStyle(.tertiary)
            .lineLimit(1)
        }
      }
      .padding(.horizontal, 7)
      .frame(height: 34)
      .background(
        RoundedRectangle(cornerRadius: 7, style: .continuous)
          .fill(isSelected ? Color.white.opacity(0.095) : .white.opacity(0.035))
      )
      .overlay {
        RoundedRectangle(cornerRadius: 7, style: .continuous)
          .stroke(isSelected ? Color.mint.opacity(0.65) : .clear, lineWidth: 1)
      }
    }
    .buttonStyle(.plain)
  }
}

private struct FocusStatusBar: View {
  let target: DesktopTarget
  @ObservedObject var session: VNCSessionController

  var body: some View {
    HStack(spacing: 9) {
      Circle().fill(session.phase.color).frame(width: 5, height: 5)
      Text(session.phase.title).fontWeight(.medium)
      if let endpoint = session.endpointDescription {
        Text("·")
        Text(endpoint).font(.system(.caption, design: .monospaced))
      }
      if let transport = session.transport {
        Text("·")
        Text(transport.label)
          .font(.system(.caption, design: .monospaced).weight(.semibold))
      }
      Spacer()
      if target.source == .crabfleet, let owner = target.owner {
        Text(owner)
        Text("·")
      }
      Text("RoyalVNCKit · IOSurface · Metal")
        .foregroundStyle(.tertiary)
    }
    .font(.caption)
    .foregroundStyle(.secondary)
    .padding(.horizontal, 10)
    .frame(height: 22)
  }
}

private struct FocusCanvasBackground: View {
  var body: some View {
    Canvas { context, size in
      context.fill(
        Path(CGRect(origin: .zero, size: size)),
        with: .color(Color(red: 0.022, green: 0.027, blue: 0.03)))
      var path = Path()
      let spacing: CGFloat = 31
      for x in stride(from: CGFloat.zero, through: size.width, by: spacing) {
        path.move(to: .init(x: x, y: 0))
        path.addLine(to: .init(x: x, y: size.height))
      }
      for y in stride(from: CGFloat.zero, through: size.height, by: spacing) {
        path.move(to: .init(x: 0, y: y))
        path.addLine(to: .init(x: size.width, y: y))
      }
      context.stroke(path, with: .color(.white.opacity(0.022)), lineWidth: 0.5)
    }
  }
}

struct DesktopConnectionSheet: View {
  let target: DesktopTarget
  let connect: (VNCConnectionRequest, WakeOnLan.ProfileSettings?) -> Bool
  private let credentialAddress: String
  private let credentialUsername: String
  private let credentialAccessCode: String
  private let canSafelySubmitBlank: Bool

  @Environment(\.dismiss) private var dismiss
  @State private var address: String
  @State private var username: String
  @State private var password = ""
  @State private var rememberAccessCode: Bool
  @State private var prefersPasswordOnlyARD: Bool
  @State private var clipboardEnabled = false
  @State private var macAddress: String
  @State private var wakeOnLanBroadcast: String
  @State private var wakeOnLanAutomatically: Bool
  @State private var validationMessage: String?

  init(
    target: DesktopTarget,
    storedAccessCode: StoredAccessCode = .missing,
    connect: @escaping (VNCConnectionRequest, WakeOnLan.ProfileSettings?) -> Bool
  ) {
    self.target = target
    self.connect = connect
    let address = target.endpoint?.displayValue ?? "127.0.0.1:5900"
    credentialAddress = address
    credentialUsername = target.endpoint?.username ?? ""
    credentialAccessCode = storedAccessCode.value
    canSafelySubmitBlank = storedAccessCode == .missing
    _address = State(initialValue: address)
    _username = State(initialValue: target.endpoint?.username ?? "")
    _password = { password in State(initialValue: password) }(storedAccessCode.value)
    _rememberAccessCode = State(initialValue: storedAccessCode.wasRemembered)
    _prefersPasswordOnlyARD = State(initialValue: target.prefersPasswordOnlyARD)
    _macAddress = State(initialValue: target.macAddress ?? "")
    _wakeOnLanBroadcast = State(initialValue: target.wakeOnLanBroadcast ?? "")
    _wakeOnLanAutomatically = State(initialValue: target.wakeOnLanAutomatically)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      ConnectionSheetHeader(
        title: "Connect to \(target.title)",
        subtitle: target.source == .crabfleet
          ? "Use the loopback endpoint from the Crabbox tunnel."
          : "Open a direct VNC connection with the native viewer."
      )

      Form {
        TextField("VNC address", text: $address, prompt: Text("host:5900 or vnc://host:5900"))
        TextField("Username (optional)", text: $username)
        SecureField("Password", text: $password)
        Toggle("Crabfleet Share (prefer ARD)", isOn: $prefersPasswordOnlyARD)
        Toggle("Remember password in Keychain", isOn: $rememberAccessCode)
        Toggle("Synchronize text clipboard", isOn: $clipboardEnabled)
        if target.profileID != nil {
          Section("Wake-on-LAN") {
            TextField(
              "MAC address (optional)", text: $macAddress,
              prompt: Text("aa:bb:cc:dd:ee:ff"))
            TextField(
              "Broadcast address", text: $wakeOnLanBroadcast,
              prompt: Text(WakeOnLan.defaultBroadcastAddress)
            )
            .disabled(macAddress.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Toggle("Wake after the initial TCP connection fails", isOn: $wakeOnLanAutomatically)
              .disabled(macAddress.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Text("Wake-on-LAN normally reaches only devices on the same local network.")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
      }
      .formStyle(.grouped)

      ClipboardConnectionWarning(isEnabled: clipboardEnabled)

      if let validationMessage {
        Text(validationMessage)
          .font(.caption)
          .foregroundStyle(.red)
      } else {
        Label(
          "Direct VNC is usually unencrypted. Prefer localhost through SSH or a trusted private network.",
          systemImage: "lock.trianglebadge.exclamationmark"
        )
        .font(.caption)
        .foregroundStyle(.secondary)
      }

      HStack {
        Text(
          rememberAccessCode
            ? "The password is stored in this Mac’s Keychain for this host and port."
            : "The password stays in memory for this connection only."
        )
          .font(.caption)
          .foregroundStyle(.tertiary)
        Spacer()
        Button("Cancel") { dismiss() }
          .keyboardShortcut(.cancelAction)
        Button("Connect", action: submit)
          .buttonStyle(.borderedProminent)
          .keyboardShortcut(.defaultAction)
      }
    }
    .padding(24)
    .frame(width: 540)
    .onChange(of: address) { _, _ in refreshPasswordForCredentialIdentity() }
    .onChange(of: username) { _, _ in refreshPasswordForCredentialIdentity() }
  }

  private func refreshPasswordForCredentialIdentity() {
    password =
      address == credentialAddress && username == credentialUsername
      ? credentialAccessCode
      : ""
  }

  private func submit() {
    do {
      let parsed = try VNCAddress.parse(address)
      let effectiveUsername = username.isEmpty ? parsed.username : username
      let identityChanged = address != credentialAddress || effectiveUsername != credentialUsername
      guard !password.isEmpty || (canSafelySubmitBlank && !identityChanged) else {
        validationMessage = "Enter the password for this host and username."
        return
      }
      let wakeOnLan: WakeOnLan.ProfileSettings? = if target.profileID != nil {
        try WakeOnLan.ProfileSettings(
          macAddress: macAddress,
          broadcastAddress: wakeOnLanBroadcast,
          automaticallyWakeOnFailure: wakeOnLanAutomatically)
      } else {
        nil
      }
      guard connect(
        .init(
          host: parsed.host,
          port: parsed.port,
          username: effectiveUsername,
          password: password,
          clipboardEnabled: clipboardEnabled,
          rememberAccessCode: rememberAccessCode,
          prefersPasswordOnlyARD: prefersPasswordOnlyARD
        ),
        wakeOnLan)
      else {
        validationMessage = "Crabfleet could not update this password in Keychain."
        return
      }
      password = ""
      dismiss()
    } catch {
      validationMessage = error.localizedDescription
    }
  }
}

struct QuickConnectSheet: View {
  let storedAccessCode: (VNCAddress) -> StoredAccessCode
  let connect:
    (String, VNCAddress, String, Bool, Bool, Bool, WakeOnLan.ProfileSettings?) -> Bool

  @Environment(\.dismiss) private var dismiss
  @FocusState private var addressFocused: Bool
  @State private var name = ""
  @State private var address = ""
  @State private var username = ""
  @State private var password = ""
  @State private var rememberAccessCode = false
  @State private var prefersPasswordOnlyARD = false
  @State private var clipboardEnabled = false
  @State private var macAddress = ""
  @State private var wakeOnLanBroadcast = ""
  @State private var wakeOnLanAutomatically = false
  @State private var validationMessage: String?
  @State private var credentialIdentity: VNCAddress?

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      ConnectionSheetHeader(
        title: "Quick Connect",
        subtitle: "Add any standard VNC server to your desktop deck."
      )

      Form {
        TextField("VNC address", text: $address, prompt: Text("host:5900 or vnc://host:5900"))
          .focused($addressFocused)
        TextField("Name", text: $name, prompt: Text("Design workstation"))
        TextField("Username (optional)", text: $username)
        SecureField("Password", text: $password)
        Toggle("Crabfleet Share (prefer ARD)", isOn: $prefersPasswordOnlyARD)
        Toggle("Remember password in Keychain", isOn: $rememberAccessCode)
        Toggle("Synchronize text clipboard", isOn: $clipboardEnabled)
        Section("Wake-on-LAN") {
          TextField(
            "MAC address (optional)", text: $macAddress,
            prompt: Text("aa:bb:cc:dd:ee:ff"))
          TextField(
            "Broadcast address", text: $wakeOnLanBroadcast,
            prompt: Text(WakeOnLan.defaultBroadcastAddress)
          )
          .disabled(macAddress.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          Toggle("Wake after the initial TCP connection fails", isOn: $wakeOnLanAutomatically)
            .disabled(macAddress.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          Text("Wake-on-LAN normally reaches only devices on the same local network.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      .formStyle(.grouped)

      ClipboardConnectionWarning(isEnabled: clipboardEnabled)

      if let validationMessage {
        Text(validationMessage)
          .font(.caption)
          .foregroundStyle(.red)
      } else {
        Text(
          rememberAccessCode
            ? "The connection is saved; the password is stored in this Mac’s Keychain."
            : "The connection is saved; the password is not."
        )
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      HStack {
        Spacer()
        Button("Cancel") { dismiss() }
          .keyboardShortcut(.cancelAction)
        Button("Add & Connect", action: submit)
          .buttonStyle(.borderedProminent)
          .keyboardShortcut(.defaultAction)
      }
    }
    .padding(24)
    .frame(width: 540)
    .onAppear { addressFocused = true }
    .onChange(of: address) { _, _ in refreshRememberedState() }
    .onChange(of: username) { _, _ in refreshRememberedState() }
  }

  private func refreshRememberedState() {
    guard let parsed = try? VNCAddress.parse(address) else { return }
    let effectiveAddress = VNCAddress(
      host: parsed.host,
      port: parsed.port,
      username: username.isEmpty ? parsed.username : username)
    guard effectiveAddress != credentialIdentity else { return }
    credentialIdentity = effectiveAddress
    password = ""
    rememberAccessCode = storedAccessCode(effectiveAddress).wasRemembered
  }

  private func submit() {
    do {
      let parsed = try VNCAddress.parse(address)
      let effectiveAddress = VNCAddress(
        host: parsed.host,
        port: parsed.port,
        username: username.isEmpty ? parsed.username : username
      )
      let effectiveName =
        name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        ? parsed.host
        : name.trimmingCharacters(in: .whitespacesAndNewlines)
      let hasWakeOnLanInput =
        !macAddress.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        || !wakeOnLanBroadcast.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        || wakeOnLanAutomatically
      let wakeOnLan = try hasWakeOnLanInput
        ? WakeOnLan.ProfileSettings(
          macAddress: macAddress,
          broadcastAddress: wakeOnLanBroadcast,
          automaticallyWakeOnFailure: wakeOnLanAutomatically)
        : nil
      guard
        connect(
          effectiveName,
          effectiveAddress,
          password,
          clipboardEnabled,
          rememberAccessCode,
          prefersPasswordOnlyARD,
          wakeOnLan)
      else {
        validationMessage = "Crabfleet could not update this password in Keychain."
        return
      }
      password = ""
      dismiss()
    } catch {
      validationMessage = error.localizedDescription
    }
  }
}

private struct ClipboardConnectionWarning: View {
  let isEnabled: Bool

  var body: some View {
    if isEnabled {
      Label(
        "Only stable text changes are sent, and only to the focused desktop. Existing Mac clipboard text is not sent when the connection opens.",
        systemImage: "clipboard"
      )
      .font(.caption)
      .foregroundStyle(.orange)
    }
  }
}

private struct ConnectionSheetHeader: View {
  let title: String
  let subtitle: String

  var body: some View {
    HStack(spacing: 12) {
      ZStack {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(.mint.opacity(0.1))
        Image(systemName: "cable.connector")
          .font(.system(size: 20, weight: .light))
          .foregroundStyle(.mint)
      }
      .frame(width: 42, height: 42)

      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.title3.weight(.semibold))
        Text(subtitle).foregroundStyle(.secondary)
      }
    }
  }
}
