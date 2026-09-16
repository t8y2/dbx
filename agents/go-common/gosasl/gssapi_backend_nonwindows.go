//go:build !windows

package gosasl

func newPlatformGSSAPIBackend() (gssapiBackend, error) {
	return newPureGoGSSAPIBackend(gssapiOptionsFromEnvironment())
}

func newPlatformGSSAPIBackendWithOptions(options GSSAPIOptions) (gssapiBackend, error) {
	return newPureGoGSSAPIBackend(options)
}
