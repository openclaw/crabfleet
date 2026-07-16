import AVFoundation
import CoreMedia
import Testing

@testable import CrabfleetMac

struct AudioEncoderTests {
  @Test
  func emitsAACConfigurationBeforeEncodedPackets() async throws {
    let format = try #require(
      AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2))
    let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1_024))
    buffer.frameLength = 1_024
    if let channels = buffer.floatChannelData {
      for channel in 0..<Int(format.channelCount) {
        channels[channel].initialize(repeating: 0, count: 1_024)
      }
    }

    let encoder = MacAudioEncoder()
    var events = encoder.events.makeAsyncIterator()
    encoder.submit(buffer, presentationTime: CMTime(value: 1, timescale: 1))

    let first = await events.next()
    guard case .config(let configuration) = first else {
      Issue.record("encoder did not emit configuration first")
      return
    }
    #expect(configuration.channels == 2)
    #expect(configuration.sampleRate == 48_000)

    encoder.submit(buffer, presentationTime: CMTime(value: 1_024, timescale: 48_000))
    var packet: EncodedAudioPacket?
    var latestConfiguration = configuration
    for _ in 0..<3 {
      switch await events.next() {
      case .packet(let value):
        packet = value
      case .config(let value):
        latestConfiguration = value
        continue
      case .failed(let message):
        Issue.record("encoder failed: \(message)")
        return
      default:
        continue
      }
      break
    }
    let encodedPacket = try #require(packet)
    #expect(!encodedPacket.data.isEmpty)
    #expect(encodedPacket.configuration == latestConfiguration)
    encoder.invalidate()
  }
}
