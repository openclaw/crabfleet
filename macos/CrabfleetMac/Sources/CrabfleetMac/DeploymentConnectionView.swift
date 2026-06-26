import SwiftUI

struct DeploymentConnectionView: View {
  @ObservedObject var store: FleetStore
  let useLocalConnections: () -> Void

  @State private var deploymentURL = ""
  @FocusState private var urlFocused: Bool

  var body: some View {
    ZStack {
      ConnectionBackground()

      VStack(spacing: 22) {
        ZStack {
          RoundedRectangle(cornerRadius: 22, style: .continuous)
            .fill(.mint.opacity(0.1))
            .stroke(.mint.opacity(0.22), lineWidth: 1)
          Image(systemName: "rectangle.3.group")
            .font(.system(size: 34, weight: .light))
            .foregroundStyle(.mint)
        }
        .frame(width: 86, height: 86)

        VStack(spacing: 6) {
          Text("Connect to Crabfleet")
            .font(.system(size: 27, weight: .semibold, design: .rounded))
          Text("Sign in through your deployment to load its real fleet.")
            .font(.callout)
            .foregroundStyle(.secondary)
        }

        VStack(alignment: .leading, spacing: 14) {
          switch store.connectionPhase {
          case .restoring:
            ProgressPanel(
              title: "Restoring session",
              detail: "Checking the saved credential with \(hostLabel)."
            )
          case .requestingAuthorization:
            ProgressPanel(
              title: "Starting secure sign-in",
              detail: "Asking \(hostLabel) for a browser authorization."
            )
          case .waitingForApproval:
            browserApproval
          case .disconnecting:
            ProgressPanel(
              title: "Disconnecting",
              detail: "Revoking this Mac's API credential."
            )
          case .disconnected, .failed:
            connectionForm
          case .connected:
            EmptyView()
          }
        }
        .padding(22)
        .frame(width: 520)
        .background(.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 14))
        .overlay {
          RoundedRectangle(cornerRadius: 14)
            .stroke(.white.opacity(0.09), lineWidth: 1)
        }
      }
      .padding(40)
    }
    .onAppear {
      if deploymentURL.isEmpty {
        deploymentURL = store.suggestedDeploymentURL
      }
      if store.connectionPhase == .disconnected {
        urlFocused = true
      }
    }
    .onChange(of: store.suggestedDeploymentURL) { _, value in
      if deploymentURL.isEmpty { deploymentURL = value }
    }
  }

  private var connectionForm: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Deployment URL")
        .font(.system(size: 11, weight: .semibold, design: .rounded))
        .foregroundStyle(.secondary)
      HStack(spacing: 9) {
        Image(systemName: "network")
          .foregroundStyle(.tertiary)
        TextField("https://crabfleet.example.com", text: $deploymentURL)
          .textFieldStyle(.plain)
          .focused($urlFocused)
          .onSubmit(connect)
      }
      .padding(.horizontal, 12)
      .frame(height: 40)
      .background(.black.opacity(0.24), in: RoundedRectangle(cornerRadius: 9))
      .overlay {
        RoundedRectangle(cornerRadius: 9)
          .stroke(urlFocused ? Color.mint.opacity(0.65) : .white.opacity(0.08), lineWidth: 1)
      }

      if let error = store.connectionError {
        Label(error, systemImage: "exclamationmark.triangle.fill")
          .font(.caption)
          .foregroundStyle(.orange)
          .fixedSize(horizontal: false, vertical: true)
      } else {
        Label(
          "The API token is stored in this Mac's Keychain. Browser cookies and passwords are not imported.",
          systemImage: "key.fill"
        )
        .font(.caption)
        .foregroundStyle(.secondary)
      }

      HStack {
        if store.canRetrySavedSession {
          Button("Retry Saved Session") {
            store.retrySavedSession()
          }
          .buttonStyle(.bordered)
        }
        Spacer()
        Button("Connect in Browser", action: connect)
          .buttonStyle(.borderedProminent)
          .keyboardShortcut(.defaultAction)
          .disabled(deploymentURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }

      HStack(spacing: 12) {
        Rectangle()
          .fill(.white.opacity(0.08))
          .frame(height: 1)
        Text("OR")
          .font(.system(size: 9, weight: .semibold, design: .monospaced))
          .foregroundStyle(.tertiary)
        Rectangle()
          .fill(.white.opacity(0.08))
          .frame(height: 1)
      }

      Button("Use Local VNC Only", systemImage: "display") {
        useLocalConnections()
      }
      .buttonStyle(.bordered)
      .frame(maxWidth: .infinity, alignment: .trailing)
    }
  }

  private var browserApproval: some View {
    VStack(alignment: .leading, spacing: 15) {
      HStack(spacing: 12) {
        ProgressView().controlSize(.small)
        VStack(alignment: .leading, spacing: 3) {
          Text("Finish signing in in your browser")
            .font(.system(size: 14, weight: .semibold, design: .rounded))
          Text("This window will continue automatically after approval.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }

      if let url = store.verificationURL {
        Text(url.absoluteString)
          .font(.system(size: 10, design: .monospaced))
          .foregroundStyle(.tertiary)
          .lineLimit(2)
          .textSelection(.enabled)
      }

      if let error = store.connectionError {
        Label(error, systemImage: "exclamationmark.triangle.fill")
          .font(.caption)
          .foregroundStyle(.orange)
      }

      HStack {
        Button("Cancel") { store.cancelAuthorization() }
          .keyboardShortcut(.cancelAction)
        Spacer()
        Button("Open Browser Again", systemImage: "arrow.up.forward.app") {
          store.openVerificationPage()
        }
        .buttonStyle(.borderedProminent)
      }
    }
  }

  private var hostLabel: String {
    (try? DeploymentOrigin(deploymentURL).url.host) ?? "the deployment"
  }

  private func connect() {
    store.connect(to: deploymentURL)
  }
}

private struct ProgressPanel: View {
  let title: String
  let detail: String

  var body: some View {
    HStack(spacing: 13) {
      ProgressView().controlSize(.small)
      VStack(alignment: .leading, spacing: 3) {
        Text(title)
          .font(.system(size: 14, weight: .semibold, design: .rounded))
        Text(detail)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct ConnectionBackground: View {
  var body: some View {
    ZStack {
      LinearGradient(
        colors: [
          Color(red: 0.035, green: 0.041, blue: 0.045),
          Color(red: 0.012, green: 0.017, blue: 0.02),
        ],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
      )
      RadialGradient(
        colors: [.mint.opacity(0.09), .clear],
        center: .center,
        startRadius: 20,
        endRadius: 420
      )
    }
    .ignoresSafeArea()
  }
}
