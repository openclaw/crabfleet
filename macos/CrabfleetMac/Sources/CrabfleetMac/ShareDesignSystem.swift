import AppKit
import SwiftUI

struct ShareCard<Content: View>: View {
  enum Tone {
    case standard
    case connect
  }

  let tone: Tone
  @ViewBuilder let content: Content

  init(tone: Tone = .standard, @ViewBuilder content: () -> Content) {
    self.tone = tone
    self.content = content()
  }

  var body: some View {
    content
      .background(fill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .strokeBorder(stroke, lineWidth: 1)
      }
  }

  private var fill: Color {
    tone == .connect ? .mint.opacity(0.06) : .white.opacity(0.045)
  }

  private var stroke: Color {
    tone == .connect ? .mint.opacity(0.18) : .white.opacity(0.07)
  }
}

struct ShareSectionHeader: View {
  let title: String

  var body: some View {
    Text(title.uppercased())
      .font(.system(size: 9, weight: .bold, design: .monospaced))
      .tracking(0.8)
      .foregroundStyle(.secondary)
  }
}

struct ShareCardDivider: View {
  var leadingInset: CGFloat = 44

  var body: some View {
    Rectangle()
      .fill(.white.opacity(0.05))
      .frame(height: 1)
      .padding(.leading, leadingInset)
  }
}

struct ShareStatusBeacon: View {
  let isReady: Bool
  var isPulsing = false

  @State private var pulse = false

  private var color: Color { isReady ? .mint : .orange }

  var body: some View {
    ZStack {
      Circle()
        .fill(color.opacity(0.16))
        .frame(width: 16, height: 16)
        .opacity(isPulsing && pulse ? 0.28 : 1)
      Circle()
        .fill(color)
        .frame(width: 6, height: 6)
    }
    .frame(width: 18, height: 18)
    .onAppear { updatePulse(isPulsing) }
    .onChange(of: isPulsing) { _, active in updatePulse(active) }
    .accessibilityHidden(true)
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

struct ShareToggleStyle: ToggleStyle {
  func makeBody(configuration: Configuration) -> some View {
    ShareToggleBody(configuration: configuration)
  }
}

private struct ShareToggleBody: View {
  let configuration: ShareToggleStyle.Configuration

  @Environment(\.isEnabled) private var isEnabled
  @State private var isHovering = false

  var body: some View {
    Button {
      configuration.isOn.toggle()
    } label: {
      HStack(spacing: 12) {
        configuration.label
        Spacer(minLength: 12)
        ZStack {
          Capsule()
            .fill(trackFill)
          Capsule()
            .strokeBorder(
              .white.opacity(configuration.isOn ? 0 : 0.14),
              lineWidth: 1)
          if isHovering && isEnabled {
            Capsule().fill(.white.opacity(0.05))
          }
          Circle()
            .fill(.white)
            .frame(width: 16, height: 16)
            .shadow(color: .black.opacity(0.35), radius: 2, y: 1)
            .offset(x: configuration.isOn ? 7 : -7)
        }
        .frame(width: 34, height: 20)
        .animation(
          .spring(response: 0.25, dampingFraction: 0.8),
          value: configuration.isOn
        )
        .animation(.easeOut(duration: 0.12), value: isHovering)
      }
      .contentShape(Rectangle())
      .padding(.horizontal, 14)
      .padding(.vertical, 9)
    }
    .buttonStyle(.plain)
    .opacity(isEnabled ? 1 : 0.45)
    .onHover { hovering in
      isHovering = isEnabled && hovering
    }
    .accessibilityValue(configuration.isOn ? "On" : "Off")
  }

  private var trackFill: AnyShapeStyle {
    if configuration.isOn {
      return AnyShapeStyle(
        LinearGradient(
          colors: [.mint, .mint.opacity(0.7)],
          startPoint: .leading,
          endPoint: .trailing))
    }
    return AnyShapeStyle(Color.white.opacity(0.09))
  }
}

struct ShareSegmentedControl<Option: Hashable>: View {
  @Binding var selection: Option
  let options: [Option]
  let title: (Option) -> String

  @Namespace private var selectedSegment

  init(
    selection: Binding<Option>,
    options: [Option],
    title: @escaping (Option) -> String
  ) {
    _selection = selection
    self.options = options
    self.title = title
  }

  var body: some View {
    HStack(spacing: 2) {
      ForEach(options, id: \.self) { option in
        Button {
          withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
            selection = option
          }
        } label: {
          Text(title(option))
            .font(
              .system(
                size: 11.5,
                weight: option == selection ? .semibold : .medium,
                design: .rounded)
            )
            .foregroundStyle(option == selection ? Color.mint : Color.secondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background {
              if option == selection {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                  .fill(.mint.opacity(0.18))
                  .overlay {
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                      .strokeBorder(.mint.opacity(0.4), lineWidth: 1)
                  }
                  .matchedGeometryEffect(id: "selected", in: selectedSegment)
              }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(option == selection ? .isSelected : .isButton)
      }
    }
    .padding(2)
    .frame(height: 30)
    .background(.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 9, style: .continuous)
        .strokeBorder(.white.opacity(0.07), lineWidth: 1)
    }
  }
}

struct ShareCapsuleActionButtonStyle: ButtonStyle {
  enum Appearance {
    case action
    case icon
  }

  var appearance: Appearance = .action

  func makeBody(configuration: Configuration) -> some View {
    ShareCapsuleActionButton(configuration: configuration, appearance: appearance)
  }
}

private struct ShareCapsuleActionButton: View {
  let configuration: ShareCapsuleActionButtonStyle.Configuration
  let appearance: ShareCapsuleActionButtonStyle.Appearance

  @Environment(\.isEnabled) private var isEnabled
  @State private var isHovering = false

  var body: some View {
    configuration.label
      .font(.system(size: 11, weight: .semibold, design: .rounded))
      .foregroundStyle(appearance == .action ? Color.mint : Color.secondary)
      .frame(
        width: appearance == .icon ? 26 : nil,
        height: appearance == .icon ? 26 : nil
      )
      .padding(.horizontal, appearance == .action ? 10 : 0)
      .padding(.vertical, appearance == .action ? 5 : 0)
      .background {
        if appearance == .icon {
          Circle().fill(.white.opacity(isHovering && isEnabled ? 0.15 : 0.07))
        } else {
          Capsule().fill(.mint.opacity(isHovering && isEnabled ? 0.24 : 0.14))
        }
      }
      .scaleEffect(configuration.isPressed ? 0.97 : 1)
      .opacity(isEnabled ? 1 : 0.45)
      .animation(.easeOut(duration: 0.12), value: isHovering)
      .animation(.easeOut(duration: 0.08), value: configuration.isPressed)
      .onHover { hovering in
        isHovering = isEnabled && hovering
      }
  }
}

struct ShareIconTile: View {
  let systemName: String
  var fallbackSystemName: String?
  let isActive: Bool

  private var resolvedSystemName: String {
    if NSImage(systemSymbolName: systemName, accessibilityDescription: nil) != nil {
      return systemName
    }
    return fallbackSystemName ?? systemName
  }

  var body: some View {
    Image(systemName: resolvedSystemName)
      .font(.system(size: 12, weight: .medium))
      .foregroundStyle(isActive ? Color.mint : Color.secondary)
      .frame(width: 26, height: 26)
      .background(
        isActive ? Color.mint.opacity(0.15) : Color.white.opacity(0.06),
        in: RoundedRectangle(cornerRadius: 7, style: .continuous)
      )
      .animation(.easeOut(duration: 0.18), value: isActive)
  }
}
