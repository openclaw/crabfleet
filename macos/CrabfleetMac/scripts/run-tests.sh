#!/bin/sh
set -eu

package_path=macos/CrabfleetMac
integration_tests='tailnetQUICListenerAuthenticatesWithARD|keepsTCPListenerReadyWhenQUICPortIsOccupied|connectionGroupsWithoutStreamsDoNotReserveViewerSlots|expiresIncompleteRFBHandshakeAndReleasesInput|servesRoyalVNCKitOverTheCurrentTailnet|syncsUTF8ClipboardAndNegotiatesResizeOverLoopback|revokingNativeAccessStopsPendingCrabboxBridge'

# TailnetRFBServer waits for the shared ARD crypto prewarm before binding.
# The Crabbox bridge test likewise depends on prompt subprocess scheduling.
# Bound unit-test fan-out, then run these integration tests alone so their
# existing listener and lifecycle deadlines remain meaningful.
swift test \
  --package-path "$package_path" \
  --experimental-maximum-parallelization-width 8 \
  --skip "$integration_tests"
swift test \
  --package-path "$package_path" \
  --skip-build \
  --experimental-maximum-parallelization-width 1 \
  --filter "$integration_tests"
