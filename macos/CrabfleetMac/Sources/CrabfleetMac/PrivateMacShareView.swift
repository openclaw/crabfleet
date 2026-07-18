import AppKit
import SwiftUI

struct PrivateMacShareSheet: View {
  @ObservedObject var controller: PrivateMacShareController
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      HStack(spacing: 12) {
        ZStack {
          RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(.mint.opacity(0.1))
          Image(systemName: "display.and.arrow.down")
            .font(.system(size: 20, weight: .light))
            .foregroundStyle(.mint)
        }
        .frame(width: 42, height: 42)

        VStack(alignment: .leading, spacing: 2) {
          Text("Share This Mac")
            .font(.title3.weight(.semibold))
          Text("App-owned remote desktop, restricted to your current Tailscale identity.")
            .foregroundStyle(.secondary)
        }
      }

      VStack(spacing: 1) {
        ShareStatusRow(
          title: "Tailscale tailnet",
          detail: controller.identity.map {
            "\($0.tailnetName) · \($0.loginName) · \($0.ipv4Address)"
          } ?? "Not verified",
          isReady: controller.identity != nil
        )
        ShareStatusRow(
          title: controller.capturePermissionKind.title,
          detail: controller.capturePermissionDetail,
          isReady: controller.capturePermissionGranted,
          actionTitle: controller.capturePermissionGranted
            ? nil
            : (controller.capturePermissionKind == .remoteDesktop ? "Open Settings" : "Allow")
        ) {
          Task { await controller.requestCapturePermission() }
        }
        ShareStatusRow(
          title: "Remote control",
          detail: controller.accessibilityGranted
            ? "Accessibility allowed"
            : "Optional · view-only without it",
          isReady: controller.accessibilityGranted,
          actionTitle: controller.accessibilityGranted ? nil : "Allow"
        ) {
          controller.requestAccessibilityPermission()
        }
        ShareStatusRow(
          title: "Private desktop",
          detail: phaseDetail,
          isReady: controller.phase.isRunning
        )
        ShareStatusRow(
          title: "Crabfleet registry",
          detail: controller.registryPhase.detail,
          isReady: controller.registryPhase.isReady
        )
      }
      .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

      if let warning = controller.tailnetWarning {
        Label(warning, systemImage: "exclamationmark.triangle.fill")
          .font(.caption)
          .foregroundStyle(.orange)
          .fixedSize(horizontal: false, vertical: true)
      }

