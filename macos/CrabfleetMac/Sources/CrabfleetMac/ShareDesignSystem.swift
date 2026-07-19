import AppKit
import SwiftUI

private struct SheetContentHeightKey: PreferenceKey {
  static var defaultValue: CGFloat = 0

  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    value = max(value, nextValue())
  }
}

struct ShareSheetContainer<Content: View>: View {
  let width: CGFloat
  @ViewBuilder let content: Content

  @State private var contentHeight: CGFloat = 0

  init(width: CGFloat = 600, @ViewBuilder content: () -> Content) {
    self.width = width
    self.content = content()
  }

  var body: some View {
    ScrollView {
      content
        .padding(24)
        .background {
          GeometryReader { proxy in
            Color.clear.preference(key: SheetContentHeightKey.self, value: proxy.size.height)
          }
        }
    }
    .scrollBounceBehavior(.basedOnSize)
    .onPreferenceChange(SheetContentHeightKey.self) { contentHeight = $0 }
    .frame(width: width)
    .frame(height: contentHeight > 0 ? min(contentHeight, maxSheetHeight) : nil)
    .background {
      LinearGradient(
        colors: [
          Color(red: 0.035, green: 0.041, blue: 0.045),
          Color(red: 0.018, green: 0.023, blue: 0.026),
        ],
        startPoint: .topLeading,
        endPoint: .bottomTrailing)
    }
    .preferredColorScheme(.dark)
    .tint(.mint)
    .toggleStyle(ShareToggleStyle())
  }

  // Sheets cannot be moved on screen, so cap height below common laptop displays
  // and let the content scroll instead of clipping the footer controls.
  private var maxSheetHeight: CGFloat {
    max(480, (NSScreen.main?.visibleFrame.height ?? 900) - 120)
  }
}

struct ShareSheetHeader<Trailing: View>: View {
  let systemImage: String
  let title: String
  let subtitle: String
  @ViewBuilder let trailing: Trailing

  init(
    systemImage: String,
    title: String,
    subtitle: String,
    @ViewBuilder trailing: () -> Trailing
  ) {
    self.systemImage = systemImage
    self.title = title
    self.subtitle = subtitle
    self.trailing = trailing()
  }

  var body: some View {
    HStack(spacing: 12) {
      ZStack {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(
            LinearGradient(
              colors: [.mint.opacity(0.28), .mint.opacity(0.08)],
              startPoint: .topLeading,
              endPoint: .bottomTrailing))
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .strokeBorder(.mint.opacity(0.35), lineWidth: 1)
        Image(systemName: systemImage)
          .font(.system(size: 19, weight: .medium))
          .foregroundStyle(.mint)
      }
      .frame(width: 44, height: 44)

      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.title3.weight(.semibold))
        Text(subtitle)
          .font(.system(size: 11.5, design: .rounded))
          .foregroundStyle(.secondary)
      }

      Spacer()
      trailing
    }
  }
}

extension ShareSheetHeader where Trailing == EmptyView {
  init(systemImage: String, title: String, subtitle: String) {
    self.init(systemImage: systemImage, title: title, subtitle: subtitle) {
      EmptyView()
    }
  }
}

struct ShareFieldRow<Field: View>: View {
  let title: String
  @ViewBuilder let field: Field

  init(title: String, @ViewBuilder field: () -> Field) {
    self.title = title
    self.field = field()
  }

  var body: some View {
    HStack(spacing: 12) {
      Text(title)
        .font(.system(size: 12, weight: .medium, design: .rounded))
        .foregroundStyle(.secondary)
        .frame(width: 130, alignment: .leading)
        .accessibilityHidden(true)
      field
        .textFieldStyle(.plain)
        .font(.system(size: 12.5, design: .rounded))
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityLabel(title)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 9)
  }
}

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
    .accessibilityElement(children: .combine)
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

struct ShareToggleLabel: View {
  let systemName: String
  var fallbackSystemName: String?
  let title: String
  var caption: String?
  let isActive: Bool

  var body: some View {
    HStack(spacing: 10) {
      ShareIconTile(
        systemName: systemName,
        fallbackSystemName: fallbackSystemName,
        isActive: isActive)
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.system(size: 12.5, weight: .medium, design: .rounded))
          .foregroundStyle(.primary)
          .lineLimit(1)
        if let caption {
          Text(caption)
            .font(.system(size: 10.5, design: .rounded))
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }
    }
  }
}
