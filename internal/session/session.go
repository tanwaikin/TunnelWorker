package session

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Session contains the connector credential, so it must only be persisted with
// owner-only permissions. It is intentionally local and never printed.
type Session struct {
	ID             string `json:"id"`
	BaseURL        string `json:"baseUrl"`
	LocalURL       string `json:"localUrl"`
	VisitorURL     string `json:"visitorUrl,omitempty"`
	ConnectorToken string `json:"connectorToken"`
	ExpiresAt      int64  `json:"expiresAt,omitempty"`
}

func Save(path string, s Session) error {
	if s.ID == "" || s.ConnectorToken == "" {
		return errors.New("session is missing tunnel credentials")
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	tmp, err := os.CreateTemp(dir, ".session-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	return nil
}

func Load(path string) (Session, error) {
	var s Session
	info, err := os.Stat(path)
	if err != nil {
		return s, err
	}
	if info.Mode().Perm()&0077 != 0 {
		return s, fmt.Errorf("session file %q has unsafe permissions %04o; chmod 600 it", path, info.Mode().Perm())
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal(b, &s); err != nil {
		return s, err
	}
	if s.ID == "" || s.ConnectorToken == "" {
		return s, errors.New("session file does not contain tunnel credentials")
	}
	return s, nil
}