      VStack(alignment: .leading, spacing: 10) {
        if !controller.availableDisplays.isEmpty {
          VStack(alignment: .leading, spacing: 6) {
            Text("Shared displays")
              .font(.caption.weight(.semibold))
            ForEach(controller.availableDisplays) { display in
              Toggle(
                display.detail,
                isOn: Binding(
                  get: { controller.selectedDisplayIDs.contains(display.id) },
                  set: { controller.setDisplay(display.id, selected: $0) }
                )
              )
              .disabled(
                controller.phase.isRunning
                  || (!controller.selectedDisplayIDs.contains(display.id)
                    && controller.selectedDisplayIDs.count >= 4)
                  || (controller.selectedDisplayIDs.contains(display.id)
                    && controller.selectedDisplayIDs.count == 1)
              )
            }
          }
          .help("Share up to four displays; stop sharing to change the selection.")
        }

        Picker("Default quality", selection: $controller.qualityMode) {
          ForEach(ShareQualityMode.allCases) { mode in
            Text(mode.title).tag(mode)
          }
        }
        .pickerStyle(.segmented)
        .help("Default for older viewers; capable viewers choose their own quality.")

        if !controller.viewerSessions.isEmpty {
          VStack(alignment: .leading, spacing: 5) {
            Text("Viewer sessions")
              .font(.caption.weight(.semibold))
            ForEach(controller.viewerSessions) { viewer in
              HStack(spacing: 8) {
                Text(viewer.transport)
                  .font(.system(size: 9, weight: .bold, design: .monospaced))
                  .padding(.horizontal, 6)
                  .padding(.vertical, 3)
                  .background(.mint.opacity(0.12), in: Capsule())
                Text("\(viewer.display) · \(viewer.peer)")
                  .lineLimit(1)
                Spacer()
                Text(viewer.qualityMode.title)
                  .foregroundStyle(.secondary)
              }
              .font(.caption)
            }
          }
        }

        Toggle(
          "Sync clipboard with the connected device",
          isOn: $controller.clipboardSyncEnabled
        )
        .disabled(controller.phase.isRunning)
        .help("Text copied on either Mac is available on the other while connected.")

        HStack(spacing: 10) {
          Toggle(
            "Share a folder",
            isOn: Binding(
              get: { controller.sharedFolderName != nil },
              set: { enabled in
                if enabled { controller.chooseSharedFolder() } else { controller.stopSharingFolder() }
              }
            )
          )
          .disabled(controller.phase.isRunning)
          Spacer()
          if let name = controller.sharedFolderName {
            Label(name, systemImage: "folder.fill")
              .foregroundStyle(.secondary)
              .lineLimit(1)
            Button("Change") { controller.chooseSharedFolder() }
              .disabled(controller.phase.isRunning)
            Button("Stop sharing folder", role: .destructive) {
              controller.stopSharingFolder()
            }
            .disabled(controller.phase.isRunning)
          }
        }
        .help("Lets capable viewers browse, download, and upload only inside this folder.")

        if controller.sharedFolderName != nil {
          Toggle("Allow remote uploads and new folders", isOn: $controller.allowRemoteFolderWrites)
            .disabled(controller.phase.isRunning)
            .help("Uploads use a temporary file and become visible only after an atomic finish.")
        }

        Toggle(
          "Allow browser access via Crabfleet",
          isOn: $controller.browserAccessEnabled
        )
        .disabled(controller.registryPhase == .notConfigured)
        .help("Publishes an authenticated browser relay while this private share is running.")

        Toggle(
          "View only (ignore remote input)",
          isOn: $controller.viewOnlyEnabled
        )
        .help("Applies immediately and keeps remote keyboard and pointer events from reaching this Mac.")

        Toggle("Stream audio", isOn: $controller.streamAudioEnabled)
          .help("Streams system audio as AAC when the connected Crabfleet viewer supports it.")

        Toggle(
          "Start sharing when I log in",
          isOn: Binding(
            get: { controller.launchAtLoginEnabled },
            set: { controller.setLaunchAtLogin($0) }
          )
        )
        .help("Adds Crabfleet as a login item and starts this private share automatically.")
      }
      .toggleStyle(.switch)
      .controlSize(.small)

      if controller.phase.isRunning, !controller.connectionAddresses.isEmpty {
        VStack(alignment: .leading, spacing: 10) {
          Text("CONNECT FROM YOUR OTHER MAC")
            .font(.system(size: 9, weight: .bold, design: .monospaced))
            .tracking(0.8)
            .foregroundStyle(.secondary)
          ForEach(Array(controller.connectionAddresses.enumerated()), id: \.offset) {
            index, address in
            HStack(spacing: 10) {
              Text("Display \(index + 1) · \(address)")
                .font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
              Spacer()
              Button("Copy", systemImage: "doc.on.doc") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(address, forType: .string)
              }
            }
          }
          HStack(spacing: 10) {
            Text("Password · \(controller.accessCode)")
              .font(.system(.body, design: .monospaced))
              .textSelection(.enabled)
            Spacer()
            Button("Copy password", systemImage: "doc.on.doc") {
              NSPasteboard.general.clearContents()
              NSPasteboard.general.setString(controller.accessCode, forType: .string)
            }
            Button("Regenerate", systemImage: "arrow.clockwise") {
              controller.regenerateAccessCode()
            }
          }
          Text(
            "Open Crabfleet, choose Quick Connect, paste an address, and enter this password. Existing authenticated viewers stay connected after regeneration."
          )
          .font(.caption)
          .foregroundStyle(.secondary)
        }
        .padding(14)
        .background(.mint.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
      }

