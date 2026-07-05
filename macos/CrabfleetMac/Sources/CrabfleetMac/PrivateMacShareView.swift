import AppKit
import SwiftUI

struct PrivateMacShareSheet: View {
  @ObservedObject var controller: PrivateMacShareController
  @Environment(\.dismiss) private var dismiss

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
          title: "Screen Recording",
          detail: controller.screenRecordingGranted ? "Allowed" : "Permission required",
          isReady: controller.screenRecordingGranted,
          actionTitle: controller.screenRecordingGranted ? nil : "Allow"
        ) {
          Task { await controller.requestScreenRecordingPermission() }
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

      VStack(alignment: .leading, spacing: 10) {
        if controller.availableDisplays.count > 1 {
          Picker("Shared display", selection: $controller.selectedDisplayID) {
            ForEach(controller.availableDisplays) { display in
              Text(display.detail).tag(display.id)
            }
          }
          .disabled(controller.phase.isRunning)
          .help(
            controller.phase.isRunning
              ? "Stop sharing to switch displays."
              : "Which display the connected peer sees."
          )
        }

        Toggle(
          "Sync clipboard with the connected device",
          isOn: $controller.clipboardSyncEnabled
        )
        .disabled(controller.phase.isRunning)
        .help("Text copied on either Mac is available on the other while connected.")

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

      if controller.phase.isRunning, let address = controller.connectionAddress {
        VStack(alignment: .leading, spacing: 10) {
          Text("CONNECT FROM YOUR OTHER MAC")
            .font(.system(size: 9, weight: .bold, design: .monospaced))
            .tracking(0.8)
            .foregroundStyle(.secondary)
          HStack(spacing: 10) {
            Text(address)
              .font(.system(.body, design: .monospaced))
              .textSelection(.enabled)
            Spacer()
            Button("Copy", systemImage: "doc.on.doc") {
              NSPasteboard.general.clearContents()
              NSPasteboard.general.setString(address, forType: .string)
            }
          }
          Text(
            "Open Crabfleet, choose Quick Connect, paste this address, and leave the password blank."
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
          Button("Accessibility") {
            controller.openPrivacySettings(.accessibility)
          }
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
  }

  private var phaseDetail: String {
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
