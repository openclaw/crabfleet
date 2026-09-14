use super::Gateway;
use axum::extract::ws::{CloseFrame, Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tokio::{
    sync::OwnedSemaphorePermit,
    time::{Instant, timeout, timeout_at},
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{self, Message as UpstreamMessage, protocol::WebSocketConfig},
};

pub(super) const MAX_MESSAGE: usize = 2 * 1024 * 1024 + 5;
pub(super) const MAX_BUFFERED: usize = 4 * 1024 * 1024;
const SEND_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) async fn run(mut browser: WebSocket, gateway: Gateway, _permit: OwnedSemaphorePermit) {
    let mut shutdown = gateway.0.shutdown.subscribe();
    if *shutdown.borrow() {
        return;
    }
    // Wait for the normal account connect message before opening any upstream socket.
    let first = tokio::select! {
        _ = shutdown.changed() => return,
        first = timeout(Duration::from_secs(20), browser.recv()) => first,
    };
    let Ok(Some(Ok(Message::Binary(first)))) = first else {
        close(&mut browser, 1008).await;
        return;
    };
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE))
        .max_frame_size(Some(MAX_MESSAGE))
        .write_buffer_size(0)
        .max_write_buffer_size(MAX_BUFFERED);
    let mut upstream = {
        let connect = connect_async_with_config(&gateway.0.signal_url, Some(config), true);
        tokio::pin!(connect);
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            tokio::select! {
                // Observe cancellation before forwarding the account message, even
                // when the browser close and upstream upgrade become ready together.
                biased;
                _ = tokio::time::sleep_until(deadline) => {
                    close(&mut browser, 1013).await;
                    return;
                }
                _ = shutdown.changed() => return,
                message = browser.recv() => match message {
                    Some(Ok(Message::Ping(bytes))) => {
                        let send_deadline = deadline.min(Instant::now() + SEND_TIMEOUT);
                        if !matches!(timeout_at(send_deadline, browser.send(Message::Pong(bytes))).await, Ok(Ok(()))) {
                            return;
                        }
                    }
                    Some(Ok(Message::Pong(_))) => {},
                    Some(Ok(Message::Close(_))) | None => {
                        close(&mut browser, 1000).await;
                        return;
                    }
                    _ => {
                        close(&mut browser, 1002).await;
                        return;
                    }
                },
                connected = &mut connect => match connected {
                    Ok((socket, _)) => break socket,
                    Err(error) => {
                        close(&mut browser, failure_code(&error)).await;
                        return;
                    }
                },
            }
        }
    };
    if !matches!(
        timeout(SEND_TIMEOUT, upstream.send(UpstreamMessage::Binary(first))).await,
        Ok(Ok(()))
    ) {
        close(&mut browser, 1013).await;
        return;
    }
    let mut last_browser = Instant::now();
    let mut last_upstream = Instant::now();
    let mut heartbeat = tokio::time::interval_at(
        Instant::now() + Duration::from_secs(30),
        Duration::from_secs(30),
    );
    let code = loop {
        tokio::select! {
            _ = shutdown.changed() => break 1001,
            _ = heartbeat.tick() => {
                if last_browser.elapsed() >= Duration::from_secs(90) || last_upstream.elapsed() >= Duration::from_secs(180) { break 1013; }
                if !matches!(timeout(SEND_TIMEOUT, browser.send(Message::Ping(Default::default()))).await, Ok(Ok(()))) { break 1013; }
            },
            message = browser.recv() => { last_browser = Instant::now(); match message {
                Some(Ok(Message::Binary(bytes))) => {
                    if !matches!(timeout(SEND_TIMEOUT, upstream.send(UpstreamMessage::Binary(bytes))).await, Ok(Ok(()))) { break 1013; }
                }
                Some(Ok(Message::Ping(bytes))) => {
                    if !matches!(timeout(SEND_TIMEOUT, browser.send(Message::Pong(bytes))).await, Ok(Ok(()))) { break 1013; }
                }
                Some(Ok(Message::Pong(_))) => {},
                Some(Ok(Message::Close(_))) | None => break 1000,
                Some(Ok(Message::Text(_))) => break 1003,
                Some(Err(_)) => break 1002,
            } },
            message = upstream.next() => { last_upstream = Instant::now(); match message {
                Some(Ok(UpstreamMessage::Binary(bytes))) => {
                    if !matches!(timeout(SEND_TIMEOUT, browser.send(Message::Binary(bytes))).await, Ok(Ok(()))) { break 1013; }
                }
                Some(Ok(UpstreamMessage::Ping(bytes))) => {
                    if !matches!(timeout(SEND_TIMEOUT, upstream.send(UpstreamMessage::Pong(bytes))).await, Ok(Ok(()))) { break 1013; }
                }
                Some(Ok(UpstreamMessage::Pong(_))) => {},
                Some(Ok(UpstreamMessage::Close(frame))) => break frame.map_or(1001, |frame| u16::from(frame.code)),
                Some(Err(error)) => break failure_code(&error),
                None => break 1012,
                _ => break 1002,
            } },
        }
    };
    close(&mut browser, code).await;
    let _ = timeout(Duration::from_millis(500), upstream.close(None)).await;
}
fn failure_code(error: &tungstenite::Error) -> u16 {
    match error {
        tungstenite::Error::Io(_)
        | tungstenite::Error::ConnectionClosed
        | tungstenite::Error::AlreadyClosed => 1013,
        tungstenite::Error::Http(response) if response.status().is_server_error() => 1013,
        tungstenite::Error::Tls(_) | tungstenite::Error::Http(_) => 1008,
        tungstenite::Error::Capacity(_) => 1009,
        _ => 1002,
    }
}
async fn close(socket: &mut WebSocket, code: u16) {
    let code = if matches!(code, 1004..=1006 | 1015) {
        1012
    } else {
        code
    };
    let _ = timeout(
        Duration::from_millis(500),
        socket.send(Message::Close(Some(CloseFrame {
            code,
            reason: "".into(),
        }))),
    )
    .await;
}
