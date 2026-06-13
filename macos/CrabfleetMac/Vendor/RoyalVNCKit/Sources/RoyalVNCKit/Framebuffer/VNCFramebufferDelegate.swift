#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

/// A delegate protocol for receiving updates from a `VNCFramebuffer`.
/// Used to notify about screen region updates, desktop name changes, cursor changes, and framebuffer resizing.
protocol VNCFramebufferDelegate: AnyObject {
    /// Called when a region of the framebuffer has been updated.
    /// - Parameters:
    ///   - framebuffer: The framebuffer reporting the update.
    ///   - updatedRegion: The region that was updated.
    func framebuffer(_ framebuffer: VNCFramebuffer,
                     didUpdateRegion updatedRegion: VNCRegion)

    /// Called when the desktop name has changed.
    /// - Parameters:
    ///   - framebuffer: The framebuffer reporting the change.
    ///   - newDesktopName: The updated name of the desktop.
    func framebuffer(_ framebuffer: VNCFramebuffer,
                     didUpdateDesktopName newDesktopName: String)

    /// Called when the remote cursor has changed.
    /// - Parameters:
    ///   - framebuffer: The framebuffer reporting the change.
    ///   - cursor: The new cursor image and metadata.
    func framebuffer(_ framebuffer: VNCFramebuffer,
                     didUpdateCursor cursor: VNCCursor)

    /// Called when the framebuffer's size or screen layout has changed.
    /// - Parameters:
    ///   - framebuffer: The framebuffer reporting the change.
    ///   - newSize: The new overall size of the framebuffer.
    ///   - newScreens: The updated list of logical screens.
    func framebuffer(_ framebuffer: VNCFramebuffer,
                     sizeDidChange newSize: VNCSize,
                     screens newScreens: [VNCScreen])
}
