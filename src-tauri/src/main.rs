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
        let (mut rx, mut child) = Command::new_sidecar("app")
          .expect("failed to setup `app` sidecar")
          /*
          .stdin(Stdio::piped())
          .expect("failed to pipe stdin")
          .stdout(Stdio::piped())
          .expect("failed to pipe stdout")
          */
          .spawn()
          .expect("Failed to spawn packaged node");

        let mut i = 0;

        /*
        let stdout = child.inner.take_stdout().expect("piped stderr should never fail");
        let stdin = child.inner.take_stdin().expect("piped stdin should never fail");

        thread::spawn(move || {
          for line in BufReader::new(stdout).lines() {

          }
        })
        */

        while let Some(event) = rx.recv().await {
          match event {
            CommandEvent::Stdout(line) => {
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
              window
                .emit("message", Some(format!("ERROR: '{}'", line)))
                .expect("failed to emit event");
            }
            _ => {
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

