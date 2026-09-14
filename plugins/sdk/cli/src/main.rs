fn main() {
    if let Err(error) = dbx_plugin_cli::run_cli(std::env::args().skip(1)) {
        dbx_plugin_cli::print_error(&error);
        std::process::exit(1);
    }
}
