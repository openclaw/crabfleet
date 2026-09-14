//! Bounded RGBA cursor images, independent of either platform's windowing system.
use crate::{control::*, session::SessionError};
use std::{collections::VecDeque, fmt, sync::Arc};

const MAX_ENTRIES: usize = 16;
const MAX_CACHE_BYTES: usize = 4 * 1024 * 1024;
const MAX_DIMENSION: u32 = 512;

#[derive(PartialEq, Eq)]
pub struct Image {
    pub size: [u32; 2],
    pub hotspot: [u32; 2],
    pub scale_factor100: u32,
    pub rgba: Vec<u8>,
}
impl fmt::Debug for Image {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CursorImage")
            .field("size", &self.size)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct State {
    pub image: Option<Arc<Image>>,
    pub visible: bool,
}
impl Default for State {
    fn default() -> Self {
        Self {
            image: None,
            visible: true,
        }
    }
}

#[derive(Default)]
pub(crate) struct Tracker {
    pub state: State,
    current: Option<String>,
    cache: VecDeque<(String, Arc<Image>)>,
    requested: VecDeque<String>,
    bytes: usize,
}
impl Tracker {
    pub fn receive(
        &mut self,
        update: PointerUpdate,
    ) -> Result<Option<PointerRequest>, SessionError> {
        if let Some(change) = update.changed {
            if let Some(id) = change.pointer_id {
                if id.len() > 1024 {
                    return Err(SessionError::InvalidPeerMessage);
                }
                self.current = (!id.is_empty()).then_some(id);
            }
            if let Some(visible) = change.visible {
                self.state.visible = visible;
            }
        }
        if let Some(pointer) = update.image {
            let id = pointer
                .pointer_id
                .filter(|id| !id.is_empty() && id.len() <= 1024)
                .ok_or(SessionError::InvalidPeerMessage)?;
            let image = Arc::new(decode(pointer.hotspot, pointer.image)?);
            if let Some(index) = self.cache.iter().position(|(cached, _)| *cached == id) {
                self.bytes -= self.cache.remove(index).unwrap().1.rgba.len();
            }
            while self.cache.len() >= MAX_ENTRIES || self.bytes + image.rgba.len() > MAX_CACHE_BYTES
            {
                self.bytes -= self.cache.pop_front().unwrap().1.rgba.len();
            }
            self.requested.retain(|pending| *pending != id);
            self.bytes += image.rgba.len();
            self.cache.push_back((id, image));
        }
        // An image response may belong to an earlier change; only the selected ID wins.
        self.state.image = None;
        if let Some(id) = &self.current {
            if let Some(index) = self.cache.iter().position(|(cached, _)| cached == id) {
                let entry = self.cache.remove(index).unwrap();
                self.state.image = Some(entry.1.clone());
                self.cache.push_back(entry);
            } else if !self.requested.contains(id) {
                if self.requested.len() == MAX_ENTRIES {
                    self.requested.pop_front();
                }
                self.requested.push_back(id.clone());
                return Ok(Some(PointerRequest {
                    image_id: Some(id.clone()),
                    ..Default::default()
                }));
            }
        }
        Ok(None)
    }
}

fn decode(hotspot: Option<Point>, bitmap: Option<PointerBitmap>) -> Result<Image, SessionError> {
    let bitmap = bitmap.ok_or(SessionError::InvalidPeerMessage)?;
    let size = bitmap.size.ok_or(SessionError::InvalidPeerMessage)?;
    let hotspot = hotspot.unwrap_or_default();
    let scale = bitmap.scale_factor100.unwrap_or(100);
    let pixels = bitmap.pixels.unwrap_or_default();
    if bitmap.format != Some(1)
        || !(1..=MAX_DIMENSION).contains(&size.width)
        || !(1..=MAX_DIMENSION).contains(&size.height)
        || !(1..=1600).contains(&scale)
        || hotspot.x < 0
        || hotspot.y < 0
        || hotspot.x as u32 >= size.width
        || hotspot.y as u32 >= size.height
        || pixels.len() != size.width as usize * size.height as usize * 4
    {
        return Err(SessionError::InvalidPeerMessage);
    }
    Ok(Image {
        size: [size.width, size.height],
        hotspot: [hotspot.x as u32, hotspot.y as u32],
        scale_factor100: scale,
        rgba: pixels,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn changed(id: &str) -> PointerUpdate {
        PointerUpdate {
            changed: Some(PointerChanged {
                pointer_id: Some(id.into()),
                ..Default::default()
            }),
            ..Default::default()
        }
    }
    fn image(id: &str, size: u32) -> PointerUpdate {
        PointerUpdate {
            image: Some(PointerImage {
                pointer_id: Some(id.into()),
                hotspot: Some(Point { x: 1, y: 0 }),
                image: Some(PointerBitmap {
                    size: Some(Size {
                        width: size,
                        height: size,
                    }),
                    format: Some(1),
                    pixels: Some(vec![127; size as usize * size as usize * 4]),
                    scale_factor100: Some(200),
                }),
            }),
            ..Default::default()
        }
    }
    #[test]
    fn delayed_images_do_not_replace_current_shape_and_cached_ids_need_no_request() {
        let mut tracker = Tracker::default();
        assert_eq!(
            tracker
                .receive(changed("arrow"))
                .unwrap()
                .unwrap()
                .image_id
                .as_deref(),
            Some("arrow")
        );
        assert!(tracker.receive(changed("arrow")).unwrap().is_none());
        tracker.receive(changed("text")).unwrap();
        tracker.receive(image("arrow", 2)).unwrap();
        assert!(tracker.state.image.is_none());
        tracker.receive(image("text", 3)).unwrap();
        assert_eq!(tracker.state.image.as_ref().unwrap().size, [3, 3]);
        assert!(tracker.receive(changed("arrow")).unwrap().is_none());
        let selected = tracker.state.image.as_ref().unwrap();
        assert_eq!(selected.size, [2, 2]);
        assert_eq!(selected.hotspot, [1, 0]);
        assert_eq!(selected.scale_factor100, 200);
        tracker
            .receive(PointerUpdate {
                changed: Some(PointerChanged {
                    visible: Some(false),
                    ..Default::default()
                }),
                ..Default::default()
            })
            .unwrap();
        assert!(!tracker.state.visible);
    }
    #[test]
    fn malformed_images_fail_without_unbounded_dimensions_or_hotspots() {
        for case in 0..8 {
            let mut wire = image("arrow", 2);
            let pointer = wire.image.as_mut().unwrap();
            let bitmap = pointer.image.as_mut().unwrap();
            match case {
                0 => bitmap.size.as_mut().unwrap().width = u32::MAX,
                1 => bitmap.size.as_mut().unwrap().height = 0,
                2 => {
                    bitmap.pixels.as_mut().unwrap().pop();
                }
                3 => pointer.hotspot.as_mut().unwrap().x = -1,
                4 => pointer.hotspot.as_mut().unwrap().y = 2,
                5 => bitmap.scale_factor100 = Some(0),
                6 => bitmap.format = Some(9),
                _ => pointer.pointer_id = Some("x".repeat(1025)),
            }
            assert_eq!(
                Tracker::default().receive(wire),
                Err(SessionError::InvalidPeerMessage)
            );
        }
    }
    #[test]
    fn both_cache_bytes_and_entry_counts_are_bounded() {
        for dimension in [2, 512] {
            let mut tracker = Tracker::default();
            for index in 0..24 {
                let id = index.to_string();
                tracker.receive(changed(&id)).unwrap();
                tracker.receive(image(&id, dimension)).unwrap();
                assert!(tracker.bytes <= MAX_CACHE_BYTES);
                assert!(tracker.cache.len() <= MAX_ENTRIES);
                assert!(tracker.requested.len() <= MAX_ENTRIES);
            }
            assert!(tracker.receive(changed("0")).unwrap().is_some());
        }
    }
}
