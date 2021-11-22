#![cfg_attr(
  all(not(debug_assertions), target_os = "windows"),
  windows_subsystem = "windows"
)]

use tauri::{
  api::process::{Command, CommandEvent},
  Manager,
};
/*
use std::{
  process::Stdio,
  io::{BufReader, BufRead, Result, Write},
  thread
};
*/

fn main() {
  tauri::Builder::default()
    .setup(|app| {
      let window = app.get_window("main").unwrap();
      tauri::async_runtime::spawn(async move {
        let (mut rx, mut child) = Command::new_sidecar("node")
          // TODO: go back to using `pkg` to package the node.js code as v8 bytecode for startup performance and hiding source
          .expect("failed to setup `node` sidecar")
          .args(&["binaries/dist/main.js"])
          .spawn()
          .expect("Failed to spawn packaged node");

        let mut i = 0;

        while let Some(event) = rx.recv().await {
          match event {
            CommandEvent::Stdout(line) => {
              println!("stdout! '{}'", line);
              window
                .emit("message", Some(format!("'{}'", line)))
                .expect("failed to emit event");
              i += 1;
              if i == 4 {
                child.write("message from Rust\n".as_bytes()).unwrap();
                i = 0;
              }
            }
            CommandEvent::Stderr(line) => {
              println!("stderr! '{}'", line);
              window
                .emit("message", Some(format!("ERROR: '{}'", line)))
                .expect("failed to emit event");
            }
            CommandEvent::Terminated(payload) => {
              println!("terminated! '{:?}'", payload);
              window
                .emit("message", Some("sidecar terminated!"))
                .expect("failed to emit event");
            }
            _ => {
              println!("unknown!");
              window
                .emit("message", Some("unknown event"))
                .expect("failed to emit event");
            }
          }
        }
      });

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

