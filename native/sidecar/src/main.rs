mod iso;
mod protocol;
mod pty;
mod scheduler;
mod shell;

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> anyhow::Result<()> {
    scheduler::run().await
}
