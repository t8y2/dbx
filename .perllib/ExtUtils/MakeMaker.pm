package ExtUtils::MakeMaker;
use strict;
use warnings;

our $VERSION = '7.70';

# Minimal stub for IPC::Cmd::can_run, which does:
#   require ExtUtils::MakeMaker;
#   my $abs = File::Spec->rel2abs($cmd);
#   return $abs if MM->maybe_command($abs);
sub maybe_command {
    my ($self, $file) = @_;
    return undef unless defined $file && length $file;
    return undef unless -e $file;
    return undef if -d _;
    return $file;
}

package MM;

our @ISA = ('ExtUtils::MakeMaker');

package ExtUtils::MakeMaker;

1;
