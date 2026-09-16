package com.dbx.agent.kafka;

import java.net.Socket;
import java.security.KeyStore;
import java.security.Provider;
import java.security.Security;
import java.security.cert.X509Certificate;
import javax.net.ssl.ManagerFactoryParameters;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactorySpi;
import javax.net.ssl.X509ExtendedTrustManager;

/** Trust manager used only when a Kafka connection explicitly skips TLS verification. */
public final class DbxInsecureTrustManagerFactory {
    static final String ALGORITHM = "DBX_TRUST_ALL";
    private static final String PROVIDER_NAME = "DBX_KAFKA_INSECURE_TLS";

    private DbxInsecureTrustManagerFactory() {}

    static void ensureRegistered() {
        if (Security.getProvider(PROVIDER_NAME) != null) return;
        synchronized (DbxInsecureTrustManagerFactory.class) {
            if (Security.getProvider(PROVIDER_NAME) != null) return;
            Provider provider = new Provider(PROVIDER_NAME, "1.0", "DBX Kafka trust-all provider") {};
            provider.put("TrustManagerFactory." + ALGORITHM, Spi.class.getName());
            Security.addProvider(provider);
        }
    }

    public static final class Spi extends TrustManagerFactorySpi {
        private static final TrustManager[] TRUST_MANAGERS = { new TrustAllManager() };

        @Override
        protected void engineInit(KeyStore keyStore) {}

        @Override
        protected void engineInit(ManagerFactoryParameters managerFactoryParameters) {}

        @Override
        protected TrustManager[] engineGetTrustManagers() {
            return TRUST_MANAGERS.clone();
        }
    }

    private static final class TrustAllManager extends X509ExtendedTrustManager {
        private static final X509Certificate[] NO_ISSUERS = new X509Certificate[0];

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) {}

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) {}

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType, Socket socket) {}

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType, Socket socket) {}

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType, SSLEngine engine) {}

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType, SSLEngine engine) {}

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            return NO_ISSUERS.clone();
        }
    }
}
