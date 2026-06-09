package handler

import (
	"testing"

	pkgcrypto "github.com/byteBuilderX/ClawHermes-AI-Go/pkg/crypto"
)

func TestMaskAPIKey(t *testing.T) {
	cases := []struct {
		input     string
		wantLen   int
		wantEmpty bool
	}{
		{"", 0, true},
		{"abc", 3, false},
		{"sk-abc1234567", 13, false},
		{"sk-" + string(make([]byte, 30)), 32, false}, // capped at 32
	}
	for _, tc := range cases {
		got := maskAPIKey(tc.input)
		if tc.wantEmpty {
			if got != "" {
				t.Errorf("maskAPIKey(%q) = %q, want empty", tc.input, got)
			}
			continue
		}
		// must be all bullet chars
		for _, r := range got {
			if r != '•' {
				t.Errorf("maskAPIKey(%q) = %q contains non-bullet char", tc.input, got)
				break
			}
		}
		if len([]rune(got)) != tc.wantLen {
			t.Errorf("maskAPIKey(%q) len = %d, want %d", tc.input, len([]rune(got)), tc.wantLen)
		}
	}
}

func TestEncryptDecryptSettingsRoundtrip(t *testing.T) {
	key := pkgcrypto.DeriveAESKey("test-jwt-pem")
	original := "sk-realkey123"
	enc, err := pkgcrypto.Encrypt(key, original)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	dec, err := pkgcrypto.Decrypt(key, enc)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if dec != original {
		t.Fatalf("want %q got %q", original, dec)
	}
}
