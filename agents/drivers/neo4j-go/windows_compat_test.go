package main

import (
	"debug/buildinfo"
	"debug/pe"
	"os"
	"testing"
)

// The release and CI build steps run this against the Windows x64 artifact.
// Testing the host agent alone cannot catch a Windows 7 loader rejection.
func TestWindowsAgentBinaryCompatibility(t *testing.T) {
	path := os.Getenv("DBX_NEO4J_WINDOWS_COMPAT_BINARY")
	if path == "" {
		t.Skip("set DBX_NEO4J_WINDOWS_COMPAT_BINARY to check the Windows release binary")
	}
	info, err := buildinfo.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.GoVersion != "go1.20.14" {
		t.Fatalf("Windows x64 agent must use Go 1.20.14 for Windows 7 compatibility, got %s", info.GoVersion)
	}
	foundDriver := false
	for _, dependency := range info.Deps {
		if dependency.Path == "github.com/neo4j/neo4j-go-driver/v5" && dependency.Version == "v5.28.6" {
			foundDriver = true
		}
		if dependency.Path == "github.com/neo4j/neo4j-go-driver/v6" {
			t.Fatal("Windows x64 agent must not include driver v6, which requires a newer Go runtime")
		}
	}
	if !foundDriver {
		t.Fatal("Windows x64 agent must include the pinned Windows-compatible Neo4j driver")
	}
	binary, err := pe.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer binary.Close()
	if binary.Machine != pe.IMAGE_FILE_MACHINE_AMD64 {
		t.Fatalf("expected a Windows x64 executable, got machine %#x", binary.Machine)
	}
	header, ok := binary.OptionalHeader.(*pe.OptionalHeader64)
	if !ok {
		t.Fatal("expected a PE32+ executable")
	}
	if header.MajorOperatingSystemVersion > 6 || (header.MajorOperatingSystemVersion == 6 && header.MinorOperatingSystemVersion > 1) {
		t.Fatalf("executable requires Windows %d.%d, newer than Windows 7", header.MajorOperatingSystemVersion, header.MinorOperatingSystemVersion)
	}
	if header.MajorSubsystemVersion > 6 || (header.MajorSubsystemVersion == 6 && header.MinorSubsystemVersion > 1) {
		t.Fatalf("executable subsystem requires Windows %d.%d, newer than Windows 7", header.MajorSubsystemVersion, header.MinorSubsystemVersion)
	}
}
