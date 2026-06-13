#include <stdlib.h>
#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>

// NOTE: Memory management roughly follows Apple's CoreFoundation Ownership Policy: https://developer.apple.com/library/archive/documentation/CoreFoundation/Conceptual/CFMemoryMgmt/Concepts/Ownership.html#//apple_ref/doc/uid/20001148-CJBEJBHH
// If you create an object (by calling a method suffixed with either `_create` or `_copy`), you own it and must relinquish ownership when you have finished using it (by calling a matching method suffixed with `_destroy` or `free` in case of C strings).
// If you get an object from somewhere else, you do not own it. You must not store a reference to such objects since they might be destroyed right after the function call that they're passed into finishes.


#pragma mark - Enums

/**
 * Log levels used for logging messages.
 */
typedef enum {
    RVNC_LOG_LEVEL_DEBUG = 0,
    RVNC_LOG_LEVEL_INFO = 1,
    RVNC_LOG_LEVEL_WARNING = 2,
    RVNC_LOG_LEVEL_ERROR = 3
} RVNC_LOG_LEVEL;

/**
 * Connection status states representing the current state of a VNC connection.
 */
typedef enum {
    RVNC_CONNECTION_STATUS_DISCONNECTED = 0,
    RVNC_CONNECTION_STATUS_CONNECTING = 1,
    RVNC_CONNECTION_STATUS_CONNECTED = 2,
    RVNC_CONNECTION_STATUS_DISCONNECTING = 3
} RVNC_CONNECTION_STATUS;

/**
 * Input modes defining how keyboard shortcuts and hotkeys are forwarded.
 */
typedef enum {
    RVNC_INPUTMODE_NONE = 0,
    RVNC_INPUTMODE_FORWARDKEYBOARDSHORTCUTSIFNOTINUSELOCALLY = 1,
    RVNC_INPUTMODE_FORWARDKEYBOARDSHORTCUTSEVENIFINUSELOCALLY = 2,
    RVNC_INPUTMODE_FORWARDALLKEYBOARDSHORTCUTSANDHOTKEYS = 3
} RVNC_INPUTMODE;

/**
 * Color depth options for framebuffer pixel formats.
 */
typedef enum {
    RVNC_COLORDEPTH_8BIT = 8, // 256 Colors
    RVNC_COLORDEPTH_16BIT = 16,
    RVNC_COLORDEPTH_24BIT = 24
} RVNC_COLORDEPTH;

/**
 * Authentication types supported by VNC connections.
 */
typedef enum {
    RVNC_AUTHENTICATIONTYPE_VNC = 0,
    RVNC_AUTHENTICATIONTYPE_APPLEREMOTEDESKTOP = 1,
    RVNC_AUTHENTICATIONTYPE_ULTRAVNCMSLOGONII = 2
} RVNC_AUTHENTICATIONTYPE;

/**
 * Mouse buttons used in mouse input events.
 */
typedef enum {
    RVNC_MOUSEBUTTON_LEFT = 0,
    RVNC_MOUSEBUTTON_MIDDLE = 1,
    RVNC_MOUSEBUTTON_RIGHT = 2
} RVNC_MOUSEBUTTON;

/**
 * Mouse wheel directions used in mouse wheel input events.
 */
typedef enum {
    RVNC_MOUSEWHEEL_LEFT = 0,
    RVNC_MOUSEWHEEL_RIGHT = 1,
    RVNC_MOUSEWHEEL_UP = 2,
    RVNC_MOUSEWHEEL_DOWN = 3
} RVNC_MOUSEWHEEL;


#pragma mark - Types

typedef void* rvnc_context_t;
typedef void* rvnc_logger_t;
typedef void* rvnc_logger_delegate_t;
typedef void* rvnc_authentication_request_t;
typedef void* rvnc_frame_encodings_t;
typedef void* rvnc_settings_t;
typedef void* rvnc_connection_state_t;
typedef void* rvnc_framebuffer_t;
typedef void* rvnc_framebuffer_allocator_t;
typedef void* rvnc_connection_t;
typedef void* rvnc_connection_delegate_t;
typedef void* rvnc_cursor_t;


#pragma mark - Logger

/**
 * Callback function type for logger delegate to handle log messages.
 * \param logger The logger instance invoking the callback.
 * \param context Optional user-defined context passed during logger creation.
 * \param logLevel The severity level of the log message.
 * \param message The log message string.
 */
