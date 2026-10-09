#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
    if (argc != 2) return 1;
    if (SecKeychainSetUserInteractionAllowed(false) != errSecSuccess) return 4;
    SecKeychainRef keychain = NULL;
    OSStatus status = SecKeychainOpen(argv[1], &keychain);
    if (status != errSecSuccess) return 2;
    const char *service = "com.dbx.tests.development-signing";
    const char *account = "fixture";
    const char *expected = "fixture-only-value";
    UInt32 length = 0;
    void *password = NULL;
    status = SecKeychainFindGenericPassword(keychain, (UInt32)strlen(service), service,
        (UInt32)strlen(account), account, &length, &password, NULL);
    if (status == errSecItemNotFound) {
        status = SecKeychainAddGenericPassword(keychain, (UInt32)strlen(service), service,
            (UInt32)strlen(account), account, (UInt32)strlen(expected), expected, NULL);
    } else if (status == errSecSuccess) {
        if (length != strlen(expected) || memcmp(password, expected, length) != 0) status = errSecDecode;
        SecKeychainItemFreeContent(NULL, password);
    }
    CFRelease(keychain);
    printf("build=%d status=%d\n", DBX_PROBE_VERSION, (int)status);
    return status == errSecSuccess ? 0 : 3;
}
