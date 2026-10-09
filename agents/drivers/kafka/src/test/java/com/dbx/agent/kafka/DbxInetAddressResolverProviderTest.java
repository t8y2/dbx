package com.dbx.agent.kafka;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.net.spi.InetAddressResolver;
import java.net.spi.InetAddressResolverProvider;
import java.util.ServiceLoader;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DbxInetAddressResolverProviderTest {
    @Test
    void providerIsPublishedAsTheKafkaAgentResolverService() {
        assertTrue(ServiceLoader.load(InetAddressResolverProvider.class).stream()
            .anyMatch(provider -> provider.type() == DbxInetAddressResolverProvider.class));
    }

    @Test
    void installedProviderShortCircuitsTheInetAddressCallUsedByKafka() throws Exception {
        boolean previous = DbxInetAddressResolverProvider.setAvoidReverseDns(true);
        try {
            InetAddress numericAddress = InetAddress.getByAddress(new byte[] { 127, 0, 0, 1 });

            assertEquals("127.0.0.1", numericAddress.getHostName());
        } finally {
            DbxInetAddressResolverProvider.setAvoidReverseDns(previous);
        }
    }

    @Test
    void nonKerberosSaslReturnsNumericAddressWithoutCallingReverseDns() throws Exception {
        AtomicInteger reverseLookups = new AtomicInteger();
        InetAddressResolver resolver = DbxInetAddressResolverProvider.wrapping(
            resolverReturning("broker.example.test", reverseLookups)
        );
        boolean previous = DbxInetAddressResolverProvider.setAvoidReverseDns(true);
        try {
            assertEquals("192.0.2.25", resolver.lookupByAddress(new byte[] {
                (byte) 192, 0, 2, 25
            }));
            assertEquals(0, reverseLookups.get());
        } finally {
            DbxInetAddressResolverProvider.setAvoidReverseDns(previous);
        }
    }

    @Test
    void kerberosModeKeepsPlatformReverseDnsBehavior() throws Exception {
        AtomicInteger reverseLookups = new AtomicInteger();
        InetAddressResolver resolver = DbxInetAddressResolverProvider.wrapping(
            resolverReturning("broker.example.test", reverseLookups)
        );
        boolean previous = DbxInetAddressResolverProvider.setAvoidReverseDns(false);
        try {
            assertEquals("broker.example.test", resolver.lookupByAddress(new byte[] {
                (byte) 192, 0, 2, 25
            }));
            assertEquals(1, reverseLookups.get());
        } finally {
            DbxInetAddressResolverProvider.setAvoidReverseDns(previous);
        }
    }

    @Test
    void platformReverseDnsFailuresRemainVisibleWhenBypassIsDisabled() {
        InetAddressResolver delegate = new InetAddressResolver() {
            @Override
            public Stream<InetAddress> lookupByName(String host, LookupPolicy lookupPolicy) {
                throw new AssertionError("forward lookup was not expected");
            }

            @Override
            public String lookupByAddress(byte[] address) throws UnknownHostException {
                throw new UnknownHostException("PTR lookup failed");
            }
        };
        InetAddressResolver resolver = DbxInetAddressResolverProvider.wrapping(delegate);
        boolean previous = DbxInetAddressResolverProvider.setAvoidReverseDns(false);
        try {
            UnknownHostException error = assertThrows(UnknownHostException.class,
                () -> resolver.lookupByAddress(new byte[] { (byte) 192, 0, 2, 25 }));
            assertEquals("PTR lookup failed", error.getMessage());
        } finally {
            DbxInetAddressResolverProvider.setAvoidReverseDns(previous);
        }
    }

    @Test
    void hostnameLookupAlwaysUsesThePlatformResolver() throws Exception {
        AtomicInteger forwardLookups = new AtomicInteger();
        InetAddressResolver delegate = new InetAddressResolver() {
            @Override
            public Stream<InetAddress> lookupByName(String host, LookupPolicy lookupPolicy)
                throws UnknownHostException {
                forwardLookups.incrementAndGet();
                return Stream.of(InetAddress.getByAddress(host, new byte[] { 127, 0, 0, 1 }));
            }

            @Override
            public String lookupByAddress(byte[] address) {
                throw new AssertionError("reverse lookup was not expected");
            }
        };
        InetAddressResolver resolver = DbxInetAddressResolverProvider.wrapping(delegate);
        boolean previous = DbxInetAddressResolverProvider.setAvoidReverseDns(true);
        try {
            InetAddress resolved = resolver
                .lookupByName("broker.example.test", InetAddressResolver.LookupPolicy.of(
                    InetAddressResolver.LookupPolicy.IPV4
                ))
                .findFirst()
                .orElseThrow();
            assertEquals("broker.example.test", resolved.getHostName());
            assertEquals(1, forwardLookups.get());
        } finally {
            DbxInetAddressResolverProvider.setAvoidReverseDns(previous);
        }
    }

    private static InetAddressResolver resolverReturning(String reverseResult, AtomicInteger reverseLookups) {
        return new InetAddressResolver() {
            @Override
            public Stream<InetAddress> lookupByName(String host, LookupPolicy lookupPolicy) {
                throw new AssertionError("forward lookup was not expected");
            }

            @Override
            public String lookupByAddress(byte[] address) {
                reverseLookups.incrementAndGet();
                return reverseResult;
            }
        };
    }
}