typedef void (*rvnc_logger_delegate_log)(rvnc_logger_t _Nonnull /* logger */,
                                         const rvnc_context_t _Nullable /* context */,
                                         RVNC_LOG_LEVEL /* logLevel */,
                                         const char* _Nonnull /* message */);

/**
 * Creates a new logger with the specified delegate callback.
 * The returned logger must be destroyed using `rvnc_logger_destroy`.
 * \param log Callback function for logging messages.
 * \param context Optional context passed to the callback.
 * \return A newly created logger instance.
 */
extern rvnc_logger_t _Nonnull rvnc_logger_create(rvnc_logger_delegate_log _Nonnull log,
                                                 rvnc_context_t _Nullable context);

/**
 * Destroys a logger instance and releases its resources.
 * \param logger The logger instance to destroy.
 */
extern void rvnc_logger_destroy(rvnc_logger_t _Nonnull logger);


#pragma mark - Framebuffer Allocator

/**
 * Function pointer type for allocating framebuffer memory.
 * \param framebufferAllocator The framebuffer allocator instance.
 * \param size The size in bytes to allocate.
 * \return Pointer to the allocated memory buffer.
 */
typedef void* _Nonnull (*rvnc_framebuffer_allocator_allocate)(rvnc_framebuffer_allocator_t _Nonnull /* framebufferAllocator */,
                                                              size_t /* size */);

/**
 * Function pointer type for deallocating framebuffer memory.
 * \param framebufferAllocator The framebuffer allocator instance.
 * \param buffer Pointer to the memory buffer to deallocate.
 */
typedef void (*rvnc_framebuffer_allocator_deallocate)(rvnc_framebuffer_allocator_t _Nonnull /* framebufferAllocator */,
                                                      void* _Nonnull /* buffer */);

// NOTE: Argh... Need to hide this declaration from ObjC because otherwise we end up with a symbol collision in targets that include ObjC support.
#if !defined(__OBJC__)
/**
 * Creates a framebuffer allocator with custom allocate and deallocate functions.
 * The returned allocator must be destroyed using `rvnc_framebuffer_allocator_destroy`.
 * \param allocate Function pointer to allocate memory.
 * \param deallocate Function pointer to deallocate memory.
 * \return A newly created framebuffer allocator instance.
 */
extern rvnc_framebuffer_allocator_t _Nonnull rvnc_framebuffer_allocator_create(rvnc_framebuffer_allocator_allocate _Nonnull allocate,
                                                                               rvnc_framebuffer_allocator_deallocate _Nonnull deallocate);
#endif

/**
 * Destroys a framebuffer allocator and releases its resources.
 * \param framebufferAllocator The framebuffer allocator instance to destroy.
 */
extern void rvnc_framebuffer_allocator_destroy(rvnc_framebuffer_allocator_t _Nonnull framebufferAllocator);



#pragma mark - Authentication Type

/**
 * Determines whether the specified authentication type requires a username.
 * \param authenticationType The authentication type to check.
 * \return true if username is required, false otherwise.
 */
extern bool rvnc_authentication_type_requires_username(RVNC_AUTHENTICATIONTYPE authenticationType);

/**
 * Determines whether the specified authentication type requires a password.
 * \param authenticationType The authentication type to check.
 * \return true if password is required, false otherwise.
 */
extern bool rvnc_authentication_type_requires_password(RVNC_AUTHENTICATIONTYPE authenticationType);


#pragma mark - Authentication Request

/**
 * Retrieves the authentication type from an authentication request.
 * \param authenticationRequest The authentication request instance.
 * \return The authentication type associated with the request.
 */
extern RVNC_AUTHENTICATIONTYPE rvnc_authentication_request_authentication_type_get(rvnc_authentication_request_t _Nonnull authenticationRequest);

/**
 * Cancels an ongoing authentication request.
 * \param authenticationRequest The authentication request instance to cancel.
 */
extern void rvnc_authentication_request_cancel(rvnc_authentication_request_t _Nonnull authenticationRequest);

/**
 * Completes an authentication request using the provided username and password.
 * \param authenticationRequest The authentication request instance.
 * \param username The username string.
 * \param password The password string.
 */
extern void rvnc_authentication_request_complete_with_username_password(rvnc_authentication_request_t _Nonnull authenticationRequest,
                                                                        const char* _Nonnull username,
                                                                        const char* _Nonnull password);

