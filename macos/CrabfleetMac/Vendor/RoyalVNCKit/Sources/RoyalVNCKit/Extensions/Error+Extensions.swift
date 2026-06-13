#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension Error {
    var humanReadableDescription: String {
        let errorMessage: String

#if canImport(FoundationEssentials)
        if let localizedError = self as? LocalizedError,
           let errorDescription = localizedError.errorDescription {
            errorMessage = errorDescription
        } else {
            errorMessage = String(describing: self)
        }
#else
        errorMessage = self.localizedDescription
#endif

        return errorMessage
    }

    var debugDescription: String {
#if canImport(FoundationEssentials)
        .init(describing: self)
#else
        (self as NSError).debugDescription
#endif
    }
}
