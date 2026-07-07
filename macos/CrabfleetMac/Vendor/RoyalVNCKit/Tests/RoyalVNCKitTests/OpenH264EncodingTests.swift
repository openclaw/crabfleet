import Foundation
import Testing

@testable import RoyalVNCKit

struct OpenH264EncodingTests {
	@Test
	func splitsThreeAndFourByteAnnexBStartCodes() {
		let data = Data([
			0, 0, 0, 1, 0x67, 0x64,
			0, 0, 1, 0x68, 0xEE,
			0, 0, 0, 1, 0x65, 0x01,
		])
		let units = OpenH264AnnexB.nalUnits(from: data)

		#expect(units == [Data([0x67, 0x64]), Data([0x68, 0xEE]), Data([0x65, 0x01])])
	}

	@Test
	func extractsLatestParameterSets() {
		let units = [
			Data([0x67, 1]), Data([0x68, 2]), Data([0x41, 3]),
			Data([0x67, 4]), Data([0x68, 5]),
		]
		let sets = OpenH264AnnexB.parameterSets(in: units)

		#expect(sets.sps == Data([0x67, 4]))
		#expect(sets.pps == Data([0x68, 5]))
	}

	@Test
	func boundsRetainedParameterSets() {
		let maximum = OpenH264AnnexB.maximumParameterSetBytes
		#expect(OpenH264AnnexB.parameterSetsFitLimit(
			sps: Data(repeating: 0, count: maximum - 1),
			pps: Data([0])))
		#expect(!OpenH264AnnexB.parameterSetsFitLimit(
			sps: Data(repeating: 0, count: maximum),
			pps: Data([0])))
	}

	@Test
	func rejectsExcessiveNALUnitCounts() {
		var data = Data()
		for _ in 0...OpenH264AnnexB.maximumNALUnitCount {
			data.append(contentsOf: [0, 0, 1, 0x09])
		}
		#expect(OpenH264AnnexB.nalUnits(from: data).isEmpty)
	}

	@Test
	func groupsGluedFramesIntoAccessUnits() {
		// SPS + PPS + IDR, then two inter frames glued into one rectangle.
		let sps = Data([0x67, 0x64])
		let pps = Data([0x68, 0xEE])
		let idr = Data([0x65, 0x88])
		let interOne = Data([0x41, 0x9A])
		let interTwo = Data([0x41, 0x9B])
		let units = OpenH264AnnexB.accessUnits(
			from: [sps, pps, idr, interOne, interTwo])

		#expect(units == [[sps, pps, idr], [interOne], [interTwo]])
	}

	@Test
	func keepsContinuationSlicesInTheSameAccessUnit() {
		// A second slice of the same frame has first_mb_in_slice > 0, which
		// encodes with a leading '0' bit.
		let firstSlice = Data([0x65, 0x88])
		let continuationSlice = Data([0x65, 0x08])
		let nextFrame = Data([0x41, 0x9A])
		let units = OpenH264AnnexB.accessUnits(
			from: [firstSlice, continuationSlice, nextFrame])

		#expect(units == [[firstSlice, continuationSlice], [nextFrame]])
	}

	@Test
	func startsANewAccessUnitForParameterSetsAfterSlices() {
		let idr = Data([0x65, 0x88])
		let sps = Data([0x67, 0x64])
		let pps = Data([0x68, 0xEE])
		let nextIDR = Data([0x65, 0x89])
		let units = OpenH264AnnexB.accessUnits(from: [idr, sps, pps, nextIDR])

		#expect(units == [[idr], [sps, pps, nextIDR]])
	}

	@Test
	func waitsForIDRAfterResetOrDecodeFailure() {
		let inter = [Data([0x41, 1])]
		let idr = [Data([0x65, 1])]
		var gate = OpenH264DecodeGate()

		var decision = gate.shouldDecode(inter)
		#expect(!decision)
		decision = gate.shouldDecode(idr)
		#expect(decision)
		decision = gate.shouldDecode(inter)
		#expect(decision)
		gate.reset()
		decision = gate.shouldDecode(inter)
		#expect(!decision)
		decision = gate.shouldDecode(idr)
		#expect(decision)
		gate.decodeFailed()
		decision = gate.shouldDecode(inter)
		#expect(!decision)
	}
}
