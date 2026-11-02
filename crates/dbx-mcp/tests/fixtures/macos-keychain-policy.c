#include <Security/Security.h>
#include <stdio.h>
#include <stdlib.h>

static void record(const char *operation) {
    Boolean allowed = true;
    SecKeychainGetUserInteractionAllowed(&allowed);
    const char *path = getenv("DBX_TEST_KEYCHAIN_POLICY_LOG");
    FILE *log = path ? fopen(path, "a") : NULL;
    if (log) {
        fprintf(log, "%s interaction=%d\n", operation, (int)allowed);
        fclose(log);
    }
}

static OSStatus denied_read(CFTypeRef keychain, UInt32 service_len, const char *service,
    UInt32 account_len, const char *account, UInt32 *length, void **password, SecKeychainItemRef *item) {
    record("read");
    return errSecInteractionNotAllowed;
}

static OSStatus denied_lookup(SecPreferencesDomain domain, SecKeychainRef *keychain) {
    record("lookup");
    return errSecInteractionNotAllowed;
}

static OSStatus denied_add(SecKeychainRef keychain, UInt32 service_len, const char *service,
    UInt32 account_len, const char *account, UInt32 length, const void *password, SecKeychainItemRef *item) {
    record("write");
    return errSecInteractionNotAllowed;
}

static OSStatus denied_modify(SecKeychainItemRef item, const SecKeychainAttributeList *attributes,
    UInt32 length, const void *password) {
    record("write");
    return errSecInteractionNotAllowed;
}

// Interpose only inside the test child; no real credential reads or writes reach Security.framework.
#define INTERPOSE(replacement, original) \
    __attribute__((used)) static struct { const void *new_function; const void *old_function; } \
    interpose_##original __attribute__((section("__DATA,__interpose"))) = \
    { (const void *)(replacement), (const void *)(original) }

INTERPOSE(denied_read, SecKeychainFindGenericPassword);
INTERPOSE(denied_lookup, SecKeychainCopyDomainDefault);
INTERPOSE(denied_add, SecKeychainAddGenericPassword);
INTERPOSE(denied_modify, SecKeychainItemModifyAttributesAndData);