/**
 * Completes an authentication request using the provided password.
 * \param authenticationRequest The authentication request instance.
 * \param password The password string.
 */
extern void rvnc_authentication_request_complete_with_password(rvnc_authentication_request_t _Nonnull authenticationRequest,
                                                               const char* _Nonnull password);


#pragma mark - Frame Encodings

/**
 * Creates a new frame encodings object with an empty set of encodings.
 * Encodings can be appended to the set by calling one of the methods prefixed with `rvnc_frame_encodings_append_`.
 * Encodings should be appended in priority order, with the first one being the most important, the second one being the second most important and so on.
 * The returned frame encodings object must be destroyed using `rvnc_frame_encodings_destroy`.
 * \return A newly created frame encodings instance.
 */
extern rvnc_frame_encodings_t _Nonnull rvnc_frame_encodings_create(void);

/**
 * Appends the "Tight" encoding to the specified set of frame encodings.
 * \param frameEncodings The frame encodings instance to modify.
 */
extern void rvnc_frame_encodings_append_tight(rvnc_frame_encodings_t _Nonnull frameEncodings);

/**
 * Appends the "zlib" encoding to the specified set of frame encodings.
 * \param frameEncodings The frame encodings instance to modify.
 */
extern void rvnc_frame_encodings_append_zlib(rvnc_frame_encodings_t _Nonnull frameEncodings);

/**
 * Appends the "ZRLE" encoding to the specified set of frame encodings.
 * \param frameEncodings The frame encodings instance to modify.
 */
extern void rvnc_frame_encodings_append_zrle(rvnc_frame_encodings_t _Nonnull frameEncodings);

/**
 * Appends the "Hextile" encoding to the specified set of frame encodings.
 * \param frameEncodings The frame encodings instance to modify.
 */
extern void rvnc_frame_encodings_append_hextile(rvnc_frame_encodings_t _Nonnull frameEncodings);

/**
 * Appends the "CoRRE" encoding to the specified set of frame encodings.
 * \param frameEncodings The frame encodings instance to modify.
 */
extern void rvnc_frame_encodings_append_corre(rvnc_frame_encodings_t _Nonnull frameEncodings);

/**
 * Appends the "RRE" encoding to the specified set of frame encodings.
 * \param frameEncodings The frame encodings instance to modify.
 */
extern void rvnc_frame_encodings_append_rre(rvnc_frame_encodings_t _Nonnull frameEncodings);

/**
 * Destroys a frame encodings instance and releases its resources.
 * \param frameEncodings The frame encodings instance to destroy.
 */
extern void rvnc_frame_encodings_destroy(rvnc_frame_encodings_t _Nonnull frameEncodings);


#pragma mark - Settings

/**
 * Creates a new settings object with the specified connection parameters.
 * The returned settings object must be destroyed using `rvnc_settings_destroy`.
 * \param isDebugLoggingEnabled Enables debug logging if true.
 * \param hostname The hostname or IP address of the VNC server.
 * \param port The port number of the VNC server.
 * \param isShared Indicates if the connection is shared.
 * \param isScalingEnabled Enables framebuffer scaling if true.
 * \param useDisplayLink Enables DisplayLink usage if true.
 * \param inputMode The input mode for keyboard handling.
 * \param isClipboardRedirectionEnabled Enables clipboard redirection if true.
 * \param colorDepth The color depth for the framebuffer.
 * \param frameEncodings A set of frame encodings ordered by priority or NULL for the default set of encodings.
 * \return A newly created settings instance.
 */
extern rvnc_settings_t _Nonnull rvnc_settings_create(bool isDebugLoggingEnabled,
                                                     const char* _Nonnull hostname,
                                                     uint16_t port,
                                                     bool isShared,
                                                     bool isScalingEnabled,
                                                     bool useDisplayLink,
                                                     RVNC_INPUTMODE inputMode,
                                                     bool isClipboardRedirectionEnabled,
                                                     RVNC_COLORDEPTH colorDepth,
                                                     rvnc_frame_encodings_t _Nullable frameEncodings);

/**
 * Destroys a settings instance and releases its resources.
 * \param settings The settings instance to destroy.
 */
extern void rvnc_settings_destroy(rvnc_settings_t _Nonnull settings);


#pragma mark - Connection State

/**
 * Destroys a connection state instance and releases its resources.
 * \param connectionState The connection state instance to destroy.
 */
extern void rvnc_connection_state_destroy(rvnc_connection_state_t _Nonnull connectionState);

