import Darwin
import Foundation

func availableLoopbackPort(socketType: Int32) throws -> UInt16 {
  let descriptor = socket(AF_INET, socketType, 0)
  guard descriptor >= 0 else { throw POSIXError(.ENOTSOCK) }
  defer { close(descriptor) }
  var address = sockaddr_in()
  address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
  address.sin_family = sa_family_t(AF_INET)
  address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
  let bound = withUnsafePointer(to: &address) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
    }
  }
  guard bound else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EINVAL) }
  var length = socklen_t(MemoryLayout<sockaddr_in>.size)
  let resolved = withUnsafeMutablePointer(to: &address) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      getsockname(descriptor, $0, &length) == 0
    }
  }
  guard resolved else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EINVAL) }
  return UInt16(bigEndian: address.sin_port)
}
