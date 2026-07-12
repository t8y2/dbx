package com.dbx.agent.access;

import io.github.spannm.jackcess.Database;
import io.github.spannm.jackcess.DatabaseBuilder;
import io.github.spannm.jackcess.encrypt.CryptCodecProvider;
import java.io.File;
import java.io.IOException;
import net.ucanaccess.jdbc.IJackcessOpenerInterface;

public final class EncryptedAccessOpener implements IJackcessOpenerInterface {
    @Override
    public Database open(File file, String password) throws IOException {
        DatabaseBuilder builder = new DatabaseBuilder(file);
        // UCanAccess flushes changes at transaction boundaries, so Jackcess auto-sync is unnecessary overhead.
        builder.withAutoSync(false);
        builder.withCodecProvider(new CryptCodecProvider(password));
        builder.withReadOnly(false);
        return builder.open();
    }
}
