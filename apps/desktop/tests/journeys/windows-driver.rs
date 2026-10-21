use std::{env, process::Command};

fn main() {
    let status = Command::new(env::var_os("JOURNEY_EDGE_DRIVER").expect("Edge driver path"))
        .args(env::args_os().skip(1))
        .arg("--verbose")
        .arg(format!(
            "--log-path={}/desktop-journeys/evidence/msedgedriver.log",
            env::var("RUNNER_TEMP").expect("runner temporary directory")
        ))
        .status()
        .expect("start Edge driver");
    std::process::exit(status.code().unwrap_or(1));
}
