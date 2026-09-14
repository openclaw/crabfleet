# Synthetic desktop protocol, version 1

This is Crabfleet's local development protocol, **not RFB or Jump Fluid**. It is served only on loopback and carries synthetic pixels and input for an in-memory test desktop. It has no authentication, remote-host access, or service discovery. Do not expose it as a remote desktop service.

The transport is WebSocket at `/demo`, negotiated with the exact `crabfleet-demo-v1` subprotocol. Browser origins are restricted to `http://127.0.0.1:8093` and `http://localhost:8093`; native clients omit Origin. All application messages are binary and begin with four ASCII bytes `CRD1`, then a one-byte message kind. Integers are big-endian, and lengths must match exactly. WebSocket framing gives the message length.

## Messages

| Kind | Direction       | Payload after the kind byte                                                                                 |
| ---- | --------------- | ----------------------------------------------------------------------------------------------------------- |
| `0`  | Both            | One capabilities byte, exactly `3` (RGBA frames and input acknowledgements).                                |
| `1`  | Server → viewer | Width `u16`, height `u16`, sequence `u64`, input count `u32`, then exactly `width × height × 4` RGBA bytes. |
| `2`  | Viewer → server | Input subtype `u8`, followed by its payload below.                                                          |

The viewer sends Hello first. The server requires it and replies with Hello before producing frames. Duplicate greetings, unsupported capabilities, messages in the wrong direction, malformed lengths, invalid UTF-8, and unknown kinds/subtypes fail the session. Application heartbeats are not defined; a viewer times out after five seconds without a frame.

Frames have a maximum width of 1920 and height of 1080, both nonzero. The largest application message is therefore 8,294,421 bytes including its 21-byte header. Alpha is 255 in generated frames. Sequences increase within each connection; the viewer discards repeated/older frames. Reconnection creates new state and ignores old connection callbacks. The demo currently generates 800 × 450 frames at approximately 24 fps, subject to rendering and network backpressure.

## Input

| Subtype         | Payload after the subtype byte                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `0` Pointer     | Pixel X `u16`, pixel Y `u16`, pressed-button bitmask `u8`: primary `1`, secondary `2`, middle `4`. Other bits are rejected. |
| `1` Key         | Logical key code `u16`, down `u8` (exactly `0` or `1`).                                                                     |
| `2` Text        | UTF-8 bytes, at most 1024; no separate length field.                                                                        |
| `3` Scroll      | X and Y signed `i16` deltas. These are opaque demo values; no OS scrolling semantics are defined.                           |
| `4` Release all | No payload. Clears all pressed-button and key state.                                                                        |

Input coordinates use the remote image, excluding its letterbox margins, and are clamped by the server. The server increments the frame's input count once per processed input message, wrapping at `u32::MAX`; it is an acknowledgement counter rather than an input sequence number. Each connection owns a separate synthetic state, which is destroyed when it closes.

Key codes are uppercase ASCII letters, ASCII digits, Enter `13`, Tab `9`, Backspace `8`, Space `32`, Delete `127`, Left/Right/Up/Down `256`–`259`, Home/End `260`–`261`, and PageUp/PageDown `262`–`263`. Escape remains local to release capture. These codes are demo conventions, not a native scancode or RFB keysym mapping. The server displays only a single key-state indicator. Text retains at most 32 characters in memory without displaying them; scrolling is acknowledged without changing the image.

The native viewer's application input queue holds 128 messages and its WebSocket write buffer is capped at 256 KiB. The browser refuses new input when its buffered output exceeds 256 KiB. The server caps incoming application messages at 1040 bytes and its write buffer at 2 MiB. A saturated input queue fails the connection; it cannot leave input held on a persistent host because the synthetic desktop belongs to that connection.
