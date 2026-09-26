package com.dbx.agent.kafka;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.net.spi.InetAddressResolver;
import java.net.spi.InetAddressResolverProvider;
import java.util.Objects;
import java.util.stream.Stream;

public final class DbxInetAddressResolverProvider extends InetAddressResolverProvider {
    private static volatile boolean avoidReverseDns;

    @Override
    public InetAddressResolver get(Configuration configuration) {
        return wrapping(configuration.builtinResolver());
    }

    @Override
    public String name() {
        return "dbx-kafka";
    }

    static boolean setAvoidReverseDns(boolean avoid) {
        boolean previous = avoidReverseDns;
        avoidReverseDns = avoid;
        return previous;
    }

    static InetAddressResolver wrapping(InetAddressResolver delegate) {
        Objects.requireNonNull(delegate, "delegate");
        return new InetAddressResolver() {
            @Override
            public Stream<InetAddress> lookupByName(String host, LookupPolicy lookupPolicy)
                throws UnknownHostException {
                return delegate.lookupByName(host, lookupPolicy);
            }

            @Override
            public String lookupByAddress(byte[] address) throws UnknownHostException {
                if (!avoidReverseDns) {
                    return delegate.lookupByAddress(address);
                }
                Objects.requireNonNull(address, "address");
                if (address.length != 4 && address.length != 16) {
                    throw new IllegalArgumentException("Invalid address length");
                }
                return InetAddress.getByAddress(address).getHostAddress();
            }
        };
    }
}
