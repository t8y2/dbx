package Locale::Maketext::Simple;
use strict;
use warnings;

our $VERSION = '0.21';

sub import {
    my $class = shift;
    my %args  = @_;

    my $export = 'loc';
    $export = $args{Export} if defined $args{Export} && length $args{Export};

    my $caller = caller;
    my $loc = sub {
        my $phrase = shift;
        return $phrase unless defined $phrase;
        return $phrase unless @_;
        my @params = @_;
        $phrase =~ s/%(\d+)/defined $params[ $1 - 1 ] ? $params[ $1 - 1 ] : "%$1"/ge;
        return $phrase;
    };

    {
        no strict 'refs';
        no warnings 'redefine';
        *{"${caller}::${export}"} = $loc;
    }
    return 1;
}

1;
