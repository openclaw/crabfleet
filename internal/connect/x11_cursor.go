package connect

import "errors"

func cursorFromXFixes(
	x, y, width, height, hotspotX, hotspotY int,
	pixels []uint32,
	frameWidth, frameHeight int,
) (Cursor, error) {
	if width < 1 || width > 128 || height < 1 || height > 128 ||
		hotspotX < 0 || hotspotX >= width || hotspotY < 0 || hotspotY >= height ||
		len(pixels) != width*height || frameWidth < 1 || frameHeight < 1 {
		return Cursor{}, errors.New("XFixes returned invalid cursor geometry")
	}
	rgba := make([]byte, len(pixels)*4)
	visible := false
	for index, pixel := range pixels {
		alpha := byte(pixel >> 24)
		red := min(byte(pixel>>16), alpha)
		green := min(byte(pixel>>8), alpha)
		blue := min(byte(pixel), alpha)
		offset := index * 4
		rgba[offset] = red
		rgba[offset+1] = green
		rgba[offset+2] = blue
		rgba[offset+3] = alpha
		visible = visible || alpha != 0
	}
	if !visible {
		return Cursor{Visible: false}, nil
	}
	return Cursor{
		Width:    width,
		Height:   height,
		HotspotX: hotspotX,
		HotspotY: hotspotY,
		X:        max(0, min(x, frameWidth-1)),
		Y:        max(0, min(y, frameHeight-1)),
		Visible:  true,
		RGBA:     rgba,
	}, nil
}
