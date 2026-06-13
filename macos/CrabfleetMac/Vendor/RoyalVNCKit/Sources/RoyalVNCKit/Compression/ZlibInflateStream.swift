#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import Z

enum ZlibError: Error {
	case unknown(status: Int32, message: String?)

	case streamEnd(message: String?)
	case needDict(message: String?)
	case errNo(message: String?)
	case bufferError(message: String?)
	case streamError(message: String?)
	case memoryError(message: String?)
	case dataError(message: String?)
	case versionError(message: String?)
}

enum ZlibFlush: Int32 {
	case noFlush = 0 // Z_NO_FLUSH
	case partialFlush = 1 // Z_PARTIAL_FLUSH
	case syncFlush = 2 // Z_SYNC_FLUSH
	case fullFlush = 3 // Z_FULL_FLUSH
	case finish = 4 // Z_FINISH
	case block = 5 // Z_BLOCK
	case trees = 6 // Z_TREES
}

final class ZlibInflateStream {
	private let streamPtr: UnsafeMutablePointer<z_stream>

	init() throws {
		let streamPtr = UnsafeMutablePointer<z_stream>.allocate(capacity: 1)

		streamPtr.pointee.total_out = 0
		streamPtr.pointee.zalloc = nil
		streamPtr.pointee.zfree = nil

		var version = ZLIB_VERSION
        var status = Z_VERSION_ERROR

        withUnsafeMutablePointer(to: &version) { versionPtr in
            status = inflateInit_(streamPtr, versionPtr, .init(MemoryLayout<z_stream>.size))
        }

		guard ZlibError.isSuccess(status) else {
			throw Self.error(streamPtr: streamPtr,
							 status: status)
		}

		self.streamPtr = streamPtr
	}

	deinit {
		let streamPtr = self.streamPtr

		streamPtr.deallocate()
	}
}

extension ZlibInflateStream {
	/// remaining free space at nextOut
	var availOut: UInt32 {
		get {
			streamPtr.pointee.avail_out
		}
		set {
			streamPtr.pointee.avail_out = newValue
		}
	}

	/// total number of bytes output so far
	var totalOut: UInt {
		get {
			.init(streamPtr.pointee.total_out)
		}
		set {
			streamPtr.pointee.total_out = .init(newValue)
		}
	}

	/// number of bytes available at nextIn
	var availIn: UInt32 {
		get {
			streamPtr.pointee.avail_in
		}
		set {
			streamPtr.pointee.avail_in = newValue
		}
	}

	/// total number of input bytes read so far
	var totalIn: UInt {
		get {
			.init(streamPtr.pointee.total_in)
		}
		set {
			streamPtr.pointee.total_in = .init(newValue)
		}
	}

	/// next input byte
	var nextIn: UnsafeMutablePointer<UInt8>? {
		get {
			streamPtr.pointee.next_in
		}
		set {
			streamPtr.pointee.next_in = newValue
		}
	}

	/// next output byte will go here
	var nextOut: UnsafeMutablePointer<UInt8>? {
		get {
			streamPtr.pointee.next_out
		}
		set {
			streamPtr.pointee.next_out = newValue
		}
	}

	/// best guess about the data type: binary or text for deflate, or the decoding state for inflate
	var dataType: Int32 {
		get {
			streamPtr.pointee.data_type
		}
		set {
			streamPtr.pointee.data_type = newValue
		}
	}

	/// last error message, nil if no error
	var errorMessage: String? {
		Self.errorMessage(streamPtr: streamPtr)
	}

	/// Adler-32 or CRC-32 value of the uncompressed data
	var adler: UInt {
		get {
			.init(streamPtr.pointee.adler)
		}
		set {
			streamPtr.pointee.adler = .init(newValue)
		}
	}
}

extension ZlibInflateStream {
	/// All dynamically allocated data structures for this stream are freed.
	/// This function discards any unprocessed input and does not flush any pending output.
	/// inflateEnd returns Z_OK if success, or Z_STREAM_ERROR if the stream state was inconsistent.
	func inflateEnd() throws {
		let streamPtr = self.streamPtr

		let status = Z.inflateEnd(streamPtr)

		guard ZlibError.isSuccess(status) else {
			throw Self.error(streamPtr: streamPtr,
							 status: status)
		}
	}

