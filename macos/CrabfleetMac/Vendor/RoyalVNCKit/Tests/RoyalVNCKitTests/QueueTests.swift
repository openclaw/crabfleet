import Foundation
import Testing

@testable import RoyalVNCKit

struct QueueTests {
  @Test
  func drainingReleasesPayloadsBeforeCompactionThreshold() throws {
    let queue = Queue<Payload>()
    var payload: Payload? = Payload()
    weak var retainedPayload = payload
    queue.enqueue(try #require(payload))
    payload = nil

    #expect(retainedPayload != nil)
    _ = queue.dequeue()
    #expect(retainedPayload == nil)
    #expect(queue.isEmpty)

    withExtendedLifetime(queue) {}
  }

  @Test
  func coalescingAfterDrainDoesNotReplaceConsumedElements() {
    let queue = Queue<Int>()
    queue.enqueue(1)
    #expect(queue.dequeue() == 1)
    queue.enqueue(2, coalescingLastWhere: { _ in true })
    queue.enqueue(3, coalescingLastWhere: { _ in true })
    #expect(queue.dequeue() == 3)
    #expect(queue.dequeue() == nil)
  }

  @Test
  func preservesOrderAcrossCompactionAndReuse() {
    let queue = Queue<Int>()
    for value in 0..<130 { queue.enqueue(value) }
    for value in 0..<100 { #expect(queue.dequeue() == value) }
    for value in 130..<160 { queue.enqueue(value) }
    for value in 100..<160 { #expect(queue.dequeue() == value) }
    #expect(queue.isEmpty)

    queue.enqueue(160)
    #expect(queue.dequeue() == 160)
    #expect(queue.dequeue() == nil)
  }

  @Test
  func finishDiscardsBothOrdinaryAndCoalescingEnqueues() async {
    let queue = Queue<Int>()
    queue.enqueue(1)
    queue.finish()
    queue.enqueue(2)
    queue.enqueue(3, coalescingLastWhere: { _ in true })
    #expect(await queue.next() == nil)
    #expect(queue.isEmpty)
  }
}

private final class Payload {}
