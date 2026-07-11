mod iso;
mod protocol;
mod pty;
mod scheduler;
mod session_control_pipe;
#[cfg(windows)]
mod session_control_pipe_windows;
mod shell;
mod shell_cancellation;

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> anyhow::Result<()> {
    if session_control_pipe::proxy_mode_requested(std::env::args().skip(1))? {
        return session_control_pipe::run_proxy().await;
    }
    scheduler::run().await
}