/**
 * Retrieves the current status of a connection state.
 * \param connectionState The connection state instance.
 * \return The connection status enum value.
 */
extern RVNC_CONNECTION_STATUS rvnc_connection_state_status_get(rvnc_connection_state_t _Nonnull connectionState);

/**
 * Retrieves a copy of the error description string from a connection state.
 * The returned string must be freed by the caller.
 * \param connectionState The connection state instance.
 * \return A newly allocated error description string or NULL if no error.
 */
extern char* _Nullable rvnc_connection_state_error_description_get_copy(rvnc_connection_state_t _Nonnull connectionState);

/**
 * Determines whether the error in the connection state should be displayed to the user.
 * \param connectionState The connection state instance.
 * \return true if the error should be displayed, false otherwise.
 */
extern bool rvnc_connection_state_error_should_display_to_user_get(rvnc_connection_state_t _Nonnull connectionState);

/**
 * Determines whether the error in the connection state is an authentication error.
 * \param connectionState The connection state instance.
 * \return true if the error is an authentication error, false otherwise.
 */
extern bool rvnc_connection_state_error_is_authentication_error_get(rvnc_connection_state_t _Nonnull connectionState);


#pragma mark - Framebuffer

/**
 * Retrieves the width of the framebuffer in pixels.
 * \param framebuffer The framebuffer instance.
 * \return The width in pixels.
 */
extern uint16_t rvnc_framebuffer_size_width_get(rvnc_framebuffer_t _Nonnull framebuffer);

/**
 * Retrieves the height of the framebuffer in pixels.
 * \param framebuffer The framebuffer instance.
 * \return The height in pixels.
 */
extern uint16_t rvnc_framebuffer_size_height_get(rvnc_framebuffer_t _Nonnull framebuffer);

/**
 * Retrieves a pointer to the framebuffer's pixel data.
 * The pixel data is always in 32-bit BGRA format.
 * \param framebuffer The framebuffer instance.
 * \return Pointer to the pixel data buffer.
 */
extern void* _Nonnull rvnc_framebuffer_pixel_data_get(rvnc_framebuffer_t _Nonnull framebuffer);

/**
 * Retrieves the size in bytes of the framebuffer's pixel data.
 * \param framebuffer The framebuffer instance.
 * \return The size of the pixel data in bytes.
 */
extern uint64_t rvnc_framebuffer_pixel_data_size_get(rvnc_framebuffer_t _Nonnull framebuffer);

/**
 * Retrieves a copy of the framebuffer's pixel data formatted as 32-bit RGBA.
 * The caller is responsible for destroying the returned pixel data using `rvnc_framebuffer_pixel_data_rgba32_destroy`.
 * \param framebuffer The framebuffer instance.
 * \param pixelDataSize Optional pointer to receive the size of the pixel data.
 * \return Pointer to the copied pixel data in RGBA format.
 */
extern void* _Nonnull rvnc_framebuffer_pixel_data_rgba32_get_copy(rvnc_framebuffer_t _Nonnull framebuffer,
                                                                  uint64_t* _Nullable pixelDataSize);

/**
 * Destroys a previously obtained RGBA32 pixel data copy.
 * \param framebuffer The framebuffer instance.
 * \param pixelData Pointer to the pixel data to destroy.
 */
extern void rvnc_framebuffer_pixel_data_rgba32_destroy(rvnc_framebuffer_t _Nonnull framebuffer,
                                                       void* _Nonnull pixelData);

/**
 * Copies the framebuffer's pixel data to a pre-allocated RGBA32 destination buffer.
 * \param framebuffer The framebuffer instance.
 * \param destinationPixelBuffer Pointer to the destination buffer.
 */
extern void rvnc_framebuffer_copy_pixel_data_to_rgba32_buffer(rvnc_framebuffer_t _Nonnull framebuffer,
                                                              void* _Nonnull destinationPixelBuffer);


#pragma mark - Cursor

/**
 * Checks if the cursor is empty (no visible pixels).
 * \param cursor The cursor instance.
 * \return true if the cursor is empty, false otherwise.
 */
extern bool rvnc_cursor_is_empty_get(rvnc_cursor_t _Nonnull cursor);

/**
 * Retrieves the width of the cursor in pixels.
 * \param cursor The cursor instance.
 * \return The width in pixels.
 */
extern uint16_t rvnc_cursor_size_width_get(rvnc_cursor_t _Nonnull cursor);

