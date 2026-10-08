use strict;
use warnings;

print "PERL5LIB=[$ENV{PERL5LIB}]\n";

for my $m ('Params::Check', 'Locale::Maketext::Simple', 'ExtUtils::MakeMaker', 'Pod::Usage', 'IPC::Cmd') {
    (my $pm = $m) =~ s{::}{/}g;
    $pm .= '.pm';
    my $ok = eval { require $pm; 1 };
    if ($ok) {
        print "OK      $m -> $INC{$pm}\n";
    } else {
        print "MISSING $m ($@)\n";
    }
}
