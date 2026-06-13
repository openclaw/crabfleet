#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

@_implementationOnly import RoyalVNCKitC

final class VNCAuthenticationRequest_C {
    typealias CompletionHandler = ((any VNCCredential)?) -> Void

    let authenticationType: VNCAuthenticationType
    let completionHandler: CompletionHandler

    init(authenticationType: VNCAuthenticationType,
         completionHandler: @escaping CompletionHandler) {
        self.authenticationType = authenticationType
        self.completionHandler = completionHandler
    }

    func cancel() {
        completionHandler(nil)
    }

    func completeWith(credential: any VNCCredential) {
        completionHandler(credential)
    }

    func completeWith(username: String,
                      password: String) {
        let credential = VNCUsernamePasswordCredential(username: username,
                                                       password: password)

        completeWith(credential: credential)
    }

    func completeWith(password: String) {
        let credential = VNCPasswordCredential(password: password)

        completeWith(credential: credential)
    }
}

extension VNCAuthenticationRequest_C {
    func retainedPointer() -> rvnc_authentication_request_t {
        .retainedPointerFrom(self)
    }

    func unretainedPointer() -> rvnc_authentication_request_t {
        .unretainedPointerFrom(self)
    }

    static func autoreleasePointer(_ pointer: rvnc_authentication_request_t) {
        pointer.autorelease(VNCFramebuffer.self)
    }

    static func fromPointer(_ pointer: rvnc_authentication_request_t) -> Self {
        pointer.unretainedInstance()
    }
}

@_cdecl("rvnc_authentication_request_authentication_type_get")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_authentication_request_authentication_type_get(_ authenticationRequest: rvnc_authentication_request_t) -> RVNC_AUTHENTICATIONTYPE {
    VNCAuthenticationRequest_C.fromPointer(authenticationRequest)
        .authenticationType
        .cVNCAuthenticationType
}

@_cdecl("rvnc_authentication_request_cancel")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_authentication_request_cancel(_ authenticationRequest: rvnc_authentication_request_t) {
    let authenticationRequestSwift = VNCAuthenticationRequest_C.fromPointer(authenticationRequest)

    defer {
        VNCAuthenticationRequest_C.autoreleasePointer(authenticationRequest)
    }

    authenticationRequestSwift.cancel()
}

@_cdecl("rvnc_authentication_request_complete_with_username_password")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_authentication_request_complete_with_username_password(_ authenticationRequest: rvnc_authentication_request_t,
                                                                        _ username: UnsafePointer<CChar>,
                                                                        _ password: UnsafePointer<CChar>) {
    let authenticationRequestSwift = VNCAuthenticationRequest_C.fromPointer(authenticationRequest)

    defer {
        VNCAuthenticationRequest_C.autoreleasePointer(authenticationRequest)
    }

    authenticationRequestSwift.completeWith(username: .init(cString: username),
                                            password: .init(cString: password))
}

@_cdecl("rvnc_authentication_request_complete_with_password")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_authentication_request_complete_with_password(_ authenticationRequest: rvnc_authentication_request_t,
                                                               _ password: UnsafePointer<CChar>) {
    let authenticationRequestSwift = VNCAuthenticationRequest_C.fromPointer(authenticationRequest)

    defer {
        VNCAuthenticationRequest_C.autoreleasePointer(authenticationRequest)
    }

    authenticationRequestSwift.completeWith(password: .init(cString: password))
}