/**
 * Retrieves the height of the cursor in pixels.
 * \param cursor The cursor instance.
 * \return The height in pixels.
 */
extern uint16_t rvnc_cursor_size_height_get(rvnc_cursor_t _Nonnull cursor);

/**
 * Retrieves the X coordinate of the cursor hotspot.
 * \param cursor The cursor instance.
 * \return The X coordinate of the hotspot.
 */
extern uint16_t rvnc_cursor_hotspot_x_get(rvnc_cursor_t _Nonnull cursor);

/**
 * Retrieves the Y coordinate of the cursor hotspot.
 * \param cursor The cursor instance.
 * \return The Y coordinate of the hotspot.
 */
extern uint16_t rvnc_cursor_hotspot_y_get(rvnc_cursor_t _Nonnull cursor);

/**
 * Retrieves the number of bits per color component in the cursor image.
 * \param cursor The cursor instance.
 * \return The bits per component.
 */
extern int64_t rvnc_cursor_bits_per_component_get(rvnc_cursor_t _Nonnull cursor);

/**
 * Retrieves the number of bits per pixel in the cursor image.
 * \param cursor The cursor instance.
 * \return The bits per pixel.
 */
extern int64_t rvnc_cursor_bits_per_pixel_get(rvnc_cursor_t _Nonnull cursor);

/**
 * Retrieves the number of bytes per pixel in the cursor image.
 * \param cursor The cursor instance.
 * \return The bytes per pixel.
 */
extern int64_t rvnc_cursor_bytes_per_pixel_get(rvnc_cursor_t _Nonnull cursor);

/**
 * Retrieves the number of bytes per row in the cursor image.
 * \param cursor The cursor instance.
 * \return The bytes per row.
 */
extern int64_t rvnc_cursor_bytes_per_row_get(rvnc_cursor_t _Nonnull cursor);

/**
 * Retrieves a copy of the cursor's pixel data.
 * The caller is responsible for destroying the returned pixel data using `rvnc_cursor_pixel_data_destroy`.
 * \param cursor The cursor instance.
 * \return Pointer to the copied pixel data or NULL if no data.
 */
extern void* _Nullable rvnc_cursor_pixel_data_get_copy(rvnc_cursor_t _Nonnull cursor);

/**
 * Destroys a previously obtained cursor pixel data copy.
 * \param pixelData Pointer to the pixel data to destroy.
 */
extern void rvnc_cursor_pixel_data_destroy(void* _Nonnull pixelData);

/**
 * Retrieves the size in bytes of the cursor's pixel data.
 * \param cursor The cursor instance.
 * \return The size of the pixel data in bytes.
 */
extern uint64_t rvnc_cursor_pixel_data_size_get(rvnc_cursor_t _Nonnull cursor);

/**
 * Copies the cursor's pixel data to a pre-allocated RGBA32 destination buffer.
 * \param cursor The cursor instance.
 * \param destinationPixelBuffer Pointer to the destination buffer.
 */
extern void rvnc_cursor_copy_pixel_data_to_rgba32_buffer(rvnc_cursor_t _Nonnull cursor,
                                                         void* _Nonnull destinationPixelBuffer);


#pragma mark - Connection Delegate

/**
 * Callback function type invoked when the connection state changes.
 * \param connection The connection instance.
 * \param context Optional user-defined context.
 * \param connectionState The new connection state instance.
 */
typedef void (*rvnc_connection_delegate_connection_state_did_change)(rvnc_connection_t _Nonnull /* connection */,
                                                                     const rvnc_context_t _Nullable /* context */,
                                                                     _Nonnull rvnc_connection_state_t /* connectionState */);

/**
 * Callback function type invoked to perform user authentication.
 * \param connection The connection instance.
 * \param context Optional user-defined context.
 * \param authenticationRequest The authentication request instance to complete.
 */
typedef void (*rvnc_connection_delegate_authenticate)(rvnc_connection_t _Nonnull /* connection */,
                                                      const rvnc_context_t _Nullable /* context */,
                                                      _Nonnull rvnc_authentication_request_t /* authenticationRequest */);

/**
 * Callback function type invoked when a framebuffer is created.
 * \param connection The connection instance.
 * \param context Optional user-defined context.
 * \param framebuffer The newly created framebuffer instance.
 */
