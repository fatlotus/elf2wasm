pub use elf2wasm_core::{decoder, elf_loader, lifter, meta, wasm_emit};
pub mod runtime;
pub mod syscalls;
pub mod vfs;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process;

#[derive(Parser)]
#[command(name = "elf2wasm", about = "Translate Linux x86-64 ELF binaries to sandboxed WASM")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Translate an ELF64 binary and its shared libraries into a .wasm module
    Translate {
        /// Path to the main ELF64 executable
        elf: PathBuf,
        /// Shared library (.so) paths to bundle (repeatable)
        #[arg(long = "so")]
        so_paths: Vec<PathBuf>,
        /// Output .wasm file path
        #[arg(short = 'o', long = "output")]
        output: PathBuf,
    },
    /// Run a translated .wasm module in the sandboxed runtime
    Run {
        /// Path to the translated .wasm file
        wasm: PathBuf,
        /// Read-only VFS mount in host:guest format (repeatable)
        #[arg(long = "vfs-ro")]
        vfs_ro: Vec<String>,
        /// Arguments passed to the guest program (after --)
        #[arg(last = true)]
        args: Vec<String>,
    },
}

fn parse_vfs_ro(spec: &str) -> Result<(PathBuf, String)> {
    let Some((host, guest)) = spec.split_once(':') else {
        bail!("Invalid --vfs-ro specification '{}': expected <host:guest>", spec);
    };
    if host.is_empty() || guest.is_empty() {
        bail!("Invalid --vfs-ro specification '{}': empty host or guest path", spec);
    }
    let host_path = std::fs::canonicalize(host).with_context(|| {
        format!(
            "Invalid --vfs-ro host path '{}': does not exist or cannot be resolved",
            host
        )
    })?;
    Ok((host_path, guest.to_string()))
}


fn run_cli() -> Result<i32> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Translate {
            elf,
            so_paths,
            output,
        } => {
            let image = elf_loader::load_elf_and_sos(&elf, &so_paths)?;
            let mut prog = decoder::discover_code(&image)?;
            decoder::split_indirect_targets(&image, &mut prog);
            let wasm_bytes = wasm_emit::emit_wasm(&image, &prog)?;
            fs::write(&output, &wasm_bytes)
                .with_context(|| format!("Failed to write {}", output.display()))?;
            let _ = runtime::prewarm_cwasm_cache(&wasm_bytes);
            Ok(0)
        }
        Commands::Run { wasm, vfs_ro, args } => {
            let wasm_bytes =
                fs::read(&wasm).with_context(|| format!("Failed to read {}", wasm.display()))?;
            let mut mounts = Vec::with_capacity(vfs_ro.len());
            for spec in &vfs_ro {
                mounts.push(parse_vfs_ro(spec)?);
            }
            let prog_name = runtime::extract_elf2wasm_meta(&wasm_bytes)
                .ok()
                .map(|m| m.elf_path)
                .filter(|p| !p.is_empty())
                .unwrap_or_else(|| {
                    wasm.file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("app")
                        .to_string()
                });
            let mut full_args = Vec::with_capacity(1 + args.len());
            full_args.push(prog_name);
            full_args.extend(args);

            let out = runtime::run_wasm(
                &wasm_bytes,
                runtime::RunConfig {
                    args: full_args,
                    env: vec!["PATH=/usr/local/bin:/usr/bin:/bin".to_string()],
                    vfs_ro: mounts,
                    stdin: Vec::new(),
                    inherit_stdin: true,
                },
            )?;

            std::io::stdout().write_all(&out.stdout)?;
            std::io::stderr().write_all(&out.stderr)?;
            std::io::stdout().flush()?;
            std::io::stderr().flush()?;
            Ok(out.exit_code)
        }
    }
}

fn main() {
    match run_cli() {
        Ok(code) => process::exit(code),
        Err(e) => {
            eprintln!("elf2wasm error: {:#}", e);
            process::exit(1);
        }
    }
}
