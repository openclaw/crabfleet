import AppKit
import SwiftUI

struct PrivateMacShareSheet: View {
  @ObservedObject var controller: PrivateMacShareController
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    ShareSheetContainer(width: 600) {
      VStack(alignment: .leading, spacing: 16) {
        ShareSheetHeader(
          systemImage: "display.and.arrow.down",
          title: "Share This Mac",
          subtitle: "App-owned remote desktop, restricted to your current Tailscale identity."
        ) {
          SharePhaseBadge(phase: controller.phase)
        }
        readinessSection

        if let warning = controller.tailnetWarning {
          Label(warning, systemImage: "exclamationmark.triangle.fill")
            .font(.caption)
            .foregroundStyle(.orange)
            .fixedSize(horizontal: false, vertical: true)
        }

        sharingSection
        optionsSection

        if controller.phase.isRunning, !controller.connectionAddresses.isEmpty {
          connectSection
        }

        assurance
        footer
      }
    }
    .task { await controller.refresh() }
    .onAppear { controller.startPermissionMonitoring() }
    .onDisappear { controller.stopPermissionMonitoring() }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active {
        controller.refreshPermissions()
      }
    }
  }

  private var readinessSection: some View {
    VStack(alignment: .leading, spacing: 8) {
      ShareSectionHeader(title: "Readiness")
      ShareCard {
        VStack(spacing: 0) {
          ShareStatusRow(
            title: "Tailscale tailnet",
            detail: controller.identity.map {
              "\($0.tailnetName) · \($0.loginName) · \($0.ipv4Address)"
            } ?? "Not verified",
            isReady: controller.identity != nil,
            truncationMode: .middle)
          ShareCardDivider()
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
          ShareCardDivider()
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
          ShareCardDivider()
          ShareStatusRow(
            title: "Private desktop",
            detail: phaseDetail,
            isReady: controller.phase.isRunning,
            isPulsing: controller.phase == .starting)
          ShareCardDivider()
          ShareStatusRow(
            title: "Crabfleet registry",
            detail: controller.registryPhase.detail,
            isReady: controller.registryPhase.isReady,
            isPulsing: controller.registryPhase == .registering)
        }
      }
    }
  }

  private var sharingSection: some View {
    VStack(alignment: .leading, spacing: 8) {
      ShareSectionHeader(title: "Sharing")
      ShareCard {
        VStack(spacing: 0) {
          if !controller.availableDisplays.isEmpty {
            ForEach(Array(controller.availableDisplays.enumerated()), id: \.element.id) {
              index, display in
              let isSelected = controller.selectedDisplayIDs.contains(display.id)
              Toggle(
                isOn: Binding(
                  get: { controller.selectedDisplayIDs.contains(display.id) },
                  set: { controller.setDisplay(display.id, selected: $0) }
                )
              ) {
                ShareToggleLabel(
                  systemName: "display",
                  title: display.detail,
                  isActive: isSelected)
              }
              .disabled(
                controller.phase.isRunning
                  || (!isSelected && controller.selectedDisplayIDs.count >= 4)
                  || (isSelected && controller.selectedDisplayIDs.count == 1)
              )
              .help("Share up to four displays; stop sharing to change the selection.")

              if index < controller.availableDisplays.count - 1 {
                ShareCardDivider()
              }
            }
            ShareCardDivider()
          }

          VStack(alignment: .leading, spacing: 7) {
            Text("Default quality")
              .font(.system(size: 12.5, weight: .medium, design: .rounded))
            ShareSegmentedControl(
              selection: $controller.qualityMode,
              options: ShareQualityMode.allCases,
              title: { $0.title })
          }
          .padding(14)
          .help("Default for older viewers; capable viewers choose their own quality.")

          if !controller.viewerSessions.isEmpty {
            ShareCardDivider(leadingInset: 14)
            Text("VIEWER SESSIONS")
              .font(.system(size: 9, weight: .bold, design: .monospaced))
              .tracking(0.8)
              .foregroundStyle(.secondary)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(.horizontal, 14)
              .padding(.vertical, 9)

            ForEach(Array(controller.viewerSessions.enumerated()), id: \.element.id) {
              index, viewer in
              if index > 0 {
                ShareCardDivider(leadingInset: 14)
              }
              HStack(spacing: 8) {
                Text(viewer.transport)
                  .font(.system(size: 9, weight: .bold, design: .monospaced))
                  .foregroundStyle(.mint)
                  .padding(.horizontal, 6)
                  .padding(.vertical, 3)
                  .background(.mint.opacity(0.12), in: Capsule())
                Text("\(viewer.display) · \(viewer.peer)")
                  .font(.system(size: 11.5, design: .rounded))
                  .lineLimit(1)
                Spacer()
                Text(viewer.qualityMode.title)
                  .font(.system(size: 11.5, design: .rounded))
                  .foregroundStyle(.secondary)
              }
              .padding(.horizontal, 14)
              .padding(.vertical, 9)
            }
          }
        }
      }
    }
  }

  private var optionsSection: some View {
    VStack(alignment: .leading, spacing: 8) {
      ShareSectionHeader(title: "Options")
      ShareCard {
        VStack(spacing: 0) {
          Toggle(isOn: $controller.clipboardSyncEnabled) {
            ShareToggleLabel(
              systemName: "arrow.triangle.2.circlepath.doc.on.clipboard",
              fallbackSystemName: "doc.on.clipboard",
              title: "Sync clipboard",
              caption: "Text copied on either Mac is available on the other.",
              isActive: controller.clipboardSyncEnabled)
          }
          .disabled(controller.phase.isRunning)
          .help("Text copied on either Mac is available on the other while connected.")
          ShareCardDivider()

          Toggle(
            isOn: Binding(
              get: { controller.sharedFolderName != nil },
              set: { enabled in
                if enabled { controller.chooseSharedFolder() } else { controller.stopSharingFolder() }
              }
            )
          ) {
            ShareToggleLabel(
              systemName: "folder",
              title: "Share a folder",
              caption: controller.sharedFolderName.map { "Sharing \($0)" }
                ?? "Let capable viewers browse, download, and upload one folder.",
              isActive: controller.sharedFolderName != nil)
          }
          .disabled(controller.phase.isRunning)
          .help("Lets capable viewers browse, download, and upload only inside this folder.")

          if let name = controller.sharedFolderName {
            HStack(spacing: 10) {
              Label(name, systemImage: "folder.fill")
                .foregroundStyle(.secondary)
                .lineLimit(1)
              Spacer()
              Button("Change") { controller.chooseSharedFolder() }
                .disabled(controller.phase.isRunning)
              Button("Stop sharing folder", role: .destructive) {
                controller.stopSharingFolder()
              }
              .disabled(controller.phase.isRunning)
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 10)

            ShareCardDivider(leadingInset: 14)
            Toggle(isOn: $controller.allowRemoteFolderWrites) {
              ShareToggleLabel(
                systemName: "square.and.arrow.down",
                title: "Allow remote uploads",
                caption: "Allow new folders; completed uploads become visible atomically.",
                isActive: controller.allowRemoteFolderWrites)
            }
            .disabled(controller.phase.isRunning)
            .help("Uploads use a temporary file and become visible only after an atomic finish.")
          }
          ShareCardDivider()

          Toggle(isOn: $controller.browserAccessEnabled) {
            ShareToggleLabel(
              systemName: "globe",
              title: "Browser access",
              caption: "Authenticated web relay via your Crabfleet registry.",
              isActive: controller.browserAccessEnabled)
          }
          .disabled(controller.registryPhase == .notConfigured)
          .help("Publishes an authenticated browser relay while this private share is running.")
          ShareCardDivider()

          Toggle(isOn: $controller.viewOnlyEnabled) {
            ShareToggleLabel(
              systemName: "eye.slash",
              title: "View only",
              caption: "Remote keyboard and pointer input never reaches this Mac.",
              isActive: controller.viewOnlyEnabled)
          }
          .help(
            "Applies immediately and keeps remote keyboard and pointer events from reaching this Mac."
          )
          ShareCardDivider()

          Toggle(isOn: $controller.streamAudioEnabled) {
            ShareToggleLabel(
              systemName: "speaker.wave.2",
              title: "Stream audio",
              caption: "System audio as AAC when the viewer supports it.",
              isActive: controller.streamAudioEnabled)
          }
          .help("Streams system audio as AAC when the connected Crabfleet viewer supports it.")
          ShareCardDivider()

          Toggle(
            isOn: Binding(
              get: { controller.launchAtLoginEnabled },
              set: { controller.setLaunchAtLogin($0) }
            )
          ) {
            ShareToggleLabel(
              systemName: "power",
              title: "Start sharing at login",
              caption: "Adds a login item and starts this share automatically.",
              isActive: controller.launchAtLoginEnabled)
          }
          .help("Adds Crabfleet as a login item and starts this private share automatically.")
        }
      }
    }
  }

  private var connectSection: some View {
    VStack(alignment: .leading, spacing: 8) {
      ShareSectionHeader(title: "Connect from your other Mac")
      ShareCard(tone: .connect) {
        VStack(spacing: 0) {
          ForEach(Array(controller.connectionAddresses.enumerated()), id: \.offset) {
            index, address in
            HStack(spacing: 10) {
              Text("Display \(index + 1) · \(address)")
                .font(.system(size: 12, design: .monospaced))
                .textSelection(.enabled)
              Spacer()
              Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(address, forType: .string)
              } label: {
                Image(systemName: "doc.on.doc")
                  .font(.system(size: 11, weight: .medium))
              }
              .buttonStyle(ShareCapsuleActionButtonStyle(appearance: .icon))
              .accessibilityLabel("Copy address")
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)

            ShareCardDivider(leadingInset: 14)
          }

          HStack(spacing: 10) {
            Text("Password · \(controller.accessCode)")
              .font(.system(size: 12, design: .monospaced))
              .textSelection(.enabled)
            Spacer()
            Button {
              NSPasteboard.general.clearContents()
              NSPasteboard.general.setString(controller.accessCode, forType: .string)
            } label: {
              Image(systemName: "doc.on.doc")
                .font(.system(size: 11, weight: .medium))
            }
            .buttonStyle(ShareCapsuleActionButtonStyle(appearance: .icon))
            .accessibilityLabel("Copy password")

            Button {
              controller.regenerateAccessCode()
            } label: {
              Image(systemName: "arrow.clockwise")
                .font(.system(size: 11, weight: .medium))
            }
            .buttonStyle(ShareCapsuleActionButtonStyle(appearance: .icon))
            .accessibilityLabel("Regenerate password")
            .help("Regenerate password")
          }
          .padding(.horizontal, 14)
          .padding(.vertical, 9)

          Text(
            "Open Crabfleet, choose Quick Connect, paste an address, and enter this password. Existing authenticated viewers stay connected after regeneration."
          )
          .font(.system(size: 10.5, design: .rounded))
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 14)
          .padding(.bottom, 12)
        }
      }
    }
  }

  @ViewBuilder
  private var assurance: some View {
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
  }

  private var footer: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Menu {
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
        } label: {
          HStack(spacing: 4) {
            Text("Privacy Settings")
            Image(systemName: "chevron.down")
              .font(.system(size: 8, weight: .semibold))
          }
        }
        .menuStyle(.button)
        .buttonStyle(ShareCapsuleActionButtonStyle())
        .fixedSize()

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
  }

  private var phaseDetail: String {
    let viewers =
      controller.connectedViewerCount == 1
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

private struct SharePhaseBadge: View {
  let phase: PrivateMacShareController.Phase

  @State private var pulse = false

  private var color: Color {
    switch phase {
    case .starting, .stopping: .orange
    case .sharing, .authorizing, .connected: .mint
    case .failed: .red
    case .idle: .secondary
    }
  }

  private var isPulsing: Bool {
    phase == .starting || phase == .stopping
  }

  var body: some View {
    HStack(spacing: 5) {
      Circle()
        .fill(color)
        .frame(width: 5, height: 5)
        .opacity(isPulsing && pulse ? 0.28 : 1)
      Text(phase.title.uppercased())
        .font(.system(size: 9, weight: .semibold, design: .rounded))
        .tracking(0.5)
    }
    .foregroundStyle(color)
    .padding(.horizontal, 8)
    .padding(.vertical, 5)
    .background(.white.opacity(0.06), in: Capsule())
    .onAppear { updatePulse(isPulsing) }
    .onChange(of: isPulsing) { _, active in updatePulse(active) }
  }

  private func updatePulse(_ active: Bool) {
    if active {
      pulse = false
      withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) {
        pulse = true
      }
    } else {
      withAnimation(.easeOut(duration: 0.15)) { pulse = false }
    }
  }
}

private struct ShareStatusRow: View {
  let title: String
  let detail: String
  let isReady: Bool
  var isPulsing = false
  var truncationMode: Text.TruncationMode = .tail
  var actionTitle: String?
  var action: () -> Void = {}

  var body: some View {
    HStack(spacing: 10) {
      ShareStatusBeacon(isReady: isReady, isPulsing: isPulsing)

      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.system(size: 13, weight: .semibold, design: .rounded))
        Text(detail)
          .font(.system(size: 11, design: .rounded))
          .foregroundStyle(.secondary)
          .lineLimit(2)
          .truncationMode(truncationMode)
      }

      Spacer(minLength: 10)

      if let actionTitle {
        Button(actionTitle, action: action)
          .buttonStyle(ShareCapsuleActionButtonStyle())
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
  }
}