	/// Resets the inflate state without freeing or reallocating internal buffers.
	/// Any unprocessed input and pending output are discarded.
	func inflateReset() throws {
		let streamPtr = self.streamPtr

		let status = Z.inflateReset(streamPtr)

		guard ZlibError.isSuccess(status) else {
			throw Self.error(streamPtr: streamPtr,
							 status: status)
		}
	}

	/*
		inflate decompresses as much data as possible, and stops when the input
	  buffer becomes empty or the output buffer becomes full.  It may introduce
	  some output latency (reading input without producing any output) except when
	  forced to flush.

	  The detailed semantics are as follows.  inflate performs one or both of the
	  following actions:

	  - Decompress more input starting at next_in and update next_in and avail_in
		accordingly.  If not all input can be processed (because there is not
		enough room in the output buffer), then next_in and avail_in are updated
		accordingly, and processing will resume at this point for the next call of
		inflate().

	  - Generate more output starting at next_out and update next_out and avail_out
		accordingly.  inflate() provides as much output as possible, until there is
		no more input data or no more space in the output buffer (see below about
		the flush parameter).

		Before the call of inflate(), the application should ensure that at least
	  one of the actions is possible, by providing more input and/or consuming more
	  output, and updating the next_* and avail_* values accordingly.  If the
	  caller of inflate() does not provide both available input and available
	  output space, it is possible that there will be no progress made.  The
	  application can consume the uncompressed output when it wants, for example
	  when the output buffer is full (avail_out == 0), or after each call of
	  inflate().  If inflate returns Z_OK and with zero avail_out, it must be
	  called again after making room in the output buffer because there might be
	  more output pending.

		The flush parameter of inflate() can be Z_NO_FLUSH, Z_SYNC_FLUSH, Z_FINISH,
	  Z_BLOCK, or Z_TREES.  Z_SYNC_FLUSH requests that inflate() flush as much
	  output as possible to the output buffer.  Z_BLOCK requests that inflate()
	  stop if and when it gets to the next deflate block boundary.  When decoding
	  the zlib or gzip format, this will cause inflate() to return immediately
	  after the header and before the first block.  When doing a raw inflate,
	  inflate() will go ahead and process the first block, and will return when it
	  gets to the end of that block, or when it runs out of data.

		The Z_BLOCK option assists in appending to or combining deflate streams.
	  To assist in this, on return inflate() always sets strm->data_type to the
	  number of unused bits in the last byte taken from strm->next_in, plus 64 if
	  inflate() is currently decoding the last block in the deflate stream, plus
	  128 if inflate() returned immediately after decoding an end-of-block code or
	  decoding the complete header up to just before the first byte of the deflate
	  stream.  The end-of-block will not be indicated until all of the uncompressed
	  data from that block has been written to strm->next_out.  The number of
	  unused bits may in general be greater than seven, except when bit 7 of
	  data_type is set, in which case the number of unused bits will be less than
	  eight.  data_type is set as noted here every time inflate() returns for all
	  flush options, and so can be used to determine the amount of currently
	  consumed input in bits.

		The Z_TREES option behaves as Z_BLOCK does, but it also returns when the
	  end of each deflate block header is reached, before any actual data in that
	  block is decoded.  This allows the caller to determine the length of the
	  deflate block header for later use in random access within a deflate block.
	  256 is added to the value of strm->data_type when inflate() returns
	  immediately after reaching the end of the deflate block header.

		inflate() should normally be called until it returns Z_STREAM_END or an
	  error.  However if all decompression is to be performed in a single step (a
	  single call of inflate), the parameter flush should be set to Z_FINISH.  In
	  this case all pending input is processed and all pending output is flushed;
	  avail_out must be large enough to hold all of the uncompressed data for the
	  operation to complete.  (The size of the uncompressed data may have been
	  saved by the compressor for this purpose.)  The use of Z_FINISH is not
	  required to perform an inflation in one step.  However it may be used to
	  inform inflate that a faster approach can be used for the single inflate()
	  call.  Z_FINISH also informs inflate to not maintain a sliding window if the
	  stream completes, which reduces inflate's memory footprint.  If the stream
	  does not complete, either because not all of the stream is provided or not
	  enough output space is provided, then a sliding window will be allocated and
	  inflate() can be called again to continue the operation as if Z_NO_FLUSH had
	  been used.

		 In this implementation, inflate() always flushes as much output as
	  possible to the output buffer, and always uses the faster approach on the
	  first call.  So the effects of the flush parameter in this implementation are
	  on the return value of inflate() as noted below, when inflate() returns early
	  when Z_BLOCK or Z_TREES is used, and when inflate() avoids the allocation of
	  memory for a sliding window when Z_FINISH is used.

		 If a preset dictionary is needed after this call (see inflateSetDictionary
	  below), inflate sets strm->adler to the Adler-32 checksum of the dictionary
	  chosen by the compressor and returns Z_NEED_DICT; otherwise it sets
	  strm->adler to the Adler-32 checksum of all output produced so far (that is,
	  total_out bytes) and returns Z_OK, Z_STREAM_END or an error code as described
	  below.  At the end of the stream, inflate() checks that its computed Adler-32
	  checksum is equal to that saved by the compressor and returns Z_STREAM_END
	  only if the checksum is correct.

		inflate() can decompress and check either zlib-wrapped or gzip-wrapped
	  deflate data.  The header type is detected automatically, if requested when
	  initializing with inflateInit2().  Any information contained in the gzip
	  header is not retained unless inflateGetHeader() is used.  When processing
	  gzip-wrapped deflate data, strm->adler32 is set to the CRC-32 of the output
	  produced so far.  The CRC-32 is checked against the gzip trailer, as is the
	  uncompressed length, modulo 2^32.

		inflate() returns Z_OK if some progress has been made (more input processed
	  or more output produced), Z_STREAM_END if the end of the compressed data has
	  been reached and all uncompressed output has been produced, Z_NEED_DICT if a
	  preset dictionary is needed at this point, Z_DATA_ERROR if the input data was
	  corrupted (input stream not conforming to the zlib format or incorrect check
	  value, in which case strm->msg points to a string with a more specific
	  error), Z_STREAM_ERROR if the stream structure was inconsistent (for example
	  next_in or next_out was Z_NULL, or the state was inadvertently written over
	  by the application), Z_MEM_ERROR if there was not enough memory, Z_BUF_ERROR
	  if no progress was possible or if there was not enough room in the output
	  buffer when Z_FINISH is used.  Note that Z_BUF_ERROR is not fatal, and
	  inflate() can be called again with more input and more output space to
	  continue decompressing.  If Z_DATA_ERROR is returned, the application may
	  then call inflateSync() to look for a good compression block if a partial
	  recovery of the data is to be attempted.
	*/
	func inflate(flush: ZlibFlush) throws -> Bool {
		let streamPtr = self.streamPtr

		let flushValue = flush.rawValue

		let status = Z.inflate(streamPtr, flushValue)

		if status == Z_STREAM_END {
			return true
		}

		guard ZlibError.isSuccess(status) else {
			throw Self.error(streamPtr: streamPtr,
							 status: status)
		}

		return false
	}
}

