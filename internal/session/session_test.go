package session

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSaveLoadKeepsCredentialsPrivate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config", "session.json")
	const id = "0123456789abcdef0123456789abcdef0123"
	want := Session{ID: id, BaseURL: "http://127.0.0.1:8787", LocalURL: "http://127.0.0.1:3000", VisitorURL: "https://" + id + "-tunnel.example.test", ConnectorToken: "secret-token", ExpiresAt: 1730000000000}
	if err := Save(path, want); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0600 {
		t.Fatalf("session permissions = %04o, want 0600", got)
	}
	got, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("loaded session = %#v, want %#v", got, want)
	}
}

func TestLoadRejectsInsecurePermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.json")
	if err := os.WriteFile(path, []byte(`{"id":"abc","connectorToken":"secret"}`), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("Load accepted a session readable by other users")
	}
}