typedef void (*rvnc_connection_delegate_did_create_framebuffer)(rvnc_connection_t _Nonnull /* connection */,
                                                                const rvnc_context_t _Nullable /* context */,
                                                                _Nonnull rvnc_framebuffer_t /* framebuffer */);

/**
 * Callback function type invoked when a framebuffer is resized.
 * \param connection The connection instance.
 * \param context Optional user-defined context.
 * \param framebuffer The resized framebuffer instance.
 */
typedef void (*rvnc_connection_delegate_did_resize_framebuffer)(rvnc_connection_t _Nonnull /* connection */,
                                                                const rvnc_context_t _Nullable /* context */,
                                                                _Nonnull rvnc_framebuffer_t /* framebuffer */);

/**
 * Callback function type invoked when a framebuffer is updated.
 * \param connection The connection instance.
 * \param context Optional user-defined context.
 * \param framebuffer The updated framebuffer instance.
 * \param x The x-coordinate of the updated region.
 * \param y The y-coordinate of the updated region.
 * \param width The width of the updated region.
 * \param height The height of the updated region.
 */
typedef void (*rvnc_connection_delegate_did_update_framebuffer)(rvnc_connection_t _Nonnull /* connection */,
                                                                const rvnc_context_t _Nullable /* context */,
                                                                _Nonnull rvnc_framebuffer_t /* framebuffer */,
                                                                uint16_t /* x */,
                                                                uint16_t /* y */,
                                                                uint16_t /* width */,
                                                                uint16_t /* height */);

/**
 * Callback function type invoked when the cursor is updated.
 * \param connection The connection instance.
 * \param context Optional user-defined context.
 * \param cursor The updated cursor instance.
 */
typedef void (*rvnc_connection_delegate_did_update_cursor)(rvnc_connection_t _Nonnull /* connection */,
                                                           const rvnc_context_t _Nullable /* context */,
                                                           rvnc_cursor_t _Nonnull /* cursor */);

/**
 * Creates a connection delegate with the specified callback functions.
 * The returned delegate must be destroyed using `rvnc_connection_delegate_destroy`.
 * \param connectionStateDidChange Callback for connection state changes.
 * \param authenticate Callback for authentication requests.
 * \param didCreateFramebuffer Callback for framebuffer creation.
 * \param didResizeFramebuffer Callback for framebuffer resizing.
 * \param didUpdateFramebuffer Callback for framebuffer updates.
 * \param didUpdateCursor Callback for cursor updates.
 * \return A newly created connection delegate instance.
 */
extern rvnc_connection_delegate_t _Nonnull rvnc_connection_delegate_create(rvnc_connection_delegate_connection_state_did_change _Nonnull connectionStateDidChange,
                                                                           rvnc_connection_delegate_authenticate _Nonnull authenticate,
                                                                           rvnc_connection_delegate_did_create_framebuffer _Nonnull didCreateFramebuffer,
                                                                           rvnc_connection_delegate_did_resize_framebuffer _Nonnull didResizeFramebuffer,
                                                                           rvnc_connection_delegate_did_update_framebuffer _Nonnull didUpdateFramebuffer,
                                                                           rvnc_connection_delegate_did_update_cursor _Nonnull didUpdateCursor);

/**
 * Destroys a connection delegate instance and releases its resources.
 * \param connectionDelegate The connection delegate instance to destroy.
 */
extern void rvnc_connection_delegate_destroy(rvnc_connection_delegate_t _Nonnull connectionDelegate);


#pragma mark - Connection

/**
 * Creates a new VNC connection with the specified settings, logger, and framebuffer allocator.
 * The returned connection must be destroyed using `rvnc_connection_destroy`.
 * \param settings The settings instance to use for the connection.
 * \param logger Optional logger instance for logging.
 * \param framebufferAllocator Optional framebuffer allocator instance.
 * \param context Optional user-defined context.
 * \return A newly created connection instance.
 */
extern rvnc_connection_t _Nonnull rvnc_connection_create(rvnc_settings_t _Nonnull settings,
                                                         rvnc_logger_t _Nullable logger,
                                                         rvnc_framebuffer_allocator_t _Nullable framebufferAllocator,
                                                         rvnc_context_t _Nullable context);

/**
 * Destroys a VNC connection and releases its resources.
 * \param connection The connection instance to destroy.
 */
extern void rvnc_connection_destroy(rvnc_connection_t _Nonnull connection);

/**
 * Initiates the connection process to the VNC server.
 * \param connection The connection instance to connect.
 */