private extension ZlibInflateStream {
	static func error(streamPtr: UnsafePointer<z_stream>,
					  status: Int32) -> ZlibError {
		let errMsg = Self.errorMessage(streamPtr: streamPtr)

		let err = ZlibError.withStatus(status,
									   errorMessage: errMsg)

		return err
	}

	static func errorMessage(streamPtr: UnsafePointer<z_stream>) -> String? {
		guard let msg = streamPtr.pointee.msg else {
			return nil
		}

		let errorMsg = String(cString: msg)

		return errorMsg
	}
}

private extension ZlibError {
	static func isSuccess(_ status: Int32) -> Bool {
		status == Z_OK
	}

	static func withStatus(_ status: Int32,
						   errorMessage: String?) -> Self {
		switch status {
			case Z_STREAM_END:
				.streamEnd(message: errorMessage)
			case Z_NEED_DICT:
				.needDict(message: errorMessage)
			case Z_ERRNO:
				.errNo(message: errorMessage)
			case Z_STREAM_ERROR:
				.streamError(message: errorMessage)
			case Z_DATA_ERROR:
				.dataError(message: errorMessage)
			case Z_MEM_ERROR:
				.memoryError(message: errorMessage)
			case Z_BUF_ERROR:
				.bufferError(message: errorMessage)
			case Z_VERSION_ERROR:
				.versionError(message: errorMessage)
			default:
				.unknown(status: status, message: errorMessage)
		}
	}
}
