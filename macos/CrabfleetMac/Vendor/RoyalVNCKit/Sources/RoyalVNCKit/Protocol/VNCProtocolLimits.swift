enum VNCProtocolLimits {
  static let maximumStringBytes = 1 * 1_024 * 1_024
  static let maximumClipboardBytes = 1 * 1_024 * 1_024
  static let maximumCompressedFrameBytes = 256 * 1_024 * 1_024
  static let maximumFramebufferBytes = 512 * 1_024 * 1_024
  static let maximumFramebufferDimension = 16_384
  static let maximumCursorDimension = 1_024
  static let maximumNetworkReadBytes = maximumFramebufferBytes
  static let maximumSubrectangles: UInt32 = 65_536
}