extern void rvnc_connection_connect(rvnc_connection_t _Nonnull connection);

/**
 * Disconnects an active VNC connection.
 * \param connection The connection instance to disconnect.
 */
extern void rvnc_connection_disconnect(rvnc_connection_t _Nonnull connection);

/**
 * Updates the color depth of the active connection.
 * \param connection The connection instance.
 * \param colorDepth The desired color depth.
 */
extern void rvnc_connection_update_color_depth(rvnc_connection_t _Nonnull connection,
                                               RVNC_COLORDEPTH colorDepth);

/**
 * Sets the connection delegate to receive connection-related callbacks.
 * \param connection The connection instance.
 * \param connectionDelegate The connection delegate instance or NULL to unset.
 */
extern void rvnc_connection_delegate_set(rvnc_connection_t _Nonnull connection,
                                         rvnc_connection_delegate_t _Nullable connectionDelegate);

/**
 * Retrieves the user-defined context associated with the connection.
 * \param connection The connection instance.
 * \return The context pointer or NULL if none set.
 */
extern rvnc_context_t _Nullable rvnc_connection_context_get(rvnc_connection_t _Nonnull connection);

/**
 * Retrieves a copy of the current connection state.
 * The returned connection state must be destroyed using `rvnc_connection_state_destroy`.
 * \param connection The connection instance.
 * \return A newly copied connection state instance.
 */
extern rvnc_connection_state_t _Nonnull rvnc_connection_state_get_copy(rvnc_connection_t _Nonnull connection);

/**
 * Retrieves a copy of the current connection settings.
 * The returned settings must be destroyed using `rvnc_settings_destroy`.
 * \param connection The connection instance.
 * \return A newly copied settings instance.
 */
extern rvnc_settings_t _Nonnull rvnc_connection_settings_get_copy(rvnc_connection_t _Nonnull connection);

/**
 * Sends a mouse move event to the VNC server.
 * \param connection The connection instance.
 * \param x The x-coordinate of the mouse pointer.
 * \param y The y-coordinate of the mouse pointer.
 */
extern void rvnc_connection_mouse_move(rvnc_connection_t _Nonnull connection,
                                       uint16_t x,
                                       uint16_t y);

/**
 * Sends a mouse button down event to the VNC server.
 * \param connection The connection instance.
 * \param button The mouse button pressed.
 * \param x The x-coordinate of the mouse pointer.
 * \param y The y-coordinate of the mouse pointer.
 */
extern void rvnc_connection_mouse_down(rvnc_connection_t _Nonnull connection,
                                       RVNC_MOUSEBUTTON button,
                                       uint16_t x,
                                       uint16_t y);

/**
 * Sends a mouse button up event to the VNC server.
 * \param connection The connection instance.
 * \param button The mouse button released.
 * \param x The x-coordinate of the mouse pointer.
 * \param y The y-coordinate of the mouse pointer.
 */
extern void rvnc_connection_mouse_up(rvnc_connection_t _Nonnull connection,
                                     RVNC_MOUSEBUTTON button,
                                     uint16_t x,
                                     uint16_t y);

/**
 * Sends a mouse wheel event to the VNC server.
 * \param connection The connection instance.
 * \param wheel The mouse wheel direction.
 * \param x The x-coordinate of the mouse pointer.
 * \param y The y-coordinate of the mouse pointer.
 * \param steps Number of steps the wheel moved.
 */
extern void rvnc_connection_mouse_wheel(rvnc_connection_t _Nonnull connection,
                                        RVNC_MOUSEWHEEL wheel,
                                        uint16_t x,
                                        uint16_t y,
                                        uint32_t steps);

/**
 * Sends a key down event to the VNC server.
 * The key is specified as an X11 keysym (e.g., `XK_A` for the capital letter "A"). See the `X11KeySymbols` struct.
 * \param connection The connection instance.
 * \param key The X11 keysym representing the key pressed.
 */
extern void rvnc_connection_key_down(rvnc_connection_t _Nonnull connection,
                                     uint32_t key);

/**
 * Sends a key up event to the VNC server.
 * The key is specified as an X11 keysym (e.g., `XK_A` for the capital letter "A"). See the `X11KeySymbols` struct.
 * \param connection The connection instance.
 * \param key The X11 keysym representing the key released.
 */
extern void rvnc_connection_key_up(rvnc_connection_t _Nonnull connection,
                                   uint32_t key);
