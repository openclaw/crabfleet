use crate::{Frame, Input};

pub const WIDTH: u16 = 800;
pub const HEIGHT: u16 = 450;

#[derive(Default)]
pub struct Desktop {
    pub input_count: u32,
    pub pointer: [u16; 2],
    pub buttons: u8,
    pub key_down: bool,
    pub typed: String,
}

impl Desktop {
    pub fn input(&mut self, input: Input) {
        self.input_count = self.input_count.wrapping_add(1);
        match input {
            Input::Pointer { x, y, buttons } => {
                self.pointer = [x.min(WIDTH - 1), y.min(HEIGHT - 1)];
                self.buttons = buttons;
            }
            Input::Key { down, .. } => self.key_down = down,
            Input::Text(text) => {
                // The synthetic display keeps only a short, non-sensitive test string.
                self.typed.extend(text.chars().take(32));
                self.typed = self
                    .typed
                    .chars()
                    .rev()
                    .take(32)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect();
            }
            Input::ReleaseAll => {
                self.buttons = 0;
                self.key_down = false;
            }
            Input::Scroll { .. } => {}
        }
    }
    pub fn frame(&self, sequence: u64) -> Frame {
        let mut rgba = vec![0u8; WIDTH as usize * HEIGHT as usize * 4];
        let phase = (sequence % WIDTH as u64) as u16;
        for y in 0..HEIGHT {
            for x in 0..WIDTH {
                let index = (y as usize * WIDTH as usize + x as usize) * 4;
                let grid = x % 50 == 0 || y % 50 == 0;
                let mut color = if grid {
                    [29, 53, 57]
                } else {
                    [
                        12 + (y / 30) as u8,
                        27 + (x / 60) as u8,
                        35 + (y / 40) as u8,
                    ]
                };
                if x.abs_diff(phase) < 2 {
                    color = [94, 225, 184];
                }
                if (270..=530).contains(&x) && (150..=300).contains(&y) {
                    let block = ((x - 270) / 43) as usize;
                    color = [
                        [96, 225, 184],
                        [79, 167, 206],
                        [222, 190, 111],
                        [213, 127, 115],
                        [155, 149, 203],
                        [227, 232, 223],
                    ][block.min(5)];
                    if y > 230 {
                        color = color.map(|value| value / 2);
                    }
                }
                if x.abs_diff(self.pointer[0]) < 2 && y.abs_diff(self.pointer[1]) < 15
                    || y.abs_diff(self.pointer[1]) < 2 && x.abs_diff(self.pointer[0]) < 15
                {
                    color = if self.buttons != 0 {
                        [250, 151, 86]
                    } else {
                        [248, 250, 244]
                    };
                }
                if (18..60).contains(&x) && (HEIGHT - 60..HEIGHT - 18).contains(&y) {
                    color = if self.key_down {
                        [94, 225, 184]
                    } else {
                        [49, 69, 77]
                    };
                }
                rgba[index..index + 4].copy_from_slice(&[color[0], color[1], color[2], 255]);
            }
        }
        Frame {
            width: WIDTH,
            height: HEIGHT,
            sequence,
            input_count: self.input_count,
            rgba,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn release_all_clears_pressed_inputs_and_frame_acknowledges_events() {
        let mut desktop = Desktop::default();
        desktop.input(Input::Pointer {
            x: u16::MAX,
            y: u16::MAX,
            buttons: 1,
        });
        desktop.input(Input::Key {
            code: 13,
            down: true,
        });
        assert_eq!(desktop.pointer, [WIDTH - 1, HEIGHT - 1]);
        desktop.input(Input::ReleaseAll);
        assert!(!desktop.key_down);
        assert_eq!(desktop.buttons, 0);
        assert_eq!(desktop.frame(1).input_count, 3);
    }
}
