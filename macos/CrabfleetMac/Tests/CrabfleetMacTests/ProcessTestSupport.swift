import Darwin
import Foundation

func readProcessID(from file: URL) -> pid_t? {
  guard
    let contents = try? String(contentsOf: file, encoding: .utf8),
    let processID = pid_t(contents),
    processID > 0
  else {
    return nil
  }
  return processID
}
