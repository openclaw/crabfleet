package rfb

import (
	"bytes"
	"testing"
)

func TestVNCChallengeResponseMatchesVendoredForkVectors(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name      string
		challenge []byte
		answer    string
		response  []byte
	}{
		{
			name:      "sequential",
			challenge: sequence(16),
			answer:    "12345678",
			response: []byte{
				0x83, 0xdd, 0x2b, 0x4d, 0xbd, 0x04, 0x36, 0x7f,
				0x28, 0x57, 0x8f, 0xdd, 0x5b, 0x14, 0x27, 0x40,
			},
		},
		{
			name:      "all ones short password",
			challenge: bytes.Repeat([]byte{0xff}, 16),
			answer:    "abc",
			response: []byte{
				0xe3, 0x21, 0xa7, 0xec, 0xc5, 0x47, 0xe6, 0x5b,
				0xe3, 0x21, 0xa7, 0xec, 0xc5, 0x47, 0xe6, 0x5b,
			},
		},
		{
			name:      "direct listener token",
			challenge: sequence(16),
			answer:    forkFixturePassword(),
			response: []byte{
				0x8a, 0x5f, 0xa9, 0x58, 0xf0, 0xd8, 0x19, 0xbd,
				0xcb, 0x98, 0x1c, 0x9b, 0x47, 0x63, 0x6e, 0xd0,
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			response, err := VNCChallengeResponse(test.challenge, test.answer)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(response, test.response) {
				t.Fatalf("response = %x, want %x", response, test.response)
			}
			accepted, err := VerifyVNCResponse(test.challenge, response, test.answer)
			if err != nil || !accepted {
				t.Fatalf("verify = %v, %v", accepted, err)
			}
		})
	}
}

func forkFixturePassword() string {
	return "test-" + "auth-" + "token"
}

func TestVNCChallengeResponseRejectsMalformedInput(t *testing.T) {
	t.Parallel()
	if _, err := VNCChallengeResponse(make([]byte, 15), "password"); err == nil {
		t.Fatal("accepted short challenge")
	}
	if _, err := VNCChallengeResponse(make([]byte, 16), "snowman-☃"); err == nil {
		t.Fatal("accepted non-Latin-1 password")
	}
}
