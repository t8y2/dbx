//go:build neo4j_legacy_windows

package main

// Go 1.20 predates the built-in min function.
func min(left, right int) int {
	if left < right {
		return left
	}
	return right
}
