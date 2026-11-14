package main

import (
	"testing"
	"time"
)

func TestParseBaseAndLocal(t *testing.T) {
	for _, raw := range []string{"https://dev.example.net", "http://127.0.0.1:8787"} {
		if _, err := parseBase(raw); err != nil {
			t.Errorf("parseBase(%q): %v", raw, err)
		}
	}
	for _, raw := range []string{"dev.example.net", "ftp://dev.example.net", "https://user@dev.example.net", "https://dev.example.net/?token=x"} {
		if _, err := parseBase(raw); err == nil {
			t.Errorf("parseBase(%q) should fail", raw)
		}
	}
	local, err := parseLocal("", 4321)
	if err != nil {
		t.Fatal(err)
	}
	if local.String() != "http://127.0.0.1:4321" {
		t.Fatalf("local default = %s", local)
	}
	if _, err := parseLocal("http://127.0.0.1:99999", 3000); err == nil {
		t.Fatal("accepted invalid local port")
	}
}

func TestValidateTTLMatchesWorkerBounds(t *testing.T) {
	for _, ttl := range []time.Duration{time.Minute, 24 * time.Hour} {
		if err := validateTTL(ttl); err != nil {
			t.Errorf("validateTTL(%s): %v", ttl, err)
		}
	}
	for _, ttl := range []time.Duration{time.Second, time.Minute - time.Second, 24*time.Hour + time.Second} {
		if err := validateTTL(ttl); err == nil {
			t.Errorf("validateTTL(%s) should fail", ttl)
		}
	}
}

func TestDefaultSessionPathIsOutsideWorkingTree(t *testing.T) {
	path := defaultSessionPath()
	if path == ".tunnelworker/session.json" {
		t.Fatal("default credentials would be written in repository")
	}
}
