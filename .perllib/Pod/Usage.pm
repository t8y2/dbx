package Pod::Usage;
use strict;
use warnings;

our $VERSION = '2.03';

sub import {
    my $caller = caller;
    {
        no strict 'refs';
        no warnings 'redefine';
        *{"${caller}::pod2usage"} = \&pod2usage;
    }
    return 1;
}

# Minimal stub used by OpenSSL's generated configdata.pm. Only invoked for
# --help style flows; a normal Configure run never calls it.
sub pod2usage {
    my $args = shift;
    my %opts;
    if (ref $args eq 'HASH') {
        %opts = %$args;
    } elsif (defined $args) {
        %opts = (exitval => $args);
    }
    my $exit = defined $opts{exitval} ? $opts{exitval} : 1;
    if (defined $opts{message}) {
        my $message = $opts{message};
        $message .= "\n" unless $message =~ /\n\z/;
        print STDERR $message;
    }
    exit $exit;
}

1;