      if let notice = controller.notice {
        Label(notice, systemImage: "exclamationmark.triangle")
          .font(.caption)
          .foregroundStyle(.orange)
          .fixedSize(horizontal: false, vertical: true)
      } else {
        Label(
          "No Apple Screen Sharing service is used. The listener binds only to this Mac’s Tailscale address and accepts only another device owned by the same Tailscale user.",
          systemImage: "lock.shield"
        )
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      }

      HStack {
        Menu("Privacy Settings") {
          Button("Screen Recording") {
            controller.openPrivacySettings(.screenRecording)
          }
          Button("Remote Desktop") {
            controller.openRemoteDesktopSettingsForExperiment()
          }
          Button("Accessibility") {
            controller.openPrivacySettings(.accessibility)
          }
          Divider()
          Toggle(
            "Use Remote Desktop permission (experimental)",
            isOn: $controller.experimentalRemoteDesktopCaptureEnabled
          )
          .disabled(controller.phase.isRunning)
        }

        Button("Refresh") {
          Task { await controller.refresh() }
        }
        .disabled(controller.isRefreshing || controller.phase == .starting)

        Spacer()

        Button("Close") { dismiss() }
          .keyboardShortcut(.cancelAction)

        if controller.phase.isRunning || controller.phase == .failed {
          Button("Stop Sharing", role: .destructive) {
            Task { await controller.stop() }
          }
          .disabled(controller.phase == .stopping)
        } else {
          Button("Start Private Share") {
            Task { await controller.start() }
          }
          .buttonStyle(.borderedProminent)
          .keyboardShortcut(.defaultAction)
          .disabled(!controller.canStart)
        }
      }

      Text("Crabfleet must remain running on this Mac while you are connected.")
        .font(.caption2)
        .foregroundStyle(.tertiary)
    }
    .padding(24)
    .frame(width: 590)
    .task { await controller.refresh() }
    .onAppear { controller.startPermissionMonitoring() }
    .onDisappear { controller.stopPermissionMonitoring() }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active {
        controller.refreshPermissions()
      }
    }
  }

  private var phaseDetail: String {
    let viewers = controller.connectedViewerCount == 1
      ? "1 viewer"
      : "\(controller.connectedViewerCount) viewers"
    if let stats = controller.streamStats, controller.phase == .connected {
      let video = String(
        format: "%@ · %.0f fps · %.1f Mbit/s · target %.1f · dirty %.0f%%",
        stats.codecDetail,
        stats.framesPerSecond,
        stats.megabitsPerSecond,
        Double(stats.targetBitrate) / 1_000_000,
        stats.dirtyAreaPercent)
      let detail = controller.audioActive ? "\(video) · audio: AAC 48 kHz" : video
      return "\(viewers) · \(detail)"
    }
    if controller.connectedViewerCount > 0 { return viewers }
    if let peer = controller.connectedPeer {
      return "\(controller.phase.title) · \(peer)"
    }
    return controller.phase.title
  }
}

private struct ShareStatusRow: View {
  let title: String
  let detail: String
  let isReady: Bool
  var actionTitle: String?
  var action: () -> Void = {}

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: isReady ? "checkmark.circle.fill" : "circle.dashed")
        .foregroundStyle(isReady ? .mint : .orange)
        .frame(width: 18)
      Text(title)
        .font(.system(size: 12, weight: .semibold, design: .rounded))
      Spacer()
      Text(detail)
        .font(.system(size: 11, design: .rounded))
        .foregroundStyle(.secondary)
        .lineLimit(1)
      if let actionTitle {
        Button(actionTitle, action: action)
          .controlSize(.small)
      }
    }
    .padding(.horizontal, 12)
    .frame(height: 42)
    .background(.white.opacity(0.045))
  }
}
