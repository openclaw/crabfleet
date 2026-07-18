# macOS Screen-Recording Indicator & ScreenCaptureKit

Context for anyone wondering why sharing this Mac lights up a menu-bar indicator (purple on
Sonoma, **blue on macOS 26 Tahoe**) and why macOS periodically re-prompts for screen access.

## What you're seeing (two separate things)

1. **The recording indicator** — a menu-bar pill plus ScreenCaptureKit's own "Video" menu-bar
   item (WWDC23 §10136: SCK adds a live-preview + Stop control for every active `SCStream`).
   For any third-party app running an `SCStream`, this is **mandatory and unsuppressible** —
   there is no app-side API (`SCStreamConfiguration`/`SCContentFilter` do not affect it), and it
   is independent of display-vs-window capture, audio capture, or picker choice. It exists as a
   privacy guarantee. The only Apple-sanctioned hide is the _external-display_ exemption
   (`system-override suppress-sw-camera-indication-on-external-displays=on`, Apple Support
   118449), which does not cover a host sharing its built-in/primary display.

2. **The recurring "…bypass the system private window picker and directly access your screen and
   audio" prompt** — macOS 15+ periodic TCC re-authorization for SCK used _without_ the system
   `SCContentSharingPicker`. This is **not** an indicator; it's a consent nag, and it _is_
   solvable (below).

Do not conflate the two: the prompt is fixable, the indicator largely is not for third-party apps.

## How Jump Desktop / first-party Screen Sharing differ

Apple Remote Desktop and the built-in Screen Sharing (VNC) are first-party and **exempt** from
the third-party indicator. Jump Desktop appears exempt because its capture lands in the
**Remote Desktop / Remote Management** TCC class (`kTCCServiceRemoteDesktop`) — the same
unattended-access bucket as Apple's Screen Sharing — rather than plain "Screen Recording".
Jump also holds Apple's restricted entitlement **`com.apple.developer.persistent-content-capture`**,
which removes the recurring re-auth prompt for VNC-style apps. (Jump migrated _toward_ SCK, not
away from it; the legacy `CGDisplayStream`/`CGWindowListCreateImage` path is deprecated and
triggers _more_ consent alerts on Sonoma+.)

**Unverified:** whether the Remote Desktop grant actually removes the _indicator_ on macOS 26 for
a third-party app. The prompt removal is documented; the indicator removal is a plausible
side effect of the permission class but must be confirmed on-device before relying on it.

## Options for Crabfleet (ranked)

1. **`persistent-content-capture` entitlement + Remote Desktop grant** — the real "Jump playbook".
   Removes the recurring prompt; may drop the indicator (verify on-device). Cost: Apple-_gated_
   restricted entitlement (applied for per signing identity — **open-source status does not waive
   this**), a dedicated App ID, per-executable provisioning profiles, notarization, and users must
   grant under Privacy → Remote Desktop, not Screen Recording. Medium effort, external approval
   dependency.
2. **Stay on SCK, adopt `SCContentSharingPicker`** — removes the "bypass the private window picker"
   prompt with no entitlement, but adds a picker step (undesirable for an unattended host) and does
   **not** remove the indicator. Low effort; honest fallback.
3. **Legacy `CGDisplayStream`/`CGWindowListCreateImage`** — rejected: deprecated, _more_ prompts,
   still lights the indicator.
4. **System extension / DriverKit virtual display** — could sidestep the built-in-display indicator
   by capturing a synthetic display, but very high cost (system-extension approval, DriverKit
   entitlements, notarization, OS-version fragility). Overkill.

## Recommendation

Accept the indicator for now — it is the honest cost of third-party screen capture and appears for
Parsec/Screens/TeamViewer alike. Only pursue the `persistent-content-capture` entitlement if the
recurring **prompt** becomes painful in real unattended use. Before investing, run the cheap
empirical test: switch capture to request **Remote Desktop** permission and observe whether the
indicator changes on macOS 26.

## References

- [Apple: persistent-content-capture entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.persistent-content-capture)
- [Jump Desktop: macOS Sequoia Screen Recording Policies](https://support.jumpdesktop.com/hc/en-us/articles/29070118000781-macOS-Sequoia-Screen-Recording-Policies-and-Jump-Desktop-Connect)
- [Michael Tsai: Sequoia screen-recording prompts & persistent-content-capture](https://mjtsai.com/blog/2024/08/08/sequoia-screen-recording-prompts-and-the-persistent-content-capture-entitlement/)
- [WWDC23 10136 — What's new in ScreenCaptureKit](https://developer.apple.com/videos/play/wwdc2023/10136/)
- [Apple Support 118449 — hide privacy indicators on external displays](https://support.apple.com/en-us/118449)
