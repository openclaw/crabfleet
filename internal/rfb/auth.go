package rfb

import (
	"crypto/des"
	"crypto/subtle"
	"errors"
	"fmt"
)

func VNCChallengeResponse(challenge []byte, password string) ([]byte, error) {
	if len(challenge) != 16 {
		return nil, errors.New("VNC challenge must be 16 bytes")
	}
	key, err := vncKey(password)
	if err != nil {
		return nil, err
	}
	cipher, err := des.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create VNC DES cipher: %w", err)
	}
	response := make([]byte, len(challenge))
	cipher.Encrypt(response[:8], challenge[:8])
	cipher.Encrypt(response[8:], challenge[8:])
	return response, nil
}

func VerifyVNCResponse(challenge, response []byte, password string) (bool, error) {
	if len(response) != 16 {
		return false, errors.New("VNC response must be 16 bytes")
	}
	expected, err := VNCChallengeResponse(challenge, password)
	if err != nil {
		return false, err
	}
	return subtle.ConstantTimeCompare(expected, response) == 1, nil
}

func vncKey(password string) ([]byte, error) {
	key := make([]byte, 8)
	index := 0
	for _, character := range password {
		if character > 0xff {
			return nil, errors.New("VNC passwords must use ISO-8859-1 characters")
		}
		if index < len(key) {
			key[index] = reverseByte(byte(character))
			index++
		}
	}
	return key, nil
}

func reverseByte(value byte) byte {
	value = (value&0xf0)>>4 | (value&0x0f)<<4
	value = (value&0xcc)>>2 | (value&0x33)<<2
	return (value&0xaa)>>1 | (value&0x55)<<1
}
